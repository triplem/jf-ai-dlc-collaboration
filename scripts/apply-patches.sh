#!/usr/bin/env bash
# Apply overlay/patches/*.patch onto the pristine upstream/collab subtree.
#
# upstream/collab is a git-subtree vendor kept PRISTINE (README: "never
# hand-edit"). Every local modification to upstream lives as a numbered patch
# under overlay/patches/ and is applied here — at image build time (the
# Dockerfiles call this) and by update-upstream.sh to verify patches still
# apply after a subtree bump. See docs/patches.md for the authoring workflow.
#
# Usage: scripts/apply-patches.sh [root]   (root defaults to the repo root)
set -euo pipefail

root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$root"

shopt -s nullglob
patches=(overlay/patches/*.patch)
if [ ${#patches[@]} -eq 0 ]; then
  echo "apply-patches: no patches under overlay/patches/"
  exit 0
fi

for p in "${patches[@]}"; do
  echo "  applying ${p}"
  # git apply works on plain files (no repo required), honours a/ b/ prefixes,
  # and fails loudly (non-zero) if a patch no longer applies to pristine upstream.
  git apply "${p}"
done
echo "apply-patches: applied ${#patches[@]} patch(es)"
