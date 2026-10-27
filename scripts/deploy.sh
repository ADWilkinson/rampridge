#!/usr/bin/env bash
# Deploys the committed HEAD to Vercel production from a clean export, so
# uncommitted local work never ships and no git metadata is attached.
#
# The game assets decoded from the OSRS cache (public/game, the og*.png link
# previews) are Jagex's and not in git, so `git archive` leaves them out. They
# are copied in from this checkout, and only if every file HEAD's
# scripts/bake/assets.lock.json lists is present and byte-identical and the
# lock agrees with HEAD's code; otherwise nothing is deployed. They are
# gitignored, so they never count as a dirty tree.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty; commit first (only HEAD is deployed)." >&2
  exit 1
fi
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
git archive HEAD | tar -x -C "$out"
bun scripts/assets.ts copy "$out"
mkdir -p "$out/.vercel"
cp .vercel/project.json "$out/.vercel/project.json"
revision=$(git rev-parse HEAD)
echo "Deploying ${revision:0:12} to production..."
# .vercel/project.json names the team; VERCEL_SCOPE overrides it for a CLI logged in elsewhere.
(cd "$out" && vercel deploy --prod --yes --env "RAMPRIDGE_RELEASE_SHA=$revision" ${VERCEL_SCOPE:+--scope "$VERCEL_SCOPE"})
