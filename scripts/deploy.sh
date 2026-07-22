#!/bin/bash
set -e

# ANSI theme colors
RESET="\033[0m"
BOLD="\033[1m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
BLUE="\033[34m"

export PATH="/usr/local/n/versions/node/24.11.1/bin:/usr/local/lib/node_modules/corepack/shims:/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"

BUCKET="everygrid-823624329122-ap-northeast-2-an"
DIST_ID="E3PAL1L8WK3ZZ7"
CDN_BASE="https://d3886c7yrxubj8.cloudfront.net"

GRID_DIR="packages/everygrid"
WASM_DIR="everygrid-wasm/pkg"

VERSION=$(node -e "console.log(require('./packages/everygrid/package.json').version)")

echo -e "\n${BOLD}${CYAN}🚀 Start Deploying Everygrid v${VERSION}${RESET}\n"

# -------------------------------------------------------------
echo -e "${BLUE}📦 [1/6] Preparing temp staging...${RESET}"
PACK_TMP=$(mktemp -d)
OUT_TMP="$PACK_TMP/artifacts"
GRID_STAGE="$PACK_TMP/grid"
mkdir -p "$OUT_TMP" "$GRID_STAGE/package"

# -------------------------------------------------------------
echo -e "${BLUE}⚙️  [2/6] Isolating grid package & injecting WASM...${RESET}"
WASM_TGZ=$(cd "$WASM_DIR" && npm pack --pack-destination "$OUT_TMP" | tail -1)

rsync -a --delete --exclude "node_modules" --exclude "demo" "$GRID_DIR/" "$GRID_STAGE/package/"

node -e "
const fs=require('fs');
const pkg=JSON.parse(fs.readFileSync('$GRID_STAGE/package/package.json'));
pkg.name='@everygrid/grid';
// The workspace's runtime deps must NOT survive into the tarball. They carried
// 'everygrid-wasm': 'link:../../everygrid-wasm/pkg' — a workspace path that exists on no
// consumer's disk, so \`npm install <tarball>\` died with EUNSUPPORTEDPROTOCOL before it
// unpacked anything. They also dragged vite/rollup in as runtime deps. Nothing is needed:
// the standalone build that exports points at inlines the WASM, the worker, and the CSS.
pkg.dependencies={};
// peerDependencies stay as the source declares them (react/react-dom): the emitted
// dist/src/*.d.ts reference 'react', so wiping them left consumers' types unresolvable.
delete pkg.devDependencies;
pkg.main='./dist/everygrid.standalone.js';
pkg.module='./dist/everygrid.standalone.js';
pkg.exports={
  '.': { types: './dist/index.d.ts', import: './dist/everygrid.standalone.js', default: './dist/everygrid.standalone.js' },
  './css': './dist/Everygrid.css'
};
fs.writeFileSync('$GRID_STAGE/package/package.json', JSON.stringify(pkg, null, 2));
"

mkdir -p "$GRID_STAGE/package/dist/wasm" "$PACK_TMP/wasm"
tar -xzf "$OUT_TMP/$WASM_TGZ" -C "$PACK_TMP/wasm"
cp "$PACK_TMP"/wasm/package/*wasm "$GRID_STAGE/package/dist/wasm/" 2>/dev/null || true
cp "$PACK_TMP"/wasm/package/*.js "$GRID_STAGE/package/dist/wasm/" 2>/dev/null || true

printf 'export * from "./src/index";\nexport { default } from "./src/index";' > "$GRID_STAGE/package/dist/index.d.ts"

# -------------------------------------------------------------
echo -e "${BLUE}🔒 [3/6] Generating tarball...${RESET}"
BUNDLE_TGZ=$(cd "$GRID_STAGE/package" && npm pack --quiet | tail -1)
mv "$GRID_STAGE/package/$BUNDLE_TGZ" "$OUT_TMP/staged.tgz"

# Published artifacts are named for a hash of their own bytes, so their URL is immutable. A
# fixed URL whose content changes every deploy is what a registry never does, and for good
# reason: pnpm keys both its lockfile resolution and its content-addressed store by integrity,
# so it happily serves the previous deploy's copy and the install verifies nothing. (Observed:
# a lockfile integrity matching no object the CDN was serving.) A new URL per build can't collide.
#
# The version alongside it is a compatibility promise for humans, not a build identity — see
# CLAUDE.md. It only moves when the public API does, so repeat deploys of one version are fine.
sha12() {
  node -e "
const c=require('crypto'), f=require('fs');
console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex').slice(0,12));
" "$1"
}
INT_TGZ_NAME="everygrid-grid-$VERSION-$(sha12 "$OUT_TMP/staged.tgz").tgz"
mv "$OUT_TMP/staged.tgz" "$OUT_TMP/$INT_TGZ_NAME"
echo -e "   ${YELLOW}▪ Tarball:${RESET} $INT_TGZ_NAME"

# -------------------------------------------------------------
echo -e "${BLUE}☁️  [4/6] Uploading core package assets to Amazon S3...${RESET}"
# Every artifact is published in two shapes, the way a registry serves one:
#
#   /packages/<name>-<version>-<hash>   immutable. Cached forever, never overwritten. What a
#                                       consumer pins, and what a lockfile's integrity can trust.
#   /latest/<name>                      a mutable pointer at the newest build, for anyone who
#                                       wants rolling updates. `no-cache` (not no-store) so a
#                                       browser still gets a cheap 304 while never running a
#                                       stale copy — a CloudFront invalidation cannot reach
#                                       browser caches, so the URL cannot be cached blind.
#
# Note what is NOT here: a versioned-but-mutable /latest/everygrid.standalone-$VERSION.js. That
# name promises 0.1.0 while its bytes change under it, which is the same lie the tarball told.
CACHE_IMMUTABLE="public, max-age=31536000, immutable"
CACHE_LATEST="no-cache"
# Mutable shells (HTML, config/data JSON). `no-cache` = store but revalidate every load, so a
# fresh deploy's index.html and everygrid-config.json are picked up on the next visit instead of a
# browser serving last deploy's shell against this deploy's hashed assets. Without it the shells
# get heuristic caching and a shipped change stays invisible until a hard refresh — which is
# exactly how a newly added grid target went missing after deploy.
CACHE_MUTABLE="no-cache"

aws s3 cp "$OUT_TMP/$INT_TGZ_NAME" "s3://$BUCKET/packages/$INT_TGZ_NAME" --content-type "application/gzip" --cache-control "$CACHE_IMMUTABLE" --quiet

STANDALONE_JS="$GRID_STAGE/package/dist/everygrid.standalone.js"
[ -f "$STANDALONE_JS" ] || { echo -e "   ${YELLOW}✗ dist/everygrid.standalone.js missing — run \`pnpm build\`${RESET}"; exit 1; }
STANDALONE_NAME="everygrid.standalone-$VERSION-$(sha12 "$STANDALONE_JS").js"
aws s3 cp "$STANDALONE_JS" "s3://$BUCKET/packages/$STANDALONE_NAME" --content-type "application/javascript" --cache-control "$CACHE_IMMUTABLE" --quiet
aws s3 cp "$STANDALONE_JS" "s3://$BUCKET/latest/everygrid.standalone.js" --content-type "application/javascript" --cache-control "$CACHE_LATEST" --quiet
echo -e "   ${GREEN}✓${RESET} Published $INT_TGZ_NAME"
echo -e "   ${GREEN}✓${RESET} Published $STANDALONE_NAME + latest/everygrid.standalone.js"

aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/latest/*" > /dev/null

# -------------------------------------------------------------
echo -e "${BLUE}📥 [5/6] Installing the published tarball as a real dependency...${RESET}"
# demo/portal declares @everygrid/grid by its CDN tarball URL rather than workspace:*, so
# this install is what proves the published package resolves, unpacks, and exposes its API
# the same way it will for anyone else. A packaging bug that the workspace hides — a stray
# workspace-only dependency, a bad exports map, a file missing from `files` — fails here
# instead of shipping green.
TGZ_URL="$CDN_BASE/packages/$INT_TGZ_NAME"

# This URL has never existed before, so nothing can have it cached and the first request
# must reach the origin. Still poll for it: the upload is only just consistent, and
# resolving a 403/404 into a confusing pnpm error helps nobody.
echo -e "   ${YELLOW}▪ Waiting for CDN:${RESET} $TGZ_URL"
# `if` rather than `curl … && break`: under `set -e` a bare failing pipeline as the last
# command of the loop body aborts the whole script, and the first poll may well fail.
for i in $(seq 1 30); do
  if curl -sf "$TGZ_URL" | cmp -s - "$OUT_TMP/$INT_TGZ_NAME"; then break; fi
  if [ "$i" = 30 ]; then echo -e "   ${YELLOW}✗ CDN never served $INT_TGZ_NAME (60s)${RESET}"; exit 1; fi
  sleep 2
done

# Point the demo at the build we just published. This rewrites a tracked file on every
# deploy that changes the library — the same bookkeeping as bumping a dependency after an
# npm publish, and it belongs in the commit.
node -e "
const fs=require('fs');
const p='demo/portal/package.json';
const pkg=JSON.parse(fs.readFileSync(p));
pkg.dependencies['@everygrid/grid']='$TGZ_URL';
fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\n');
"
pnpm install --no-frozen-lockfile --silent

# The html demos pin the immutable build rather than the rolling pointer: a demo should show
# the code it was deployed with, not silently drift onto the next deploy's library.
export EVERYGRID_CDN="$CDN_BASE/packages/$STANDALONE_NAME"
echo -e "   ${YELLOW}▪ React demo bundles:${RESET} $INT_TGZ_NAME (installed from CDN)"
echo -e "   ${YELLOW}▪ html demos load:${RESET}    $EVERYGRID_CDN"

# -------------------------------------------------------------
echo -e "${BLUE}🖥️  [6/6] Building & deploying unified demo portal...${RESET}"
(cd demo/portal && tsc -b && vite build) > /dev/null

DEMO_STAGE="$PACK_TMP/site"
mkdir -p "$DEMO_STAGE"
cp -r demo/portal/dist/* "$DEMO_STAGE/"

find "$DEMO_STAGE" -name "node_modules" -type d -exec rm -rf {} +
# NOTE: deploy does NOT manage the /data/* objects (e.g. the multi-GB
# large_table_data.json served to the demo) or their CORS — those are uploaded
# and configured out-of-band. The excludes below keep `--delete` from wiping
# them; removing an exclude here would DELETE those objects on the next deploy.
# /packages/* must be excluded for a different reason: those tarballs are immutable
# published versions that lockfiles still resolve by URL, so deleting one breaks
# `pnpm install` for every commit that pinned it — including the one deployed here.
#
# Two passes, because the cache policy differs by file kind:
#   1. assets/  — Vite's content-hashed JS/CSS. The hash IS the version, so cache forever.
#      Synced first, without --delete: an index.html a browser still holds from a previous deploy
#      references the old hash, so old assets must linger (same reasoning as /packages/* tarballs).
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