// API Gateway (REST) replacement. Loads the terraform-derived routes.json,
// verifies OIDC bearer tokens (Keycloak), synthesizes API-Gateway-proxy events,
// and invokes the upstream lambda handlers in-process.
//
// Env:
//   PORT                 listen port (default 3001)
//   LAMBDA_ROOT          path to upstream/collab/lambda (default: ../../upstream/collab/lambda)
//   OIDC_ISSUER          e.g. http://keycloak:8080/realms/jf-ai-dlc — required unless AUTH_DISABLED
//   OIDC_AUDIENCE        optional expected audience
//   AUTH_DISABLED=true   accept unauthenticated requests with stub claims (tests only)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const here = path.dirname(fileURLToPath(import.meta.url));
const lambdaRoot = path.resolve(process.env.LAMBDA_ROOT || path.join(here, '../../upstream/collab/lambda'));
const routes = JSON.parse(readFileSync(path.join(here, 'routes.json'), 'utf8'));

const CORS_HEADERS = {
  'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
  'access-control-allow-headers': 'Content-Type,Authorization,X-Amz-Date,X-Api-Key',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

// --- route matching ---------------------------------------------------------
const compiled = routes.map((r) => ({
  ...r,
  segments: r.resource.split('/').filter(Boolean).map((s) => {
    const param = s.match(/^\{(\w+)\}$/);
    return param ? { param: param[1] } : { literal: s };
  }),
}));

const matchRoute = (method, pathname) => {
  const parts = pathname.split('/').filter(Boolean);
  let best = null; // most-specific match wins (literal segments beat params),
  let bestScore = -1; // e.g. GET /intents/metrics must beat /intents/{intentId}
  outer: for (const route of compiled) {
    if (route.method !== method && !(method === 'OPTIONS' && route.type === 'mock')) continue;
    if (route.segments.length !== parts.length) continue;
    const pathParameters = {};
    let literals = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = route.segments[i];
      if (seg.literal !== undefined) {
        if (seg.literal !== parts[i]) continue outer;
        literals += 1;
      } else {
        pathParameters[seg.param] = decodeURIComponent(parts[i]);
      }
    }
    if (literals > bestScore) {
      best = { route, pathParameters };
      bestScore = literals;
    }
  }
  if (best) return best;
  // OPTIONS preflight for any known path (upstream fronted everything with CORS modules)
  if (method === 'OPTIONS') return { route: { type: 'mock', auth: false }, pathParameters: {} };
  return null;
};

// --- auth (Cognito authorizer → Keycloak OIDC) ------------------------------
// Claims mapping documented in README "Local adjustments": Keycloak standard
// claims are projected onto the Cognito claim names the handlers read.
const authDisabled = process.env.AUTH_DISABLED === 'true';
let jwks;
const verifyToken = async (token) => {
  if (!jwks) {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) throw new Error('OIDC_ISSUER is not configured');
    // OIDC_JWKS_URL: in-network fetch URL when the public issuer host (what
    // tokens carry in `iss`) isn't resolvable from inside the stack
    const jwksUrl =
      process.env.OIDC_JWKS_URL || `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`;
    jwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: process.env.OIDC_ISSUER,
    audience: process.env.OIDC_AUDIENCE || undefined,
  });
  return payload;
};

const toCognitoClaims = (payload) => ({
  sub: payload.sub,
  email: payload.email || '',
  'cognito:username': payload.preferred_username || payload.sub,
  'cognito:groups': (payload.groups || payload.realm_access?.roles || []).join(','),
  'custom:display_name': payload.name || payload.preferred_username || '',
  ...payload,
});

// --- handler loading --------------------------------------------------------
const handlers = new Map();
const getHandler = async (lambda) => {
  if (!handlers.has(lambda)) {
    handlers.set(
      lambda,
      import(path.join(lambdaRoot, lambda, 'index.js')).then((m) => {
        if (typeof m.handler !== 'function') throw new Error(`lambda ${lambda} exports no handler`);
        return m.handler;
      }),
    );
  }
  return handlers.get(lambda);
};

// --- server -----------------------------------------------------------------
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const respond = (res, statusCode, headers, body) => {
  res.writeHead(statusCode, { ...CORS_HEADERS, ...headers });
  res.end(body ?? '');
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return respond(res, 200, {}, 'ok');

    const match = matchRoute(req.method, url.pathname);
    if (!match) return respond(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Not Found' }));
    const { route, pathParameters } = match;

    if (route.type === 'mock') return respond(res, 200, {}, '');

    let claims;
    if (route.auth) {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (authDisabled) {
        claims = {
          sub: req.headers['x-test-sub'] || 'test-user',
          email: req.headers['x-test-email'] || 'test@example.com',
          'cognito:username': req.headers['x-test-sub'] || 'test-user',
          'cognito:groups': req.headers['x-test-groups'] || '',
          'custom:display_name': 'Test User',
        };
      } else {
        if (!token) return respond(res, 401, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Unauthorized' }));
        try {
          claims = toCognitoClaims(await verifyToken(token));
        } catch {
          return respond(res, 401, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Unauthorized' }));
        }
      }
    }

    const body = await readBody(req);
    const event = {
      resource: route.resource,
      path: url.pathname,
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: url.searchParams.size
        ? Object.fromEntries(url.searchParams)
        : null,
      pathParameters: Object.keys(pathParameters).length ? pathParameters : null,
      body: body || null,
      isBase64Encoded: false,
      requestContext: {
        requestId: randomUUID(),
        resourcePath: route.resource,
        httpMethod: req.method,
        identity: { sourceIp: req.socket.remoteAddress },
        ...(claims ? { authorizer: { claims } } : {}),
      },
    };

    const handler = await getHandler(route.lambda);
    const result = await handler(event, { awsRequestId: event.requestContext.requestId });
    const headers = Object.fromEntries(
      Object.entries(result?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    respond(res, result?.statusCode ?? 200, headers, result?.body);
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed:`, err);
    respond(res, 502, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Internal error' }));
  }
});

const port = Number(process.env.PORT || 3001);
server.listen(port, () => console.log(`api-router listening on :${port} (${routes.length} routes, lambda root ${lambdaRoot})`));
