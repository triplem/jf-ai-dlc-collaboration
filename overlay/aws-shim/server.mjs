// Wire-level shim for the AWS control services the upstream backend still
// calls. Point the service-specific endpoint env vars at this server:
//   AWS_ENDPOINT_URL_SSM, AWS_ENDPOINT_URL_SECRETS_MANAGER,
//   AWS_ENDPOINT_URL_LAMBDA, AWS_ENDPOINT_URL_PRICING,
//   AWS_ENDPOINT_URL_COGNITO_IDP
//
// Implemented (exactly the ops upstream uses):
//   SSM              GetParameter, GetParameters, PutParameter, DeleteParameter
//                    → Postgres table aws_params (runtime writes must persist)
//   Secrets Manager  GetSecretValue, PutSecretValue, CreateSecret
//                    → Postgres table aws_secrets
//   Lambda           Invoke → in-process import of the upstream handler whose
//                    directory name appears in the function name
//   Pricing          GetProducts → empty PriceList (cost estimates degrade
//                    gracefully; no OSS equivalent)
//   Cognito-IDP      ListUsers, ListUsersInGroup, AdminGetUser,
//                    AdminAddUserToGroup, AdminRemoveUserFromGroup
//                    → Keycloak Admin API (KC_URL, KC_REALM,
//                      KC_ADMIN_CLIENT_ID, KC_ADMIN_CLIENT_SECRET)
//
// Env: PORT (default 3004), SHIM_PG_URL, LAMBDA_ROOT

import http from 'node:http';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  initDurable,
  handleDurableRest,
  isDurableFunction,
  startDurableExecution,
} from '../durable/durable.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const lambdaRoot = path.resolve(process.env.LAMBDA_ROOT || path.join(here, '../../upstream/collab/lambda'));
const pool = new pg.Pool({ connectionString: process.env.SHIM_PG_URL });
await initDurable(pool, lambdaRoot);

await pool.query(`CREATE TABLE IF NOT EXISTS aws_params (
  name TEXT PRIMARY KEY, value TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'String', version INT NOT NULL DEFAULT 1)`);
await pool.query(`CREATE TABLE IF NOT EXISTS aws_secrets (
  id TEXT PRIMARY KEY, value TEXT NOT NULL, version_id TEXT NOT NULL)`);

const err = (type, message, status = 400) => ({ status, body: { __type: type, message } });
const ok = (body = {}) => ({ status: 200, body });

// --- SSM ---------------------------------------------------------------------
const ssm = {
  async GetParameter({ Name }) {
    const { rows } = await pool.query('SELECT * FROM aws_params WHERE name = $1', [Name]);
    if (!rows[0]) return err('ParameterNotFound', `Parameter ${Name} not found.`);
    return ok({ Parameter: { Name, Value: rows[0].value, Type: rows[0].type, Version: rows[0].version } });
  },
  async GetParameters({ Names = [] }) {
    const { rows } = await pool.query('SELECT * FROM aws_params WHERE name = ANY($1)', [Names]);
    const found = new Set(rows.map((r) => r.name));
    return ok({
      Parameters: rows.map((r) => ({ Name: r.name, Value: r.value, Type: r.type, Version: r.version })),
      InvalidParameters: Names.filter((n) => !found.has(n)),
    });
  },
  async PutParameter({ Name, Value, Type = 'String' }) {
    const { rows } = await pool.query(
      `INSERT INTO aws_params (name, value, type) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = $2, type = $3, version = aws_params.version + 1
       RETURNING version`,
      [Name, Value, Type],
    );
    return ok({ Version: rows[0].version });
  },
  async DeleteParameter({ Name }) {
    const { rowCount } = await pool.query('DELETE FROM aws_params WHERE name = $1', [Name]);
    if (!rowCount) return err('ParameterNotFound', `Parameter ${Name} not found.`);
    return ok();
  },
};

// --- Secrets Manager ---------------------------------------------------------
const secrets = {
  async GetSecretValue({ SecretId }) {
    const { rows } = await pool.query('SELECT * FROM aws_secrets WHERE id = $1', [SecretId]);
    if (!rows[0]) return err('ResourceNotFoundException', `Secrets Manager can't find the specified secret.`);
    return ok({ ARN: SecretId, Name: SecretId, SecretString: rows[0].value, VersionId: rows[0].version_id });
  },
  async PutSecretValue({ SecretId, SecretString }) {
    const versionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO aws_secrets (id, value, version_id) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET value = $2, version_id = $3`,
      [SecretId, SecretString, versionId],
    );
    return ok({ ARN: SecretId, Name: SecretId, VersionId: versionId });
  },
  async CreateSecret({ Name, SecretString }) {
    return secrets.PutSecretValue({ SecretId: Name, SecretString });
  },
  async DeleteSecret({ SecretId }) {
    await pool.query('DELETE FROM aws_secrets WHERE id = $1', [SecretId]);
    return ok({ ARN: SecretId, Name: SecretId });
  },
};

// --- Lambda Invoke -----------------------------------------------------------
const lambdaDirs = readdirSync(lambdaRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort((a, b) => b.length - a.length); // longest match first
const handlerCache = new Map();

const invokeLambda = async (functionName, payload) => {
  const dir = lambdaDirs.find((d) => functionName.includes(d));
  if (!dir) return err('ResourceNotFoundException', `Function not found: ${functionName}`, 404);
  if (!handlerCache.has(dir)) {
    handlerCache.set(dir, import(path.join(lambdaRoot, dir, 'index.js')).then((m) => m.handler));
  }
  const handler = await handlerCache.get(dir);
  try {
    const result = await handler(payload, { awsRequestId: crypto.randomUUID() });
    return { status: 200, body: result ?? null };
  } catch (e) {
    return {
      status: 200,
      headers: { 'x-amz-function-error': 'Unhandled' },
      body: { errorType: e.name, errorMessage: e.message },
    };
  }
};

// --- Cognito-IDP → Keycloak Admin API ---------------------------------------
let kcToken = { value: null, expires: 0 };
const kcFetch = async (pathname, init = {}) => {
  const base = process.env.KC_URL?.replace(/\/$/, '');
  const realm = process.env.KC_REALM;
  if (!base || !realm) throw new Error('KC_URL / KC_REALM not configured');
  if (Date.now() > kcToken.expires - 10_000) {
    const res = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.KC_ADMIN_CLIENT_ID,
        client_secret: process.env.KC_ADMIN_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new Error(`keycloak token request failed: ${res.status}`);
    const data = await res.json();
    kcToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  }
  const res = await fetch(`${base}/admin/realms/${realm}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${kcToken.value}`, 'content-type': 'application/json', ...init.headers },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`keycloak ${pathname} failed: ${res.status}`);
  return res.status === 204 ? {} : res.json();
};

const toCognitoUser = (u, attrKey = 'Attributes') => ({
  Username: u.username,
  Enabled: u.enabled !== false,
  UserStatus: 'CONFIRMED',
  [attrKey]: [
    { Name: 'sub', Value: u.id },
    ...(u.email ? [{ Name: 'email', Value: u.email }] : []),
    ...(u.firstName || u.lastName
      ? [{ Name: 'name', Value: [u.firstName, u.lastName].filter(Boolean).join(' ') }]
      : []),
  ],
});

const findGroup = async (name, create = false) => {
  const groups = (await kcFetch(`/groups?search=${encodeURIComponent(name)}`)) || [];
  const exact = groups.find((g) => g.name === name);
  if (exact || !create) return exact ?? null;
  await kcFetch('/groups', { method: 'POST', body: JSON.stringify({ name }) });
  return findGroup(name, false);
};

const findUser = async (username) => {
  const users = (await kcFetch(`/users?username=${encodeURIComponent(username)}&exact=true`)) || [];
  return users[0] ?? null;
};

const cognito = {
  async ListUsers({ Limit = 60, PaginationToken }) {
    const first = PaginationToken ? Number(PaginationToken) : 0;
    const users = (await kcFetch(`/users?first=${first}&max=${Limit}`)) || [];
    return ok({
      Users: users.map((u) => toCognitoUser(u)),
      ...(users.length === Limit ? { PaginationToken: String(first + Limit) } : {}),
    });
  },
  async ListUsersInGroup({ GroupName, Limit = 60, NextToken }) {
    const group = await findGroup(GroupName);
    if (!group) return ok({ Users: [] });
    const first = NextToken ? Number(NextToken) : 0;
    const members = (await kcFetch(`/groups/${group.id}/members?first=${first}&max=${Limit}`)) || [];
    return ok({
      Users: members.map((u) => toCognitoUser(u)),
      ...(members.length === Limit ? { NextToken: String(first + Limit) } : {}),
    });
  },
  async AdminGetUser({ Username }) {
    const user = await findUser(Username);
    if (!user) return err('UserNotFoundException', 'User does not exist.');
    return ok(toCognitoUser(user, 'UserAttributes'));
  },
  async AdminAddUserToGroup({ Username, GroupName }) {
    const user = await findUser(Username);
    if (!user) return err('UserNotFoundException', 'User does not exist.');
    const group = await findGroup(GroupName, true);
    await kcFetch(`/users/${user.id}/groups/${group.id}`, { method: 'PUT' });
    return ok();
  },
  async AdminRemoveUserFromGroup({ Username, GroupName }) {
    const user = await findUser(Username);
    const group = await findGroup(GroupName);
    if (user && group) await kcFetch(`/users/${user.id}/groups/${group.id}`, { method: 'DELETE' });
    return ok();
  },
};

// --- dispatch ----------------------------------------------------------------
const services = {
  AmazonSSM: ssm,
  secretsmanager: secrets,
  AWSCognitoIdentityProviderService: cognito,
  AWSPriceListService: { async GetProducts() { return ok({ PriceList: [] }); } },
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    const raw = await readBody(req);

    // Durable Execution runtime + control plane (REST-JSON under /2025-12-01/).
    const durable = await handleDurableRest(req.method, req.url, raw);
    if (durable) {
      res.writeHead(durable.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(durable.body));
      return;
    }

    const invokeMatch = req.url.match(/^\/2015-03-31\/functions\/([^/]+)\/invocations/);
    if (invokeMatch) {
      const fn = decodeURIComponent(invokeMatch[1]);
      const payload = raw ? JSON.parse(raw) : {};
      // A durability-enabled function's Invoke STARTS a durable execution
      // (there is no StartDurableExecution command) and returns its ARN.
      if (isDurableFunction(fn)) {
        const arn = await startDurableExecution(fn, payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ DurableExecutionArn: arn, StatusCode: 202 }));
        return;
      }
      const result = await invokeLambda(fn, payload);
      res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers || {}) });
      res.end(JSON.stringify(result.body));
      return;
    }

    const target = req.headers['x-amz-target'] || '';
    const [servicePrefix, opName] = target.split('.');
    const op = services[servicePrefix]?.[opName];
    if (!op) {
      res.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' });
      res.end(JSON.stringify({ __type: 'UnknownOperationException', message: `Unsupported: ${target}` }));
      return;
    }
    const result = await op(raw ? JSON.parse(raw) : {});
    res.writeHead(result.status, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify(result.body));
  } catch (e) {
    console.error(`${req.headers['x-amz-target'] || req.url} failed:`, e);
    res.writeHead(500, { 'content-type': 'application/x-amz-json-1.1' });
    res.end(JSON.stringify({ __type: 'InternalFailure', message: String(e?.message || e) }));
  }
});

const port = Number(process.env.PORT || 3004);
server.listen(port, () => console.log(`aws-shim listening on :${port}`));
