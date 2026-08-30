# Updating the upstream

The Collaborative AI-DLC platform releases regularly. This repo is structured so
pulling a newer version is a single scripted step that re-derives everything
downstream.

## The vendoring model

The platform is vendored with **`git subtree --squash`**:

```
upstream/collab/            # aws-samples/sample-collaborative-ai-dlc
```

**Never hand-edit anything under `upstream/`.** All local code lives outside it:

- `overlay/` — the adapter services (dynamo-pg, api-router, ws-gateway,
  aws-shim + durable, session-runner, bootstrap, frontend, agentcore, oracle).
  These wrap the upstream code by endpoint/config, not by editing it.
- `overlay/patches/*.patch` — the rare, unavoidable in-tree edits, applied on
  top of the subtree after every pull (currently: the direct-Anthropic driver
  patch).

Because the diff against upstream is confined to `overlay/`, an update is mostly
"pull the new subtree and regenerate the derived artifacts." The exact pinned
ref and commit are in [`../UPSTREAM_VERSIONS.md`](../UPSTREAM_VERSIONS.md)
(today: `collab` @ `v2.0.0`).

> The AI-DLC methodology plugin (`awslabs/aidlc-workflows`) is updated
> separately in the sibling repo [jf-ai-dlc](../../jf-ai-dlc).

## The update command

```bash
scripts/update-upstream.sh            # re-sync the current ref (no-op drill)
scripts/update-upstream.sh <ref>      # bump collab to a branch/tag
```

It requires a **clean working tree** (commit or stash first) and, in order:

1. **`git subtree pull --squash`** `upstream/collab` at the requested ref
   (defaults to the current pin read from `UPSTREAM_VERSIONS.md`).
2. **Re-applies `overlay/patches/*.patch`** with `git apply --3way`. On a
   conflict it **fails loudly**, naming the patch — see below.
3. **Regenerates the terraform-derived artifacts**: `scripts/gen-routes.mjs`
   (→ `overlay/api-router/routes.json`) and `scripts/gen-tables.mjs`
   (→ `overlay/bootstrap/tables.json`), so new API routes and DynamoDB tables
   come across automatically.
4. **Runs the dynamo-pg + durable protocol test suites** as a fast sanity gate.
5. **Refreshes `UPSTREAM_VERSIONS.md`** with the new commit and date.

It then prints a checklist:

```
1. review the changes:            git diff --cached
2. run the oracle suite:          cd upstream/collab && npm ci && npx vitest run -c ../../overlay/oracle/vitest.config.js
3. rebuild + smoke the stack:     cd deploy/compose && docker compose build && docker compose up -d
4. commit:                        git commit -m "Update upstream/collab to <ref>"
```

The **oracle** (step 2) is the important gate: it runs the upstream project's
own vitest suite against the OSS substitutions (dynamo-pg + Gremlin Server), so
a passing run proves the new upstream still works on this stack.

## The no-op drill

Run `scripts/update-upstream.sh` with **no arguments** (re-pinning the same
ref) at any time. It must produce **zero diff** — that proves the whole
regenerate pipeline is deterministic before you attempt a real version bump. If
it's not a no-op, fix that first.

## Handling a patch conflict

If step 2 reports a conflict, an entry in `overlay/patches/` no longer applies
because upstream changed the code it patched. Resolve it manually against the
newly pulled `upstream/collab/**`, regenerate the `.patch` from the fixed tree,
and re-run the update. A whole-file overlay (like the frontend auth swap, which
is a Vite-time module redirect rather than a patch) doesn't go through this path.
