# Running a full end-to-end test

This is the top-to-bottom check that the platform works: it exercises **two
layers** against a running Compose stack.

1. **API / auth e2e** — Keycloak login → `POST /api/projects` → `GET
   /api/projects`, proving the auth → API → DynamoDB(+graph) write path.
2. **Agent-stage e2e** — a greenfield intent driven through the durable
   orchestrator → agentcore → **real Claude inference** → durable callback
   resume. This is the deep path documented in
   [Running an agent stage](running-an-agent-stage.md); it's summarised here so
   the whole e2e lives in one place.

Layer 1 needs only the base stack. Layer 2 additionally needs the `agents`
profile and an `ANTHROPIC_API_KEY`.

## 0. Bring the stack up

See [Docker images & Compose](docker.md) for the full story; the short version:

```bash
cd deploy/compose
docker compose up -d                  # infra + platform
docker compose run --rm bootstrap     # idempotent: tables + buckets
# Layer 2 only — needs ANTHROPIC_API_KEY / OPENAI_API_KEY in .env:
docker compose --profile agents up -d
```

Confirm the core services are healthy before testing:

```bash
docker compose ps        # keycloak should be "healthy"; api-router, dynamo-pg, gremlin up
```

Endpoints: Web UI `:8088` · API `:3001` · WebSocket `:3002` · Keycloak `:8081`
· dynamo-pg `:8000` · Gremlin `:8182` · S3 `:8333`.

!!! warning "Keycloak tokens expire fast"
    Access tokens from the password grant live only a few minutes. A poll loop
    that runs longer than that will start getting `401 {"message":"Unauthorized"}`
    — **re-mint the token inside the loop**, don't fetch it once up front.

## 1. API / auth e2e

Log in as `alice` (a regular user), create a project, and read it back. A
successful create returns **201**; the project must come back from the list with
`userRole: owner` — that single assertion proves both the DynamoDB and graph
writes landed.

```bash
# 1. token
TOKEN=$(curl -s http://localhost:8081/realms/jf-ai-dlc/protocol/openid-connect/token \
  -d 'grant_type=password&client_id=jf-ui&username=alice&password=password' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

# 2. create — expect HTTP 201
NAME="e2e-$(date +%s)"
curl -s -w '\n%{http_code}\n' -X POST http://localhost:3001/api/projects \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"$NAME\",\"description\":\"e2e smoke\"}"

# 3. read back — expect the project with "userRole":"owner"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects \
  | python3 -m json.tool
```

**Pass criteria:** step 2 is `201`; step 3 is `200` and contains your project
with `"userRole": "owner"`.

## 2. Agent-stage e2e

This drives the full durable path and burns real Claude tokens (the
`workspace-scaffold` stage costs ~$0.20). Prerequisites: `--profile agents` up
and `ANTHROPIC_API_KEY` in `deploy/compose/.env`.

### 2a. Seed the workflow (once per stack)

The `aidlc-v2` workflow + agent/stage block library is fetched from
`aidlc-workflows` and written to the blocks table:

```bash
docker compose exec -T aws-shim node -e \
  "fetch('http://localhost:3004/2015-03-31/functions/seed-blocks/invocations',{method:'POST',body:JSON.stringify({ref:'v2'})}).then(r=>r.text()).then(console.log)"
```

Expect `"total":258`. To check whether a stack is already seeded (dynamo-pg
stores everything in one `kv` table):

```bash
docker compose exec -T postgres psql -U postgres -d dynamo -tAc \
  "select count(*) from kv where key like 'item-aidlc-blocks-local%';"
# non-zero (e.g. 628, counting versions + GSI rows) => already seeded
```

### 2b. Create a project pointed at Claude Code

A project defaults to the `kiro` CLI + a Bedrock-format model id. Switch it to
Claude Code with a **bare** Anthropic model id (bypasses the Bedrock
geo-prefixing in the model resolver):

```bash
TOKEN=$(curl -s http://localhost:8081/realms/jf-ai-dlc/protocol/openid-connect/token \
  -d 'grant_type=password&client_id=jf-ui&username=alice&password=password' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')

PID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"agent-stage-e2e","description":"agent stage e2e"}' \
  http://localhost:3001/api/projects | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -s -o /dev/null -w '%{http_code}\n' -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentCli":"claude","cliModels":{"claude":"claude-sonnet-4-6"}}' \
  http://localhost:3001/api/projects/$PID          # expect 200
```

### 2c. Create and start a greenfield intent

A repo-less intent needs no git provider (`init-ws` clones nothing):

```bash
IID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"todo-api","prompt":"Build a tiny to-do list REST API with add and list endpoints."}' \
  "http://localhost:3001/api/projects/$PID/intents" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Authorization: Bearer $TOKEN" -d '{}' \
  "http://localhost:3001/api/projects/$PID/intents/$IID/start"   # expect 202
```

### 2d. Watch it run and assert

Three independent signals confirm the path end-to-end.

**Intent status** (note: the payload is nested under `intent`):

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3001/api/projects/$PID/intents/$IID" \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['intent'];print(d['status'],d['currentPhase'],d['currentStage'],d.get('failureReason'))"
```

**agentcore** — the Claude run. Grab the `session_id` from the `run-stage`
line for **your** intent, then match the result event to that session (the log
may also contain other runs' sessions — don't assert on the wrong one):

```bash
docker compose logs agentcore | grep "run-stage.*$IID"      # -> session_id
docker compose logs agentcore | grep '<session_id>' | grep '"type":"result"'
```

Look for `mcp_servers:[{name:'aidlc',status:'connected'}]`,
`apiKeySource:ANTHROPIC_API_KEY`, and a final result with **`is_error:false`**.

**Durable operations** — the orchestrator's checkpoint log:

```bash
docker compose exec -T postgres psql -U postgres -d shim -c \
  "SELECT seq, op->>'Name', op->>'Type', op->>'Status' FROM durable_operations ORDER BY seq DESC LIMIT 12;"
```

**Pass criteria** — for your run's execution you should see:

- `stage-cb-workspace-scaffold` · `CALLBACK` · **`SUCCEEDED`** (the stage
  callback resolved), and
- `run-workspace-scaffold` · `STEP` · **`SUCCEEDED`**, and
- the matching agentcore result with `is_error:false`.

The intent settles at `RUNNING · initialization/workspace-scaffold` with the
callback resolved. **That is the expected terminal state**, not a stall: the
verified scope is the single first stage — real Claude inference, MCP-connected,
durable callback resume. Auto-advancing through the remaining gated stages of
the 33-stage plan is not yet exercised upstream (see the *Verification status*
in the [README](../README.md)).

**Without a valid key**, Claude Code returns `403 authentication_failed` — the
model call is the only gated step; everything up to it (durable dispatch,
agentcore spawn, MCP connect) still runs.

## What "green" looks like

| Layer | Assertion |
|---|---|
| API / auth | `POST /api/projects` → 201; project reads back with `userRole: owner` |
| Agent-stage | `stage-cb-workspace-scaffold` CALLBACK SUCCEEDED + agentcore result `is_error:false` |
