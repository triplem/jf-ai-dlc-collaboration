# Pinned upstream version

<!-- machine-readable: do not change the table structure; scripts/update-upstream.sh rewrites it -->

| Prefix | Upstream | Ref | Commit | Vendored |
|---|---|---|---|---|
| `upstream/collab` | https://github.com/aws-samples/sample-collaborative-ai-dlc | `v2.0.0` (tag) | `4d24d7174ae53d790e593486f2128f15ee75136f` | 2026-08-30 |

`upstream/collab` is a `git subtree --squash` vendor. Never hand-edit it — local
changes live in `overlay/` (adapters) and `overlay/patches/` (unavoidable in-tree
diffs, re-applied on every update).

To update, run `scripts/update-upstream.sh` (see README).

The AI-DLC methodology plugin (`awslabs/aidlc-workflows`) is vendored in the
sibling repo **[jf-ai-dlc](../jf-ai-dlc)** — this repo only vendors the
collaboration platform.
