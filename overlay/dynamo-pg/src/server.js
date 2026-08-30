'use strict';

// DynamoDB wire-compatible server on PostgreSQL.
//
// dynalite provides the full DynamoDB semantics (expressions, GSIs, paging,
// conditional writes) but (a) only knows LevelDB-style stores and (b) lacks
// TransactWriteItems. This module fixes both:
//   - injects PgLevel as the 'level' module before dynalite loads, so
//     `options.path` becomes a Postgres connection string
//   - fronts dynalite with a server that implements TransactWriteItems as
//     sequential conditional ops under a global write mutex, with snapshot
//     rollback — atomic because ALL writes are serialized through that mutex
//
// Single-instance by design (like DynamoDB Local): run exactly one replica.

const http = require('http');
const { PgLevel } = require('./pg-level');

// Must happen before require('dynalite'): dynalite does `{ Level } = require('level')`.
const levelPath = require.resolve('level');
require.cache[levelPath] = {
  id: levelPath,
  filename: levelPath,
  loaded: true,
  exports: { Level: PgLevel },
};
// eslint-disable-next-line import/order
const dynalite = require('dynalite');

const API = 'DynamoDB_20120810';
const WRITE_OPS = new Set([
  'PutItem',
  'UpdateItem',
  'DeleteItem',
  'BatchWriteItem',
  'CreateTable',
  'DeleteTable',
  'UpdateTable',
]);

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

async function startServer({ connectionString, port = 8000, host = '0.0.0.0' } = {}) {
  if (!connectionString) throw new Error('dynamo-pg: connectionString (DYNAMO_PG_URL) is required');

  const inner = dynalite({ path: connectionString, createTableMs: 0, deleteTableMs: 0, updateTableMs: 0 });
  await new Promise((resolve, reject) => {
    inner.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const innerPort = inner.address().port;

  const call = async (op, payload) => {
    const res = await fetch(`http://127.0.0.1:${innerPort}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `${API}.${op}`,
        'x-amz-date': '20120810T000000Z',
        authorization:
          'AWS4-HMAC-SHA256 Credential=dynamo-pg/20120810/local/dynamodb/aws4_request, SignedHeaders=host, Signature=0',
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  };

  // Global write mutex: guarantees transactions never interleave with other writes.
  let chain = Promise.resolve();
  const withWriteLock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  const keySchemaCache = new Map();
  const tableKeys = async (tableName) => {
    if (!keySchemaCache.has(tableName)) {
      const { status, body } = await call('DescribeTable', { TableName: tableName });
      if (status !== 200) throw Object.assign(new Error('DescribeTable failed'), { response: { status, body } });
      keySchemaCache.set(tableName, body.Table.KeySchema.map((k) => k.AttributeName));
    }
    return keySchemaCache.get(tableName);
  };

  const conditionFailed = (body) =>
    typeof body?.__type === 'string' && body.__type.includes('ConditionalCheckFailedException');

  const transactWrite = async (payload) => {
    const items = payload.TransactItems || [];
    const applied = []; // { tableName, key, oldItem }
    const rollback = async () => {
      for (const { tableName, key, oldItem } of applied.reverse()) {
        if (oldItem) await call('PutItem', { TableName: tableName, Item: oldItem });
        else await call('DeleteItem', { TableName: tableName, Key: key });
      }
    };

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const kind = ['Put', 'Update', 'Delete', 'ConditionCheck'].find((k) => item[k]);
      if (kind === 'ConditionCheck' || !kind) {
        await rollback();
        return {
          status: 400,
          body: {
            __type: `com.amazonaws.dynamodb.v20120810#ValidationException`,
            message: `dynamo-pg: unsupported TransactItem${kind ? ` type ${kind}` : ''}`,
          },
        };
      }
      const op = item[kind];
      const tableName = op.TableName;
      let key = op.Key;
      if (kind === 'Put') {
        const keyAttrs = await tableKeys(tableName);
        key = Object.fromEntries(keyAttrs.map((a) => [a, op.Item[a]]));
      }
      const snapshot = await call('GetItem', { TableName: tableName, Key: key, ConsistentRead: true });
      if (snapshot.status !== 200) {
        await rollback();
        return snapshot;
      }

      const { ReturnValuesOnConditionCheckFailure, ...forward } = op;
      const result = await call(`${kind}Item`, forward);
      if (result.status !== 200) {
        await rollback();
        if (conditionFailed(result.body)) {
          const reasons = items.map((_, j) =>
            j === i ? { Code: 'ConditionalCheckFailed', Message: result.body.message } : { Code: 'None' },
          );
          return {
            status: 400,
            body: {
              __type: `com.amazonaws.dynamodb.v20120810#TransactionCanceledException`,
              message: `Transaction cancelled, please refer cancellation reasons for specific reasons [${reasons.map((r) => r.Code).join(', ')}]`,
              CancellationReasons: reasons,
            },
          };
        }
        return result;
      }
      applied.push({ tableName, key, oldItem: snapshot.body.Item });
    }
    return { status: 200, body: {} };
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('dynamo-pg');
        return;
      }
      const target = req.headers['x-amz-target'] || '';
      const op = target.split('.')[1] || '';
      const raw = await readBody(req);
      const payload = raw.length ? JSON.parse(raw.toString('utf8')) : {};

      let result;
      if (op === 'TransactWriteItems') {
        result = await withWriteLock(() => transactWrite(payload));
      } else if (WRITE_OPS.has(op)) {
        result = await withWriteLock(() => call(op, payload));
        if (op === 'DeleteTable' || op === 'UpdateTable') keySchemaCache.delete(payload.TableName);
      } else {
        result = await call(op, payload);
      }
      res.writeHead(result.status, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(
        JSON.stringify({
          __type: 'com.amazonaws.dynamodb.v20120810#InternalServerError',
          message: String(err?.message || err),
        }),
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(port, host, (err) => (err ? reject(err) : resolve()));
  });

  return {
    port: server.address().port,
    close: () =>
      Promise.all([
        new Promise((r) => server.close(r)),
        new Promise((r) => inner.close(r)),
      ]),
  };
}

module.exports = { startServer };
