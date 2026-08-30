// API Gateway WebSocket replacement.
//
// Client side: ws://host:PORT/?token=…&documentId=… — the token is verified
// against Keycloak (OIDC JWKS) directly; upstream's ws-authorizer lambda is
// Cognito-specific (aws-jwt-verify) and is intentionally NOT used here — this
// gateway synthesizes the same `authorizer: { userId, userName }` context it
// would have produced (documented local adjustment).
//
// Server side: the ApiGatewayManagementApi wire protocol consumed by
// ws-fanout.js and agentcore/clients.js:
//   POST   /@connections/{connectionId}  → deliver payload to the socket
//   DELETE /@connections/{connectionId}  → close the socket
//   GET    /@connections/{connectionId}  → connection status
// Unknown connection → 410 (SDK maps it to GoneException).
//
// $connect / $disconnect / $default are delivered to the upstream
// ws-connection and ws-message handlers in-process.
//
// Env: PORT (default 3002), LAMBDA_ROOT, OIDC_ISSUER, AUTH_DISABLED

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const here = path.dirname(fileURLToPath(import.meta.url));
const lambdaRoot = path.resolve(process.env.LAMBDA_ROOT || path.join(here, '../../upstream/collab/lambda'));

const { handler: connectionHandler } = await import(path.join(lambdaRoot, 'ws-connection/index.js'));
const { handler: messageHandler } = await import(path.join(lambdaRoot, 'ws-message/index.js'));

const authDisabled = process.env.AUTH_DISABLED === 'true';
let jwks;
const verifyToken = async (token) => {
  if (!jwks) {
    const issuer = process.env.OIDC_ISSUER;
    if (!issuer) throw new Error('OIDC_ISSUER is not configured');
    const jwksUrl =
      process.env.OIDC_JWKS_URL || `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`;
    jwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  const { payload } = await jwtVerify(token, jwks, { issuer: process.env.OIDC_ISSUER });
  return payload;
};

const sockets = new Map(); // connectionId → WebSocket

const wsEvent = (connectionId, routeKey, authorizer, extra = {}) => ({
  requestContext: {
    connectionId,
    routeKey,
    requestId: randomUUID(),
    domainName: process.env.WS_DOMAIN || 'ws-gateway',
    stage: process.env.WS_STAGE || 'local',
    authorizer,
  },
  ...extra,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/@connections\/([^/]+)$/);
  if (url.pathname === '/healthz') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  if (!m) {
    res.writeHead(404);
    res.end();
    return;
  }
  const connectionId = decodeURIComponent(m[1]);
  const socket = sockets.get(connectionId);
  if (!socket || socket.readyState !== socket.OPEN) {
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'GoneException' }));
    return;
  }
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      socket.send(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200);
      res.end('{}');
    });
  } else if (req.method === 'DELETE') {
    socket.close(1000, 'server disconnect');
    res.writeHead(204);
    res.end();
  } else if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ConnectedAt: new Date().toISOString() }));
  } else {
    res.writeHead(405);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (socket, req) => {
  const url = new URL(req.url, 'http://localhost');
  const queryStringParameters = Object.fromEntries(url.searchParams);

  let authorizer;
  if (authDisabled) {
    authorizer = { userId: queryStringParameters.testSub || 'test-user', userName: 'Test User' };
  } else {
    try {
      const payload = await verifyToken(queryStringParameters.token || '');
      authorizer = {
        userId: payload.sub,
        userName: payload.preferred_username || payload.email || payload.sub,
      };
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
  }

  const connectionId = randomUUID();
  sockets.set(connectionId, socket);

  try {
    const result = await connectionHandler(
      wsEvent(connectionId, '$connect', authorizer, { queryStringParameters }),
    );
    if (result?.statusCode && result.statusCode >= 300) {
      socket.close(4403, 'connect rejected');
      sockets.delete(connectionId);
      return;
    }
  } catch (err) {
    console.error('$connect handler failed:', err);
    socket.close(1011, 'connect failed');
    sockets.delete(connectionId);
    return;
  }

  socket.on('message', async (data) => {
    try {
      await messageHandler(
        wsEvent(connectionId, '$default', authorizer, { body: data.toString('utf8') }),
      );
    } catch (err) {
      console.error('$default handler failed:', err);
    }
  });

  socket.on('close', async () => {
    sockets.delete(connectionId);
    try {
      await connectionHandler(wsEvent(connectionId, '$disconnect', authorizer, { queryStringParameters }));
    } catch (err) {
      console.error('$disconnect handler failed:', err);
    }
  });
});

const port = Number(process.env.PORT || 3002);
server.listen(port, () => console.log(`ws-gateway listening on :${port}`));
