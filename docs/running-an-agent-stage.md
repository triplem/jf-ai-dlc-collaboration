# Running an agent stage end-to-end

This walks the full path: a greenfield intent → the durable orchestrator →
agentcore → Claude Code runs a stage → an artifact lands in the graph. It uses
the OSS durable-execution emulator ([`overlay/durable`](../overlay/durable/))
that replaces AWS Lambda Durable Execution.

## Prerequisites

The compose stack up (see [docker.md](docker.md)), plus an
**`ANTHROPIC_API_KEY`** — the only thing the stage's model call needs:

```bash
cd deploy/compose
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env      # gitignored
```

## 1. Seed the AI-DLC workflow (once)

The `aidlc-v2` workflow and the agent/stage block library are fetched from the
`aidlc-workflows` repo and written to the blocks table. Run the `seed-blocks`
lambda once (it needs outbound access to `codeload.github.com`):

```bash
docker compose exec -T aws-shim node -e "fetch('http://localhost:3004/2015-03-31/functions/seed-blocks/invocations',{method:'POST',body:JSON.stringify({ref:'v2'})}).then(r=>r.text()).then(console.log)"
```

Expect `"total":258` (agents + stages + workflow seeded).

## 2. Point the project at Claude Code

A project defaults to the `kiro` CLI and a Bedrock-format model id. Switch it to
Claude Code with a **direct** Anthropic model id (a bare id bypasses the
Bedrock geo-prefixing in the model resolver):

```bash
TOKEN=$(curl -s -X POST http://localhost:8081/realms/jf-ai-dlc/protocol/openid-connect/token \
  -d 'grant_type=password&client_id=jf-ui&username=alice&password=password' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"agentCli":"claude","cliModels":{"claude":"claude-sonnet-4-6"}}' \
  http://localhost:3001/api/projects/<PROJECT_ID>
```

## 3. Bring up the agent runtime

The agentcore image (Claude Code + the stdio MCP server) is behind the `agents`
profile:

```bash
docker compose --profile agents up -d agentcore
```

## 4. Create and start a greenfield intent

A repo-less intent needs no git provider (repo validation passes with zero
repos, and `init-ws` clones nothing):

```bash
PID=<PROJECT_ID>
IID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"todo-api","prompt":"Build a tiny to-do list REST API with add and list endpoints."}' \
  "http://localhost:3001/api/projects/$PID/intents" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{}' \
  "http://localhost:3001/api/projects/$PID/intents/$IID/start"
```

`start` returns `202`; intent-start invokes the `v2-orchestrator`, which
`aws-shim` runs as a durable execution.

## 5. Watch it run

The orchestrator advances through its durable steps and dispatches the first
stage to agentcore, which spawns Claude Code:

```bash
# durable operation log (steps, statuses, the stage callback)
docker compose exec -T postgres psql -U postgres -d shim -c \
  "SELECT op->>'Name', op->>'Type', op->>'Status' FROM durable_operations ORDER BY seq;"

# the Claude Code run inside agentcore (look for mcp_servers:[{name:'aidlc',status:'connected'}])
docker compose logs -f agentcore
```

You should see the durable loop reach `stage-cb-<stage>` (a `CALLBACK` op) and
suspend, agentcore spawn `cli=claude`, and — with a valid key — the stage
complete, write an artifact through the `mcp__aidlc__create_artifact` tool, and
the callback resume the run to the next stage. Without a key, Claude Code
returns `403 authentication_failed` (the model call is the only gated step).

## How it works

- **Repo-less greenfield**: a project with zero bound repos passes launch
  validation, so no git-provider OAuth is needed for the methodology stages.
- **Durable orchestrator**: `overlay/durable` emulates the AWS Lambda Durable
  Execution runtime (checkpoint/replay/retry/callbacks) so the
  `withDurableExecution`-wrapped orchestrator runs off-AWS. See
  [`overlay/durable/PROTOCOL.md`](../overlay/durable/PROTOCOL.md).
- **Direct Anthropic**: the agentcore Claude driver is patched to use
  `ANTHROPIC_API_KEY` natively instead of Bedrock — see the
  [Local adjustments](../README.md#local-adjustments-vs-upstream) section.
