# jf-ai-dlc-collaboration documentation

**jf-ai-dlc-collaboration** re-hosts AWS's Collaborative AI-DLC platform on
strictly open-source components — Docker Compose for testing, Kubernetes for
production, no AWS dependency. It stands on the shoulders of the upstream project
and adds only an adapter/overlay layer around it; see
[Why this project exists](why.md).

> The AI-DLC methodology **plugin** for Claude Code and Codex lives in the
> sibling repo **[jf-ai-dlc](../../jf-ai-dlc)** — that's what end users install
> into their projects. This repo is the collaboration **platform**.

For the architecture overview, the full AWS→OSS mapping, and the enumerated
list of local adjustments, see the root [`README.md`](../README.md). These docs
go deeper on specific topics.

## Contents

| Doc | What it covers |
|---|---|
| [Why this project exists](why.md) | The problem it solves, and prominent credit to the upstream projects it builds on |
| [Requirements & dependencies](requirements.md) | Host tooling and runtime services needed to build and run, with versions, purposes, homepages, and licenses |
| [Updating the upstream](upstream-updates.md) | How to fetch a newer Collaborative AI-DLC version through the git-subtree + overlay pipeline |
| [Docker images & Compose](docker.md) | Every image (custom and third-party) and a service-by-service tour of the Compose stack |
| [Running an agent stage](running-an-agent-stage.md) | End-to-end: a greenfield intent → durable orchestrator → agentcore → Claude Code runs a stage → artifact in the graph |

## Quick links

- Root overview & AWS→OSS mapping: [`../README.md`](../README.md)
- Pinned upstream version: [`../UPSTREAM_VERSIONS.md`](../UPSTREAM_VERSIONS.md)
- Durable-execution protocol: [`../overlay/durable/PROTOCOL.md`](../overlay/durable/PROTOCOL.md)
- Collaborative AI-DLC (upstream): https://github.com/aws-samples/sample-collaborative-ai-dlc
- The AI-DLC plugin repo: [jf-ai-dlc](../../jf-ai-dlc)
