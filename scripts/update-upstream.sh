#!/usr/bin/env bash
# Update the vendored collaboration platform upstream and regenerate everything
# derived from it.
#
#   scripts/update-upstream.sh                  # re-sync the current ref (no-op drill)
#   scripts/update-upstream.sh <ref>            # bump sample-collaborative-ai-dlc
#
# Steps: git subtree pull → apply overlay/patches/*.patch (fails loudly on
# conflict) → regen routes/tables → run the dynamo-pg + durable suites → refresh
# UPSTREAM_VERSIONS.md. Review `git log`/`git diff` afterwards and run the oracle
# (upstream vitest via overlay/oracle) before merging.
#
# The AI-DLC methodology plugin (awslabs/aidlc-workflows) lives in the sibling
# repo jf-ai-dlc — this repo only vendors the collaboration platform.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

COLLAB_REPO=https://github.com/aws-samples/sample-collaborative-ai-dlc.git

# current ref from UPSTREAM_VERSIONS.md
current_ref() { grep "$1" UPSTREAM_VERSIONS.md | sed -E 's/.*\| `([^`]+)` \(.*/\1/'; }
collab_ref="$(current_ref 'upstream/collab')"
[[ $# -gt 0 ]] && collab_ref="$1"

[[ -z "$(git status --porcelain)" ]] || { echo "working tree not clean — commit or stash first" >&2; exit 1; }

echo "==> subtree pull collab @ ${collab_ref}"
git subtree pull --prefix=upstream/collab "$COLLAB_REPO" "$collab_ref" --squash \
  -m "Update upstream/collab to ${collab_ref}"

echo "==> apply overlay patches"
shopt -s nullglob
for patch in overlay/patches/*.patch; do
  echo "  applying ${patch}"
  if ! git apply --3way "$patch"; then
    echo "PATCH CONFLICT: ${patch} no longer applies — upstream changed the patched code." >&2
    echo "Resolve manually, refresh the patch, and re-run." >&2
    exit 1
  fi
done

echo "==> regenerate derived artifacts"
node scripts/gen-routes.mjs
node scripts/gen-tables.mjs

echo "==> dynamo-pg adapter tests"
(cd overlay/dynamo-pg && npm test)

echo "==> durable-execution protocol tests"
(cd overlay/durable && npm test)

echo "==> refresh UPSTREAM_VERSIONS.md"
today="$(date +%F)"
collab_sha="$(git log --grep="git-subtree-dir: upstream/collab$" --format=%b -1 | sed -n 's/.*git-subtree-split: //p' | head -1)"
COLLAB_SHA="$collab_sha" TODAY="$today" COLLAB_REF="$collab_ref" node -e '
  const fs = require("fs");
  const out = fs.readFileSync("UPSTREAM_VERSIONS.md", "utf8").split("\n").map((line) =>
    line.includes("`upstream/collab`")
      ? line.replace(/\| `[^`]*` \([^)]*\) \| `[0-9a-f]*` \| [0-9-]* \|$/,
          `| \`${process.env.COLLAB_REF}\` (tag) | \`${process.env.COLLAB_SHA}\` | ${process.env.TODAY} |`)
      : line,
  ).join("\n");
  fs.writeFileSync("UPSTREAM_VERSIONS.md", out);
'

git add -A
git status --short | head -20
cat <<EOF

Done. Next steps:
  1. review the changes:            git diff --cached
  2. run the oracle suite:          cd upstream/collab && npm ci && npx vitest run -c ../../overlay/oracle/vitest.config.js
  3. rebuild + smoke the stack:     cd deploy/compose && docker compose build && docker compose up -d
  4. commit:                        git commit -m "Update upstream/collab to ${collab_ref}"
EOF
