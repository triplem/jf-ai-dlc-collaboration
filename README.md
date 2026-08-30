# jf-ai-dlc-collaboration

An open-source, self-hosted port of the **Collaborative AI-DLC** platform — the
shared orchestration/governance layer that runs AI-DLC together as a team
(shared intents, approval gates, realtime editing, agent session
orchestration). All AWS services are replaced with OSS components: Docker
Compose for testing, Kubernetes (Helm) for production.

This project **stands on the shoulders of giants**: the platform is the work of
AWS Samples — this is a packaging/adapter layer, not a reimplementation. See
[docs/why.md](docs/why.md) for full credit.

> **The AI-DLC methodology plugin** (for Claude Code and Codex) lives in the
> sibling repo **[jf-ai-dlc](../jf-ai-dlc)** — that's what end users install
> into their own projects. This repo is the collaboration **platform** those
> agents connect to. The two are independent; the plugin points at a platform
> deployment via an optional MCP entry.

Built from a regularly-updated upstream, vendored via `git subtree` (pinned ref
in [UPSTREAM_VERSIONS.md](UPSTREAM_VERSIONS.md)):

| Upstream | What it provides | Docs (pinned version) |
|---|---|---|
| [aws-samples/sample-collaborative-ai-dlc @ v2.0.0](https://github.com/aws-samples/sample-collaborative-ai-dlc/tree/v2.0.0) | The collaboration platform: shared intents, approval gates, realtime editing, agent session orchestration | [docs](https://github.com/aws-samples/sample-collaborative-ai-dlc/tree/v2.0.0/docs) |

The platform seeds the AI-DLC methodology (33 stages / 14 agents) from
[awslabs/aidlc-workflows @ v2](https://github.com/awslabs/aidlc-workflows/tree/v2)
at runtime (`seed-blocks` fetches it from GitHub) — the same source the
[jf-ai-dlc](../jf-ai-dlc) plugin is built from.

## System overview

```
   [jf-ai-dlc plugin] ──(optional collab MCP entry)──┐  (sibling repo; end-user CLI)
                                                      ▼
  frontend (SPA) ──► api-router ──► upstream lambda handlers (in-process)
        │                │                │           │
        │                ▼                ▼           ▼
        │           Keycloak         dynamo-pg     Gremlin Server /
        │           (OIDC)          (DynamoDB on    JanusGraph
        │                            PostgreSQL)   (graph/traceability)
        ▼
  ws-gateway ◄── ws-fanout          SeaweedFS (S3 API: artifacts, attachments)
  yjs-server (realtime docs)        aws-shim (SSM/Secrets on PostgreSQL,
                                             Lambda invoke, Cognito→Keycloak,
                                             durable-execution runtime)
                                    session-runner ──► agentcore containers
                                    (compose: docker / k8s: Deployment)
                                    inference: direct Anthropic/OpenAI keys
```

## AWS → OSS mapping

| AWS service (upstream) | Replacement here | How |
|---|---|---|
| DynamoDB | `overlay/dynamo-pg` | wire-compatible server (dynalite + a Postgres abstract-level store + TransactWriteItems front); endpoint env only, upstream code unchanged |
| Neptune (Gremlin) | Gremlin Server (compose) / JanusGraph (k8s) | env: `NEPTUNE_ENDPOINT`, `GREMLIN_PORT`, `GREMLIN_PROTOCOL` |
| S3 | SeaweedFS | `AWS_ENDPOINT_URL_S3` + a `<bucket>.seaweedfs` network alias for virtual-host addressing |
| Cognito (authorizer) | Keycloak + `overlay/api-router` | router verifies OIDC tokens (JWKS) and projects claims onto the Cognito names handlers read (`sub`, `email`, `cognito:username`, `cognito:groups`, `custom:display_name`) |
| Cognito (frontend SPA auth) | Keycloak + `overlay/frontend/auth.ts` | drop-in replacement for the Amplify auth module (password grant + Auth-Code/PKCE), swapped in at Vite build time — upstream frontend source unchanged |
| Cognito (admin API) | Keycloak Admin API via `overlay/aws-shim` | ListUsers / ListUsersInGroup / AdminGetUser / AdminAdd(Remove)UserToGroup mapped onto realm users + groups |
| API Gateway (HTTP) | `overlay/api-router` | route table generated from the upstream terraform by `scripts/gen-routes.mjs` (164 routes / 23 lambdas); handlers run in-process |
| API Gateway (WebSocket) | `overlay/ws-gateway` | drives `ws-connection` / `ws-message` in-process + serves the `@connections` management API `ws-fanout` targets |
| Lambda (as compute) | long-running containers | one shared image, per-service commands |
| Lambda (Invoke API) | `overlay/aws-shim` | in-process dispatch to the handler whose directory name appears in the function name |
| Lambda Durable Execution | `overlay/durable` (in `aws-shim`) | from-scratch emulator of the AWS Lambda Durable Execution runtime the `v2-orchestrator` uses (protocol in `overlay/durable/PROTOCOL.md`) |
| SSM + Secrets Manager | `overlay/aws-shim` | Postgres-persisted (runtime `PutParameter`/`PutSecretValue` writes survive restarts) |
| Bedrock AgentCore | `overlay/session-runner` | serves the `InvokeAgentRuntime` wire protocol; backends: shared runtime (`http`) or docker container-per-session |
| Bedrock inference | direct Anthropic / OpenAI API keys | env/secrets into the agentcore container. **LiteLLM later**: point the CLI base-URL envs at a LiteLLM deployment — no code change |
| Pricing API | stub in `overlay/aws-shim` | returns an empty price list; cost estimates degrade gracefully |
| CloudFront + S3 hosting | nginx static container (`overlay/frontend/Dockerfile`) | built SPA served with history fallback; behind the ingress in k8s |
| Secrets Manager (deploy-time) | compose env / k8s Secrets | `existingSecret` in the Helm chart |

## Repository layout

```
upstream/collab/     git subtree vendor — never hand-edit
overlay/             all local code
  dynamo-pg/         DynamoDB-on-Postgres server (has its own test suite)
  api-router/        API Gateway replacement (+ generated routes.json)
  ws-gateway/        WebSocket gateway + @connections mgmt API
  aws-shim/          SSM/Secrets/Lambda/Pricing/Cognito-IDP shim + durable runtime
  durable/           AWS Lambda Durable Execution emulator (+ its test suite)
  session-runner/    AgentCore control-plane replacement
  bootstrap/         table/bucket creation (+ generated tables.json)
  oracle/            runs the upstream vitest suite against dynamo-pg
  frontend/          Keycloak/OIDC auth swap + Vite override + SPA Dockerfile
  patches/           in-tree diffs (the direct-Anthropic driver patch)
deploy/compose/      full test stack        deploy/helm/jf-ai-dlc/  prod chart
scripts/             generators + update workflow
docs/                topical documentation (see below)
```

## Documentation

Deeper, topical docs live in [`docs/`](docs/) (this README stays the high-level
overview):

- [Why this project exists](docs/why.md) — the problem it solves and full credit to the upstream projects.
- [Requirements & dependencies](docs/requirements.md) — host tooling and runtime services, with versions, homepages, and licenses.
- [Updating the upstream](docs/upstream-updates.md) — how to fetch a newer Collaborative AI-DLC version.
- [Docker images & Compose](docs/docker.md) — every image and a service-by-service tour of the Compose stack.
- [Running an agent stage](docs/running-an-agent-stage.md) — end-to-end: a greenfield intent → durable orchestrator → agentcore → Claude Code runs a stage → artifact in the graph.

## Scripts

All scripts are safe to re-run (idempotent).

| Script | What it does |
|---|---|
| `gen-routes.mjs` | Parses the upstream terraform API module into `overlay/api-router/routes.json` (164 routes / 23 lambdas). Re-run after every upstream update. |
| `gen-tables.mjs` | Parses every `aws_dynamodb_table` in the upstream terraform into `overlay/bootstrap/tables.json` (14 tables + GSIs). Re-run after every upstream update. |
| `update-upstream.sh [<ref>]` | Pulls the `upstream/collab` subtree, re-applies `overlay/patches/`, regenerates routes/tables, runs the adapter + durable tests, and refreshes `UPSTREAM_VERSIONS.md`. |
| `overlay/bootstrap/bootstrap.mjs` | One-shot stack bootstrap — creates the DynamoDB tables (from `tables.json`) and S3 buckets. Run as the `bootstrap` compose service or the Helm bootstrap Job. |

## Usage

**Run the test stack**

```bash
cd deploy/compose
docker compose up -d                  # infra + platform
docker compose run --rm bootstrap     # idempotent: tables + buckets
# with agents (needs ANTHROPIC_API_KEY / OPENAI_API_KEY in .env):
docker compose --profile agents up -d
```

Smoke check (all verified working):

```bash
TOKEN=$(curl -s http://localhost:8081/realms/jf-ai-dlc/protocol/openid-connect/token \
  -d 'grant_type=password&client_id=jf-ui&username=alice&password=password' \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/projects
```

Open the web UI at **http://localhost:8088** and sign in with `alice` /
`password` (a regular user) or `admin` / `admin` (platform admin).

Endpoints: **Web UI `:8088`** · API `:3001` · WebSocket `:3002` · Keycloak
`:8081` (admin/admin) · dynamo-pg `:8000` · Gremlin `:8182` · S3 `:8333` · yjs `:1234`.

To run an agent stage end-to-end, see
[docs/running-an-agent-stage.md](docs/running-an-agent-stage.md).

**Deploy to Kubernetes**

Install the stateful infra first (CloudNativePG Postgres with `dynamo` + `shim`
databases, Keycloak with the realm from `deploy/compose/keycloak-realm.json`,
JanusGraph, SeaweedFS with S3 gateway), then:

```bash
helm install jf-ai-dlc deploy/helm/jf-ai-dlc -f your-values.yaml
```

**Update the upstream**

```bash
scripts/update-upstream.sh [<ref>]
```

Pulls the subtree, re-applies `overlay/patches/`, regenerates
`routes.json`/`tables.json`, runs the adapter + durable tests, and refreshes
`UPSTREAM_VERSIONS.md`. Then run the **oracle** (the full upstream test suite
against our adapters) before committing:

```bash
cd upstream/collab && npm ci && npx vitest run -c ../../overlay/oracle/vitest.config.js
```

## Local adjustments vs upstream

Everything that differs from upstream, in one place.

### Behavioral adjustments (no upstream code modified)
- **Frontend auth module swapped**: `overlay/frontend/auth.ts` is a drop-in
  replacement for `frontend/src/services/auth.ts` (Amplify/Cognito → Keycloak
  OIDC, dependency-free — password grant for the login form, Auth-Code + PKCE
  for SSO). The swap is a Vite `resolveId` redirect in
  `overlay/frontend/vite.config.jf.ts` (matches by resolved absolute path, so
  every importer is caught), so upstream source is untouched and Amplify is
  fully absent from the bundle. It keeps the exact export surface, so consumers
  still type-check against the original module. Profile edits (display name /
  avatar) are held in a browser-local overlay since the SPA has no Keycloak
  write grant. `jf-ui` client `webOrigins: ["*"]` enables the browser's
  cross-origin token request; the frontend build skips `tsc -b` (the swap is a
  Vite-time concern) and serves via nginx with SPA history fallback.
- **ws-authorizer is bypassed**: it is Cognito-specific (`aws-jwt-verify`);
  `ws-gateway` verifies Keycloak tokens itself and synthesizes the same
  `authorizer: { userId, userName }` context.
- **Issuer split**: tokens carry the public issuer (`OIDC_ISSUER`) while JWKS
  are fetched in-network (`OIDC_JWKS_URL`); Keycloak is pinned via
  `KC_HOSTNAME` so `iss` is stable.
- **api-router route precedence**: a literal path segment beats a parameter at
  the same depth (so `GET /intents/metrics` resolves to the metrics rollup, not
  `/intents/{intentId}` with `intentId="metrics"`). The matcher scores matches
  by literal-segment count and picks the most specific.
- **Config env vars the deploy must set** (found via the click-test):
  `AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER` (the SDK's service key uses the
  full `COGNITO_IDENTITY_PROVIDER` id, not `COGNITO_IDP`, or the admin lambda
  hits real AWS); `COGNITO_USER_POOL_ID` (any placeholder — the handler guards
  on it, aws-shim ignores the value and lists Keycloak users); and
  `V2_PROCESS_TABLE` (the v2-executions table the intent list reads — its
  digit-prefixed name slipped the table-env auto-enumeration). All are wired in
  compose and the Helm ConfigMap.
- **Keycloak realm pins stable user UUIDs** for `alice`/`admin` so realm
  re-imports don't reassign `sub` and orphan graph-owned data; the `jf-ui`
  client sets `webOrigins: ["*"]` for the browser's cross-origin token call.
- **Pricing** returns an empty price list (no OSS pricing source).
- **dynamo-pg is single-writer** (like DynamoDB Local): run exactly one
  replica. `TransactWriteItems` is implemented as serialized conditional ops
  with snapshot rollback (`ConditionCheck` transact items are not supported —
  upstream doesn't use them).
- **ws-gateway holds connections in-process**: one replica unless sticky
  routing per connection is added.

### In-tree patches (`overlay/patches/`)
- `0001-agentcore-claude-direct-anthropic.patch` — the agentcore Claude driver
  (`cli/drivers.js` `envForAuth`) hardcodes `CLAUDE_CODE_USE_BEDROCK=1`; the
  patch makes it use `ANTHROPIC_API_KEY` directly (native Anthropic API, no
  Bedrock) when a direct key is present and no Bedrock token is. Paired with
  `AIDLC_MODEL_ALIASES` on the compose `agentcore` service (Bedrock tier IDs →
  direct Anthropic model IDs). Re-applied by `scripts/update-upstream.sh`.

### Durable execution runtime (`overlay/durable/`)
- The `v2-orchestrator` runs on AWS Lambda Durable Execution
  (`@aws/durable-execution-sdk-js`), which has no OSS equivalent.
  `overlay/durable/` is a from-scratch emulator (protocol in
  `overlay/durable/PROTOCOL.md`) mounted in `aws-shim`: a Postgres-backed
  operation log + the REST runtime/control planes + a driver that runs the
  orchestrator's invoke/replay/retry/callback loop off-Lambda. This is what
  makes starting an intent drive stages.

### The agentcore image (amd64, `overlay/agentcore/Dockerfile`)
- The upstream agentcore image targets ARM64 (Bedrock Graviton microVMs) and
  installs OpenCode/Kiro/Codex with arch-specific binaries that fail on amd64.
  This stack runs Claude Code (npm, arch-independent), so
  `overlay/agentcore/Dockerfile` installs only that CLI + bun/uv + the agentcore
  server, builds on amd64, and serves the same `:8080` `/ping` + `/invocations`
  contract.

## Verification status

- `overlay/dynamo-pg` test suite: 7/7 green (CRUD, GSI query, conditional
  writes, transaction commit/cancel + rollback, restart persistence).
- `overlay/durable` protocol test suite: 7/7 green (checkpoint round-trip,
  callback minting, RETRY→PENDING, resume, 404, pass-through).
- **Oracle**: full upstream vitest suite against dynamo-pg + Gremlin Server:
  **2459/2461 pass** — the 2 failures are pre-existing environment issues
  (`bunx tsc` sensor integration tests) that fail identically with upstream's
  own DynamoDB Local setup.
- Compose e2e smoke: Keycloak login → `POST /api/projects` 201 →
  `GET /api/projects` returns the project with `userRole: owner`
  (DynamoDB + graph writes both exercised).
- Frontend: builds with zero Amplify residue in the bundle; served SPA returns
  200 with history fallback; full browser-equivalent flow verified — Keycloak
  password grant (with CORS) → `id_token` (carries `groups` for platform-admin)
  → `Bearer` API call returns 200.
- **Browser click-test** (headless Chromium against the live stack): 8/8 deep
  flows green with zero console errors and zero API errors — login, dashboard,
  open space (detail renders with the `owner` badge and metrics rollup),
  new-intent page, block library, workflows, create-space wizard, and Platform
  Admin (which lists the Keycloak realm users via aws-shim: "2 users · 1
  admin"). Realtime transport verified separately: ws-gateway closes an
  unauthenticated socket `4401`, and a valid-JWT socket reaches the upstream
  `$connect` handler (`4403` until a per-intent doc token is supplied).
- **Durable orchestrator end-to-end** (the `overlay/durable` emulator against
  the real `v2-orchestrator`, `--profile agents`): starting a greenfield intent
  drives the full durable loop — `load-meta → mint-run-id → init-ws → load-plan
  → stage dispatch` — with correct checkpoint, replay, retry re-run, callback
  minting/suspend, and callback resume all verified. `init-ws` succeeds via
  agentcore, which then spawns **Claude Code with the AI-DLC MCP server
  `connected`** (the MCP→graph write path). The Claude driver runs in
  direct-Anthropic mode (not Bedrock). The only step not yet exercised is the
  model call itself, which needs an `ANTHROPIC_API_KEY` (403 without one).
- Helm: `helm lint` clean, `helm template` renders 16 resources.

## Known gaps

- **A live agent stage producing an artifact** is one step from done: the
  durable orchestrator drives the stack all the way to Claude Code with the MCP
  server connected, but the model call needs an `ANTHROPIC_API_KEY` in
  `deploy/compose/.env`. With the key, the stage authenticates, writes an
  artifact via the MCP tools, and the callback resumes the run to the next
  stage. See [docs/running-an-agent-stage.md](docs/running-an-agent-stage.md).
- **Live collaborative editing session** (two browsers editing one intent
  document) needs a seeded intent + document + per-intent doc token, which the
  orchestrator mints during a real agent run. The realtime transport, auth, and
  handler dispatch are verified; a full co-editing session is not yet exercised.
- **Creating a space through the UI** requires connecting a git provider
  (GitHub/GitLab/Bitbucket OAuth) — an external dependency. The click-test
  seeds a space via the same REST API the UI calls, then drives the deep views.
- **Frontend profile edits** are stored browser-local (the SPA has no Keycloak
  account-write grant); they don't propagate to Keycloak user attributes.
- **session-runner k8s backend**: prod currently uses the shared-runtime
  (`http`) backend against an agentcore Deployment; a Jobs-per-session backend
  is planned.
