// Bump packages/everygrid/package.json — the single source of truth for the published
// version. See CLAUDE.md "Versioning" for which position to move and why.
//
// Neither packaged bumper works here: `npm version` writes the file and then dies on this
// pnpm workspace ("Cannot read properties of null"), leaving the bump half-applied, and
// `pnpm version` refuses to run at all unless the working tree is clean.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const RELEASE_TYPES = ['patch', 'minor', 'major'];
const release = process.argv[2];

if (!RELEASE_TYPES.includes(release)) {
  console.error(`usage: node scripts/version.js <${RELEASE_TYPES.join('|')}>`);
  process.exit(1);
}

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/everygrid/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version);
if (!parsed) {
  console.error(`refusing to bump: ${pkg.version} is not a plain x.y.z version`);
  process.exit(1);
}
const [major, minor, patch] = parsed.slice(1).map(Number);

const next = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
}[release];

writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: next }, null, 2) + '\n');
console.log(`@everygrid/grid  ${pkg.version} -> ${next}`);

if (major === 0 && release === 'major') {
  console.log('\nNote: 1.0.0 declares the public API frozen. If you only meant "this breaks\n' +
    'something", that is a minor bump while at 0.x — see CLAUDE.md "Versioning".');
}
