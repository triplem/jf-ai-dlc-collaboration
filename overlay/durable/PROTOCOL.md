# Durable Execution — reverse-engineered protocol

An OSS emulator of the AWS Lambda Durable Execution runtime that
`@aws/durable-execution-sdk-js` expects. Reverse-engineered from
`upstream/collab/lambda/v2-orchestrator/node_modules/@aws/durable-execution-sdk-js`
and `@aws-sdk/client-lambda` (API version `2025-12-01`). The orchestrator
(`upstream/collab/lambda/v2-orchestrator/index.js`) is
`withDurableExecution(handler)`; this is what makes intent-start actually drive
stages.

## Two planes, both over the Lambda endpoint

All calls go through the AWS SDK's Lambda client, i.e. `AWS_ENDPOINT_URL_LAMBDA`
→ our `aws-shim`. The durable ops are **REST-JSON** under `/2025-12-01/…`
(distinct from the awsJson `Invoke` at `/2015-03-31/functions/{fn}/invocations`).

### Runtime plane (SDK → service, during an invocation)
- `GET  /2025-12-01/durable-executions/{arn}/state?CheckpointToken&Marker&MaxItems`
  → `GetDurableExecutionState` → `{ Operations: [...], NextMarker }`.
- `POST /2025-12-01/durable-executions/{arn}/checkpoint`
  → `CheckpointDurableExecution`, body `{ CheckpointToken, ClientToken, Updates: [op…] }`
  → `{ CheckpointToken?, NewExecutionState: { Operations: [op…] } }`.

### Control plane (backend → service)
- **Start = a normal `Invoke`** of the orchestrator function (there is NO
  StartDurableExecution command). Durability is a function property; invoking it
  begins a durable execution.
- `GET  /2025-12-01/durable-executions/{arn}` → `GetDurableExecution` → status + output.
- `GET  /2025-12-01/functions/{FunctionName}/durable-executions` → `ListDurableExecutionsByFunction`.
- `POST /2025-12-01/durable-executions/{arn}/stop` → `StopDurableExecution`.
- `POST /2025-12-01/durable-execution-callbacks/{CallbackId}/succeed` → `SendDurableExecutionCallbackSuccess`.
- `POST /2025-12-01/durable-execution-callbacks/{CallbackId}/heartbeat` → `SendDurableExecutionCallbackHeartbeat`.
- `POST /2025-12-01/durable-execution-callbacks/{CallbackId}/fail` → callback fail.

## The invocation event (service → handler)

Every (re)invoke of the wrapped handler passes the **original business payload
merged with** durable metadata. `validateDurableExecutionEvent` requires
`DurableExecutionArn` + `CheckpointToken`; `initializeExecutionContext` reads:

```jsonc
{
  // ...original business payload (e.g. { action:'start', intentId, executionId })
  "DurableExecutionArn": "arn:.../durable/<uuid>",
  "CheckpointToken": "<token>",
  "InitialExecutionState": { "Operations": [ <op>… ], "NextMarker": "" },
  "UpdatedOperationIds": [ "<hashedOpId>"… ]   // ops changed since last invoke
}
```

Mode: `operations.length > 1 → ReplayMode`, else `ExecutionMode`. The service
stores the business payload as the execution input and re-supplies it verbatim
on every replay.

## Operation record (the opaque log)

Operations are keyed by `Id` (an already-hashed step id; `ParentId` also
hashed). The store treats them as **opaque round-trip records** — the SDK owns
all replay logic. Fields seen: `Id, ParentId, Type` (STEP | CALLBACK | WAIT | …),
`SubType, Action` (START | SUCCEED/COMPLETE | FAIL | …), `Name, Status`
(STARTED | SUCCEEDED | FAILED | TIMED_OUT), `Result, Input, Error,
CallbackOptions, CallbackDetails`.

Service applies `Action → Status` and stores payloads:
- `START` → `STARTED`.
- success action → `SUCCEEDED`, store `Result`.
- `FAIL` → `FAILED`, store `Error`.

## Callbacks — the key handshake

1. `context.createCallback(name)` (execution mode) checkpoints
   `{ Id, ParentId, Action:'START', Type:'CALLBACK', SubType:'CALLBACK', Name, CallbackOptions }`.
2. The service **mints a `CallbackId`**, stores `op.CallbackDetails = { CallbackId }`,
   maps `CallbackId → (arn, opId)`, and **returns the op in the checkpoint
   response `NewExecutionState.Operations`**. The SDK's
   `updateStepDataFromCheckpointResponse` sets `stepData[op.Id] = op`, so the
   SDK reads `CallbackDetails.CallbackId` back **in the same invocation** and
   returns `[promise, callbackId]` to the orchestrator, which hands the id to
   the agent (agentcore) via the run-stage invocation.
3. Awaiting the (still-unresolved) callback promise interrupts the invocation →
   the wrapped handler returns `{ Status: 'PENDING' }`.
4. `SendDurableExecutionCallbackSuccess(CallbackId, result)` sets that op to
   `SUCCEEDED` with `CallbackDetails.Result = result`, then **re-invokes** the
   execution in replay mode with `UpdatedOperationIds=[opId]`. The replayed
   `createCallback` now sees `Status SUCCEEDED` and resolves; execution
   continues to the next stage/callback.

## Terminal status (handler → service)

The wrapped handler returns `{ Status: SUCCEEDED | FAILED | PENDING, Output? / Error? }`.
- `SUCCEEDED`/`FAILED` → execution done; store output/error (surfaced by
  `GetDurableExecution`).
- `PENDING` → suspended on a callback/wait; wait for an external succeed/timer
  to re-invoke.

## Emulator shape (this module)

- **store** (Postgres): `durable_executions(arn, function_name, input, status,
  output, checkpoint_token, created_at)`, `durable_operations(arn, op_id,
  op_json, updated_at)`, `durable_callbacks(callback_id, arn, op_id, status)`.
- **service**: REST handlers for the two planes above (mounted in aws-shim).
- **driver**: on Invoke of a durability-enabled function (allowlist), create an
  execution and run the invoke→checkpoint→(PENDING|DONE) loop in the background;
  re-invoke on callback success. Invokes the orchestrator handler in-process
  (same mechanism aws-shim already uses for `Invoke`), so the SDK's runtime-plane
  calls loop back to aws-shim over `AWS_ENDPOINT_URL_LAMBDA`.

Build empirically: the SDK logs verbosely under `DURABLE_VERBOSE_MODE=true` and
runs `validateReplayConsistency`, so shape mistakes surface as explicit errors.
