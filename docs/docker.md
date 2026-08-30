# Docker images & Compose

The test stack is defined by a single Compose file,
[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml). It
combines a few third-party images, three jf-ai-dlc-authored images, and one
image built from the upstream sources.

## Images

### jf-ai-dlc-authored

| Image | Built from | What it is |
|---|---|---|
| `jf-ai-dlc-services` | [`deploy/compose/Dockerfile.services`](../deploy/compose/Dockerfile.services) | One shared `node:22-alpine` image containing the upstream `lambda/` code and all `overlay/` Node services. Each Compose service selects its entrypoint with `command:` (e.g. `node overlay/api-router/server.mjs`). Includes the `docker` CLI for session-runner's docker backend. The build drops upstream's `husky` prepare hook (dev-only) and installs each overlay service's deps. |
| `jf-ai-dlc-frontend` | [`overlay/frontend/Dockerfile`](../overlay/frontend/Dockerfile) | Multi-stage: stage 1 builds the upstream SPA with Vite using `overlay/frontend/vite.config.jf.ts`, which swaps the Cognito/Amplify auth module for the Keycloak/OIDC one (`overlay/frontend/auth.ts`); stage 2 serves the static build from `nginx:1.27-alpine` with SPA history fallback. All `VITE_*` are **build-time args** (the compose service passes local-stack values). |
| `jf-ai-dlc-agentcore` | [`overlay/agentcore/Dockerfile`](../overlay/agentcore/Dockerfile) | amd64, Claude-Code-only agent runtime (the upstream image is ARM64/Bedrock-only). Installs `@anthropic-ai/claude-code` + bun/uv + the agentcore server; serves the `:8080` `/ping` + `/invocations` contract. Heavy image — gated behind the `agents` Compose profile. Needs provider API keys. |

The one shared services image backs six Compose services: `dynamo-pg`,
`aws-shim`, `api-router`, `ws-gateway`, `session-runner`, and the one-shot
`bootstrap`.

### Built from upstream sources

| Image | Build context | Notes |
|---|---|---|
| `yjs-server` | `upstream/collab/lambda/yjs-server` | Upstream real-time document server, built unmodified. |

### Third-party images

| Image | Replaces (AWS) |
|---|---|
| `postgres:17-alpine` | DynamoDB (via dynamo-pg) + SSM/Secrets (via aws-shim) |
| `tinkerpop/gremlin-server:3.7.3` | Neptune (graph) |
| `chrislusf/seaweedfs:3.80` | S3 (artifacts/attachments) |
| `quay.io/keycloak/keycloak:26.3` | Cognito (auth) |
| `nginx:1.27-alpine` | CloudFront + S3 static hosting |
| `node:22-alpine` | Lambda/Fargate compute (base image) |

Homepages and licenses for all of these are in
[Requirements & dependencies](requirements.md).

## The Compose file, service by service

Project name: `jf-ai-dlc`. Network: a single `default` bridge named
`jf-ai-dlc`. Named volumes: `pg_data`, `seaweed_data`, `keycloak_data`.

| Service | Image / build | Host port | Role | Depends on |
|---|---|---|---|---|
| `postgres` | `postgres:17-alpine` | `5433→5432` | Backing DB (databases `dynamo`, `shim`) | — |
| `gremlin` | `tinkerpop/gremlin-server:3.7.3` | `8182` | Graph store | — |
| `seaweedfs` | `chrislusf/seaweedfs:3.80` | `8333` | S3 API (artifacts) | — |
| `keycloak` | `quay.io/keycloak/keycloak:26.3` | `8081→8080` | OIDC auth (realm imported at start) | — |
| `dynamo-pg` | `jf-ai-dlc-services` | `8000` | DynamoDB-compatible server on Postgres | postgres |
| `aws-shim` | `jf-ai-dlc-services` | — | SSM/Secrets/Lambda/Pricing/Cognito-IDP shim | postgres |
| `api-router` | `jf-ai-dlc-services` | `3001` | API Gateway (HTTP) replacement | dynamo-pg, gremlin, aws-shim |
| `ws-gateway` | `jf-ai-dlc-services` | `3002` | API Gateway (WebSocket) replacement | dynamo-pg |
| `session-runner` | `jf-ai-dlc-services` | — | Bedrock AgentCore control-plane replacement | — |
| `yjs-server` | built (`upstream/.../yjs-server`) | `1234` | Real-time document server | dynamo-pg |
| `frontend` | `jf-ai-dlc-frontend` | `8088→80` | Web UI (SPA) | api-router, ws-gateway, keycloak |
| `bootstrap` | `jf-ai-dlc-services` | — | One-shot: create DynamoDB tables + S3 buckets | dynamo-pg, seaweedfs |
| `agentcore` | built (`upstream/.../agentcore`), profile `agents` | — | Agent runtime (opt-in) | — |

### Shared env anchors

Two YAML anchors keep the AWS-SDK endpoint redirection and app config in one
place, merged into each app service with `<<: *app-env`:

- **`x-aws-env` (`&aws-env`)** — points every AWS SDK client at the local
  substitutes: `AWS_ENDPOINT_URL_DYNAMODB`, `AWS_ENDPOINT_URL_S3`,
  `AWS_ENDPOINT_URL_SSM`/`_SECRETS_MANAGER`/`_LAMBDA`/`_PRICING`/
  `_COGNITO_IDENTITY_PROVIDER`, and `AWS_ENDPOINT_URL_BEDROCK_AGENTCORE`.
- **`x-app-env` (`&app-env`)** — extends `aws-env` with app config: the Gremlin
  endpoint, the OIDC issuer/JWKS split, the artifacts bucket, and the DynamoDB
  table-name env vars (including `V2_PROCESS_TABLE`).

### Notable wiring

- **SeaweedFS virtual-host addressing**: the `seaweedfs` service has a network
  alias `artifacts.seaweedfs`, so `<bucket>.<host>`-style S3 URLs resolve.
- **Keycloak** imports `deploy/compose/keycloak-realm.json` on first start
  (realm `jf-ai-dlc`, the `jf-ui` public client, an `aws-shim-admin` service
  account, and seed users with pinned UUIDs).
- **Postgres** creates the `dynamo` and `shim` databases via
  `deploy/compose/postgres-init.sh`.

## Running it

```bash
cd deploy/compose
docker compose up -d                 # infra + platform services
docker compose run --rm bootstrap    # idempotent: create tables + buckets
```

With agents (needs `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `deploy/compose/.env`):

```bash
docker compose --profile agents up -d
```

Rebuild the jf-ai-dlc images after changing `overlay/` code:

```bash
docker compose build dynamo-pg       # rebuilds the shared jf-ai-dlc-services image
docker compose build frontend        # rebuilds jf-ai-dlc-frontend
docker compose up -d --force-recreate
```

### Host port map

Web UI `:8088` · API `:3001` · WebSocket `:3002` · Keycloak `:8081`
(admin/admin) · dynamo-pg `:8000` · Gremlin `:8182` · SeaweedFS S3 `:8333` ·
yjs `:1234` · Postgres `:5433`.

Default logins (from the imported realm): `alice` / `password` (regular user),
`admin` / `admin` (platform admin).
