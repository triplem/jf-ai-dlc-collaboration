// Drop-in replacement for upstream/collab/test/dynamodb-setup.js: instead of
// the amazon/dynamodb-local testcontainer, start a postgres testcontainer and
// run dynamo-pg in-process against it. Upstream tests only consume
// DYNAMODB_LOCAL_ENDPOINT, so nothing else changes — this is the compatibility
// oracle for the adapter.
import { GenericContainer, Wait } from 'testcontainers';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startServer } = require('../dynamo-pg/src/server.js');

let container;
let server;

export async function setup() {
  container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'ddb' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  server = await startServer({
    connectionString: `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/ddb`,
    port: 0,
    host: '127.0.0.1',
  });

  process.env.DYNAMODB_LOCAL_ENDPOINT = `http://127.0.0.1:${server.port}`;
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'us-east-1';
}

export async function teardown() {
  await server?.close();
  await container?.stop();
}
