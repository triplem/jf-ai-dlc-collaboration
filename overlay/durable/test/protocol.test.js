// Regression test for the durable-execution REST/store protocol contract
// (the reverse-engineered shapes in ../PROTOCOL.md). Self-contained: a real
// Postgres via testcontainers, no orchestrator, no model. Exercises the pieces
// the SDK depends on — checkpoint→NewExecutionState round-trip, callback-id
// minting, GetState, RETRY→PENDING mapping, and callback resolution.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GenericContainer, Wait } from 'testcontainers';
import pg from 'pg';

import { initDurable, handleDurableRest, startDurableExecution } from '../durable.mjs';

let container;
let pool;

const rest = (method, url, body) => handleDurableRest(method, url, body ? JSON.stringify(body) : '');
const ARN = 'arn:aws:lambda:us-east-1:000000000000:durable-execution:test:abc';

test.before(async () => {
  container = await new GenericContainer('postgres:17-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'shim' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  pool = new pg.Pool({
    connectionString: `postgres://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/shim`,
  });
  await initDurable(pool, '/nonexistent-lambda-root'); // driver not exercised here
}, { timeout: 120_000 });

test.after(async () => {
  await pool?.end();
  await container?.stop();
});

test('checkpoint mints a CallbackId and echoes the op in NewExecutionState', async () => {
  const res = await rest('POST', `/2025-12-01/durable-executions/${ARN}/checkpoint`, {
    CheckpointToken: 't1',
    Updates: [{ Id: 'cb-op', Type: 'CALLBACK', Action: 'START', Name: 'await-answer' }],
  });
  assert.equal(res.status, 200);
  const op = res.body.NewExecutionState.Operations.find((o) => o.Id === 'cb-op');
  assert.equal(op.Status, 'STARTED');
  assert.ok(op.CallbackDetails?.CallbackId, 'callback id minted into the checkpoint response');
});

test('step SUCCEED stores the result; RETRY maps to PENDING (re-run on replay)', async () => {
  const ok = await rest('POST', `/2025-12-01/durable-executions/${ARN}/checkpoint`, {
    CheckpointToken: 't1',
    Updates: [{ Id: 'step-ok', Type: 'STEP', Action: 'SUCCEED', Payload: '42', Name: 'double' }],
  });
  assert.equal(ok.body.NewExecutionState.Operations[0].Status, 'SUCCEEDED');

  const retry = await rest('POST', `/2025-12-01/durable-executions/${ARN}/checkpoint`, {
    CheckpointToken: 't1',
    Updates: [{ Id: 'step-retry', Type: 'STEP', Action: 'RETRY', Name: 'flaky' }],
  });
  // A PENDING step is what the SDK re-runs on the next invocation.
  assert.equal(retry.body.NewExecutionState.Operations[0].Status, 'PENDING');
});

// Replay contract: the SDK checkpoints a step result verbatim as `Payload`, but
// on replay reads it back from `StepDetails.Result`. The service must translate,
// or every replayed step returns undefined (the orchestrator then reads a null
// META on its first resume and bails with execution_not_found — no run advances
// past stage 1). Both the checkpoint response AND GetState (the replay source)
// must carry StepDetails.Result.
test('step SUCCEED result is readable on replay as StepDetails.Result', async () => {
  const arn = 'arn:aws:lambda:us-east-1:000000000000:durable-execution:test:replay';
  const payload = JSON.stringify({ meta: 'value', n: 7 });
  const ck = await rest('POST', `/2025-12-01/durable-executions/${arn}/checkpoint`, {
    CheckpointToken: 't1',
    Updates: [{ Id: 'step-replay', Type: 'STEP', SubType: 'Step', Action: 'SUCCEED', Payload: payload, Name: 'load' }],
  });
  const echoed = ck.body.NewExecutionState.Operations[0];
  assert.equal(echoed.StepDetails?.Result, payload, 'checkpoint response carries StepDetails.Result');

  // GetState is what a re-invoke replays from (InitialExecutionState.Operations).
  const state = await rest('GET', `/2025-12-01/durable-executions/${arn}/state`);
  const op = state.body.Operations.find((o) => o.Id === 'step-replay');
  assert.equal(op.StepDetails?.Result, payload, 'replayed op carries StepDetails.Result');
});

test('GetDurableExecutionState returns the full operation log', async () => {
  const res = await rest('GET', `/2025-12-01/durable-executions/${ARN}/state`);
  assert.equal(res.status, 200);
  const ids = res.body.Operations.map((o) => o.Id).sort();
  assert.deepEqual(ids, ['cb-op', 'step-ok', 'step-retry']);
});

test('callback succeed resolves the op to SUCCEEDED with the result', async () => {
  const state = await rest('GET', `/2025-12-01/durable-executions/${ARN}/state`);
  const cbId = state.body.Operations.find((o) => o.Id === 'cb-op').CallbackDetails.CallbackId;

  const res = await rest('POST', `/2025-12-01/durable-execution-callbacks/${cbId}/succeed`, {
    ResultPayload: 'the-answer',
  });
  assert.equal(res.status, 200);

  const after = await rest('GET', `/2025-12-01/durable-executions/${ARN}/state`);
  const cbOp = after.body.Operations.find((o) => o.Id === 'cb-op');
  assert.equal(cbOp.Status, 'SUCCEEDED');
  assert.equal(cbOp.CallbackDetails.Result, 'the-answer');
});

test('unknown callback id is a 404', async () => {
  const res = await rest('POST', `/2025-12-01/durable-execution-callbacks/does-not-exist/succeed`, {});
  assert.equal(res.status, 404);
});

test('heartbeat is accepted as a no-op', async () => {
  const state = await rest('GET', `/2025-12-01/durable-executions/${ARN}/state`);
  const cbId = state.body.Operations.find((o) => o.Id === 'cb-op').CallbackDetails.CallbackId;
  const res = await rest('POST', `/2025-12-01/durable-execution-callbacks/${cbId}/heartbeat`, {});
  assert.equal(res.status, 200);
});

test('a non-durable path returns null (falls through to the shim)', async () => {
  const res = await rest('POST', `/2015-03-31/functions/foo/invocations`, {});
  assert.equal(res, null);
});

// Driver regression: a SUCCEEDED handler carries its return value in the SDK's
// `Result` field, not `Output`. The driver must persist `Result` as the
// execution Output — otherwise every completed run stores null.
test('driver persists the handler Result envelope as the execution Output', async () => {
  // Stand up a fake durability-enabled lambda whose handler returns a terminal
  // envelope with the value in `Result` (the shape the real SDK emits).
  const root = mkdtempSync(path.join(os.tmpdir(), 'durable-lambda-'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  mkdirSync(path.join(root, 'v2-orchestrator'));
  writeFileSync(
    path.join(root, 'v2-orchestrator', 'index.js'),
    "export const lambdaHandler = async () => ({ Status: 'SUCCEEDED', Result: { intentId: 'i-123', done: true } });\n",
  );
  await initDurable(pool, root); // repoint the driver at the fake lambda root

  const arn = await startDurableExecution('v2-orchestrator', { hello: 'world' });

  // runInvoke is fire-and-forget; poll the execution record until terminal.
  let output;
  for (let i = 0; i < 100; i++) {
    const res = await rest('GET', `/2025-12-01/durable-executions/${encodeURIComponent(arn)}`);
    if (res.body.Status === 'SUCCEEDED') {
      output = res.body.Output;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(output, { intentId: 'i-123', done: true });
});
