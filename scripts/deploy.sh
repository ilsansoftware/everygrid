#!/bin/bash
set -e

# ANSI theme colors
RESET="\033[0m"
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
BLUE="\033[34m"

for cmd in aws node pnpm; do
  if ! command -v "$cmd" > /dev/null 2>&1; then
    echo "deploy.sh: '$cmd' not found on PATH" >&2; exit 1
  fi
done

# BUCKET / DIST_ID live in an untracked scripts/deploy.env (template: scripts/deploy.env.example).
DEPLOY_ENV="$(dirname "$0")/deploy.env"
if [ -f "$DEPLOY_ENV" ]; then
  # shellcheck source=/dev/null
  . "$DEPLOY_ENV"
fi
if [ -z "${BUCKET:-}" ] || [ -z "${DIST_ID:-}" ]; then
  echo "deploy.sh: BUCKET and DIST_ID must be set — copy scripts/deploy.env.example to scripts/deploy.env and fill it in" >&2
  exit 1
fi

# The library itself ships through npm (scripts/publish-npm.sh) — this deploys only the demo site,
# built against that npm release exactly as an outside consumer gets it: the React demo installs
# @everygrid/grid@<version> from the registry, the html demos load the same version from jsDelivr
# (demo/portal/vite.config.ts). So publish first, then deploy.
VERSION=$(node -e "console.log(require('./packages/everygrid/package.json').version)")
JSDELIVR_URL="https://cdn.jsdelivr.net/npm/@everygrid/grid@$VERSION/dist/everygrid.standalone.js"

echo -e "\n${BOLD}${CYAN}🚀 Start Deploying Everygrid demo (v${VERSION})${RESET}\n"

# Mutable shells (HTML, config/data JSON). `no-cache` = store but revalidate every load, so a
# fresh deploy's index.html and everygrid-config.json are picked up on the next visit instead of a
# browser serving last deploy's shell against this deploy's hashed assets. Without it the shells
# get heuristic caching and a shipped change stays invisible until a hard refresh — which is
# exactly how a newly added grid target went missing after deploy.
CACHE_IMMUTABLE="public, max-age=31536000, immutable"
CACHE_MUTABLE="no-cache"

# -------------------------------------------------------------
echo -e "${BLUE}🔎 [1/3] Checking the npm release...${RESET}"
# Fail here, not halfway through a pnpm install: a version bump that was never published would
# otherwise surface as a confusing ERR_PNPM_NO_MATCHING_VERSION.
if ! npm view "@everygrid/grid@$VERSION" version > /dev/null 2>&1; then
  echo -e "   ${YELLOW}✗ @everygrid/grid@$VERSION is not on npm — run scripts/publish-npm.sh first${RESET}"; exit 1
fi
# jsDelivr fetches from npm on first request; poll so the html demos never deploy against a 404.
# `if` rather than `curl … && break`: under `set -e` a bare failing command as the last
# statement of the loop body aborts the whole script, and the first poll may well fail.
for i in $(seq 1 30); do
  if curl -sfo /dev/null "$JSDELIVR_URL"; then break; fi
  if [ "$i" = 30 ]; then echo -e "   ${YELLOW}✗ jsDelivr never served $JSDELIVR_URL (60s)${RESET}"; exit 1; fi
  sleep 2
done
echo -e "   ${GREEN}✓${RESET} @everygrid/grid@$VERSION on npm + jsDelivr"

# -------------------------------------------------------------
echo -e "${BLUE}📥 [2/3] Installing the npm release as a real dependency...${RESET}"
# This install is what proves the published package resolves, unpacks, and exposes its API
# the same way it will for anyone else. A packaging bug that the workspace hides — a stray
# workspace-only dependency, a bad exports map, a file missing from `files` — fails here
# instead of shipping green. Rewrites a tracked file when the version moved; commit it.
node -e "
const fs=require('fs');
const p='demo/portal/package.json';
const pkg=JSON.parse(fs.readFileSync(p));
pkg.dependencies['@everygrid/grid']='$VERSION';
fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\n');
"
pnpm install --no-frozen-lockfile --silent
echo -e "   ${YELLOW}▪ React demo bundles:${RESET} @everygrid/grid@$VERSION (npm)"
echo -e "   ${YELLOW}▪ html demos load:${RESET}    $JSDELIVR_URL"

# -------------------------------------------------------------
echo -e "${BLUE}🖥️  [3/3] Building & deploying unified demo portal...${RESET}"
(cd demo/portal && tsc -b && vite build) > /dev/null

DEMO_STAGE="$(mktemp -d)/site"
mkdir -p "$DEMO_STAGE"
cp -r demo/portal/dist/* "$DEMO_STAGE/"

find "$DEMO_STAGE" -name "node_modules" -type d -exec rm -rf {} +
# NOTE: deploy does NOT manage the /data/* objects (e.g. the multi-GB
# large_table_data.json served to the demo) or their CORS — those are uploaded
# and configured out-of-band. The excludes below keep `--delete` from wiping
# them; removing an exclude here would DELETE those objects on the next deploy.
# /packages/* and /latest/* must be excluded for a different reason: they hold the tarballs and
# standalone builds this bucket served before the move to npm. Nothing new goes there, but
# lockfiles of older commits still resolve those tarballs by URL, so deleting one breaks
# `pnpm install` for every commit that pinned it.
#
# Two passes, because the cache policy differs by file kind:
#   1. assets/  — Vite's content-hashed JS/CSS. The hash IS the version, so cache forever.
#      Synced first, without --delete: an index.html a browser still holds from a previous deploy
#      references the old hash, so old assets must linger (same reasoning as the /packages/* tarballs).
#   2. everything else — index.html and the config/data JSON. These are mutable shells at stable
#      URLs; they carry no-cache so a browser revalidates them and a deploy is seen immediately.
#      --delete prunes removed shells; assets/ is excluded so pass 1's immutable headers survive.
aws s3 sync "$DEMO_STAGE/assets/" "s3://$BUCKET/assets/" --cache-control "$CACHE_IMMUTABLE" --quiet
aws s3 sync "$DEMO_STAGE/" "s3://$BUCKET/" --delete --cache-control "$CACHE_MUTABLE" \
  --exclude "assets/*" --exclude "latest/*" --exclude "data/*" --exclude "packages/*" --quiet

# Invalidate only what this deploy actually uploaded, derived from the staged site so
# new top-level entries are covered automatically. A blanket "/*" would also flush
# /data/*, and since Origin is neither forwarded to S3 nor part of the cache key, whichever
# request repopulates that cache decides whether the stored response carries CORS headers —
# which is how every deploy used to break CORS on the out-of-band data objects.
INVALIDATION_PATHS=("/")
while IFS= read -r entry; do
  name=$(basename "$entry")
  if [ -d "$entry" ]; then
    INVALIDATION_PATHS+=("/$name/*")
  else
    INVALIDATION_PATHS+=("/$name")
  fi
done < <(find "$DEMO_STAGE" -mindepth 1 -maxdepth 1)

echo -e "   ${YELLOW}▪ Invalidating:${RESET} ${INVALIDATION_PATHS[*]}"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "${INVALIDATION_PATHS[@]}" > /dev/null

# -------------------------------------------------------------
echo -e "\n${BOLD}${GREEN}✨ Deploy Complete Successfully!${RESET}\n"