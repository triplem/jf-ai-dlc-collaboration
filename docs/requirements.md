# Requirements & dependencies

Everything this platform needs falls into two groups: **host tooling** you
install on the machine that builds and drives the stack, and the **runtime
services/images** the stack itself is made of. All runtime substitutions are
OSI-approved OSS — that is the whole point (see [Why this project
exists](why.md)).

## Host tooling

Install these on the build/operate machine.

| Tool | Version | Why it's needed | Homepage | License |
|---|---|---|---|---|
| Docker + Docker Compose | current | Build and run the whole test stack (`deploy/compose`) and the images. | https://www.docker.com | Apache-2.0 (Engine) |
| Node.js | 22.x | Runs the `overlay/` services, the `scripts/*.mjs` generators, and the test suites; also the container base image. | https://nodejs.org | MIT / others |
| Helm + kubectl | Helm 3.x | Production deploy of the chart in `deploy/helm/jf-ai-dlc`. Not needed for the Compose stack. | https://helm.sh | Apache-2.0 |
| git | current | The upstream is vendored via `git subtree`; updates use it (see [Updating the upstream](upstream-updates.md)). | https://git-scm.com | GPL-2.0 |

(No Bun on the host — the agentcore image installs its own; the AI-DLC plugin
build that needs Bun lives in the sibling repo [jf-ai-dlc](../../jf-ai-dlc).)

## Runtime services / images (the Compose stack)

These are pulled or built by `deploy/compose/docker-compose.yml`. Each replaces
an AWS managed service; the full mapping is in the root
[`README.md`](../README.md). See [Docker images & Compose](docker.md) for how
each one is wired.

| Component | Image / version | Replaces (AWS) | Homepage | License |
|---|---|---|---|---|
| PostgreSQL | `postgres:17-alpine` | Backing store for dynamo-pg (DynamoDB) and aws-shim (SSM/Secrets + durable execution) | https://www.postgresql.org | PostgreSQL License |
| Apache TinkerPop Gremlin Server | `tinkerpop/gremlin-server:3.7.3` | Neptune (graph / traceability) — dev/test | https://tinkerpop.apache.org | Apache-2.0 |
| JanusGraph | (prod, via its own chart) | Neptune (graph) — production, Gremlin-compatible | https://janusgraph.org | Apache-2.0 |
| SeaweedFS | `chrislusf/seaweedfs:3.80` | S3 (artifacts, attachments) via its S3 API | https://github.com/seaweedfs/seaweedfs | Apache-2.0 |
| Keycloak | `quay.io/keycloak/keycloak:26.3` | Cognito (OIDC auth + admin user management) | https://www.keycloak.org | Apache-2.0 |
| nginx | `nginx:1.27-alpine` | CloudFront + S3 static hosting (serves the SPA) | https://nginx.org | BSD-2-Clause |
| Node.js (base) | `node:22-alpine` / `node:24-slim` | Lambda/Fargate compute (base for the overlay services + agentcore images) | https://nodejs.org | MIT / others |

The jf-ai-dlc-authored images (`jf-ai-dlc-services`, `jf-ai-dlc-frontend`,
`jf-ai-dlc-agentcore`) and the Compose-built upstream image (`yjs-server`) are
described in [Docker images & Compose](docker.md).

## Optional — agent execution & inference

Running actual agent stages (the `--profile agents` path) needs model
inference. This stack uses **direct provider APIs**:

- `ANTHROPIC_API_KEY` — Claude Code agent driver (the default in this port).
- `OPENAI_API_KEY` — Codex agent driver.

Set them in `deploy/compose/.env` before `docker compose --profile agents up`.
The model/auth resolution is env-driven, so a **LiteLLM** gateway can be adopted
later (point the agent CLI base-URL envs at it) with no code change. See
[Running an agent stage](running-an-agent-stage.md).

## Pinned upstream version

The vendored upstream and its exact commit are recorded in
[`../UPSTREAM_VERSIONS.md`](../UPSTREAM_VERSIONS.md). It is consumed as source
(vendored under `upstream/collab/`), not installed as a package.
