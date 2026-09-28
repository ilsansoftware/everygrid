#!/bin/bash
# Stage a clean, consumer-installable @everygrid/grid tarball from the built workspace.
# Sourced by publish-npm.sh.
# Leaves: VERSION, PACK_TMP, OUT_TMP, GRID_STAGE, INT_TGZ_NAME (in $OUT_TMP), sha12().
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
// unpacked anything. They also dragged vite/rollup in as runtime deps. Nothing is needed at
// runtime — the WASM, worker and CSS ship as built assets under dist/.
pkg.dependencies={};
// peerDependencies stay as the source declares them (react/react-dom): the ES build externalizes
// React and the emitted dist/src/*.d.ts reference 'react', so wiping them breaks consumers.
delete pkg.devDependencies;
// Mirror the source package.json: '.' is the ES build (named exports + the useGrid React binding),
// './standalone' the self-contained UMD for <script> use. Forcing '.' to the standalone here (its
// default-only entry) is what left consumers' \`import { Everygrid, useGrid }\` undefined.
pkg.main='./dist/index.js';
pkg.module='./dist/index.js';
pkg.exports={
  '.': { types: './dist/src/index.d.ts', import: './dist/index.js' },
  './react': { types: './dist/src/react/index.d.ts', import: './dist/index.js' },
  './css': './dist/Everygrid.css',
  './standalone': './dist/everygrid.standalone.js'
};
fs.writeFileSync('$GRID_STAGE/package/package.json', JSON.stringify(pkg, null, 2));
"

mkdir -p "$GRID_STAGE/package/dist/wasm" "$PACK_TMP/wasm"
tar -xzf "$OUT_TMP/$WASM_TGZ" -C "$PACK_TMP/wasm"
cp "$PACK_TMP"/wasm/package/*wasm "$GRID_STAGE/package/dist/wasm/" 2>/dev/null || true
cp "$PACK_TMP"/wasm/package/*.js "$GRID_STAGE/package/dist/wasm/" 2>/dev/null || true

cp README.md LICENSE "$GRID_STAGE/package/"

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
