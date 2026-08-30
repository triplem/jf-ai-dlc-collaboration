# Modifying upstream — the patch workflow

`upstream/collab/` is a **pristine `git subtree` vendor** of
[sample-collaborative-ai-dlc](https://github.com/aws-samples/sample-collaborative-ai-dlc).
The README says it plainly: **never hand-edit it.** Keeping it byte-for-byte
identical to the vendor is what lets `scripts/update-upstream.sh` pull a newer
version with a clean 3-way merge.

Every local change to upstream code therefore lives as a **numbered patch** in
`overlay/patches/`, applied **at image build time** — never committed into
`upstream/`.

## How patches are applied

Nothing applies them into your working tree. The Docker builds do it in a first
stage, onto a throwaway copy of the pristine subtree:

```dockerfile
FROM node:22-alpine AS upstream-patched
RUN apk add --no-cache git
WORKDIR /src
COPY upstream/collab/lambda upstream/collab/lambda
COPY overlay/patches overlay/patches
RUN for p in overlay/patches/*.patch; do git apply "$p"; done
# later stages COPY --from=upstream-patched the patched files
```

- `deploy/compose/Dockerfile.services` — api-router, ws-gateway, aws-shim, dynamo-pg, session-runner
- `overlay/agentcore/Dockerfile` — agentcore
- `overlay/yjs-server/Dockerfile` — yjs-server (the upstream yjs Dockerfile can't be edited, so this overlay one builds from the patched sources)

`scripts/apply-patches.sh` is the same loop for local use, and
`scripts/update-upstream.sh` runs `git apply --check` on every patch after a
subtree pull so a patch that no longer applies is caught at update time.

Patches apply in filename order (`0001`, `0002`, …), each on top of the previous
— so a later patch may depend on an earlier one.

## Creating a new patch

The trick: stage the *existing* patched state, then diff your change against it,
so the new patch contains **only** your change (not the whole stack).

```bash
# 0. start from a clean tree (upstream/ pristine)
git status --porcelain        # should be empty

# 1. apply the existing patches into the working tree, then stage them so the
#    next diff is isolated to YOUR change
scripts/apply-patches.sh
git add upstream/collab

# 2. make your edit to the upstream file(s)
$EDITOR upstream/collab/lambda/<...>.js

# 3. write the new patch = the unstaged diff (only your change)
git diff upstream/collab > overlay/patches/0005-short-description.patch

# 4. restore upstream to pristine (discard the applied stack + your edit from
#    the tree — the change now lives only in the patch file)
git checkout HEAD -- upstream/collab
git restore --staged upstream/collab   # (git reset HEAD upstream/collab on older git)

# 5. verify the whole series still applies cleanly on pristine
for p in overlay/patches/*.patch; do git apply --check "$p" || echo "FAILS: $p"; done

# 6. build + smoke, then commit ONLY the patch file
cd deploy/compose && docker compose build && docker compose up -d
git add overlay/patches/0005-short-description.patch
git commit -m "fix(<area>): <what> (patch 0005)"
```

Only `overlay/patches/0005-*.patch` is committed — `upstream/` stays pristine.

## Refreshing a patch after an upstream bump

`update-upstream.sh` fails if a patch no longer applies. To refresh it:

```bash
# apply the patches BEFORE the failing one, then apply the failing one 3-way to
# get conflict markers, resolve, and re-diff exactly as in "Creating a new patch"
scripts/apply-patches.sh || true          # applies up to the conflict
git add upstream/collab
git apply --3way overlay/patches/000N-*.patch   # resolve any <<<< markers
$EDITOR <conflicted files>
git diff upstream/collab > overlay/patches/000N-*.patch
git checkout HEAD -- upstream/collab && git restore --staged upstream/collab
```

## Rules of thumb

- **Never** commit changes under `upstream/collab/` — CI/readers treat it as the
  pristine vendor. If `git status` shows modified `upstream/` files, you forgot
  step 4.
- Prefer an **overlay** over a patch when a whole file/service can be replaced
  cleanly (e.g. `overlay/ws-gateway/server.mjs` replaces the upstream WS
  authorizer, `overlay/aws-shim` replaces the AWS SDK endpoints). Patch upstream
  only for small in-place edits where duplicating the whole file would be worse.
- Keep each patch **small and single-purpose**, with a descriptive filename —
  it's the whole audit trail for that change.
