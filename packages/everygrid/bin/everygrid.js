#!/usr/bin/env node
// `npx @everygrid/grid init` — one-time setup: the entry file, everygrid.config.json, with no grids yet.
// `npx @everygrid/grid create-config <id>` — scaffold the two config files a grid reads (see README "Quick Start"):
//   <dir>/everygrid-config-<id>.json   the grid's own config (one target)
//   <dir>/everygrid.config.json        the entry file listing config files; created, or appended to
// Run by hand, never on install: it writes into the user's project, which an install step must not.
// Existing files are left alone (the entry file only gains the new path) unless --force.
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

const USAGE = `Usage:
  npx @everygrid/grid init [grid-id] [options]           set up everygrid.config.json (and a first grid)
  npx @everygrid/grid create-config [grid-id] [options]  add a grid config, registered in everygrid.config.json

  grid-id            id of the grid — and of the element it mounts into (default: my-grid)
  --data <file>      JSON rows to read the columns from (an array, or an object holding one);
                     the config then gets English column labels you can edit
  --dir <dir>        where to write (default: ./public if it exists, else .)
  --force            overwrite an existing grid config file
                     (init without a grid-id takes only --dir)
  -h, --help         show this help`;

function fail(message) {
  console.error(`everygrid: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {id: null, data: null, dir: null, force: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--force') opts.force = true;
    else if (a === '--data' || a === '--dir') {
      const v = argv[++i];
      if (!v) fail(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else if (!opts.id) opts.id = a;
    else fail(`unexpected argument ${a}`);
  }
  return opts;
}

/** `joinedDate` / `joined_date` / `joined-date` → `Joined Date`. */
function humanize(field) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bId\b/g, 'ID');
}

/** Field names in first-seen order, from the first rows of an array (or the first array in an object). */
function fieldsOf(file) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
  const rows = Array.isArray(json) ? json : Object.values(json ?? {}).find(Array.isArray);
  if (!rows) fail(`${file} holds no array of rows`);
  const fields = [];
  for (const row of rows.slice(0, 200)) {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      for (const k of Object.keys(row)) if (!fields.includes(k)) fields.push(k);
    }
  }
  if (!fields.length) fail(`${file} has no object rows to read columns from`);
  return fields;
}

/** A path as the user would type it: relative to where they ran the command. */
const shown = file => relative(process.cwd(), file) || '.';

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function createConfig(argv) {
  const opts = parseArgs(argv);
  const id = opts.id ?? 'my-grid';
  if (!/^[A-Za-z][\w-]*$/.test(id)) fail(`"${id}" is not a usable element id (letters, digits, - and _)`);
  const dir = resolve(opts.dir ?? (existsSync('public') ? 'public' : '.'));
  if (!existsSync(dir)) fail(`directory ${dir} does not exist`);

  const configName = `everygrid-config-${id}.json`;
  const configPath = join(dir, configName);
  const target = {id, title: humanize(id), pagination: {pageSize: 20, position: 'bottom'}};
  if (opts.data) target.columnI18n = {en: Object.fromEntries(fieldsOf(opts.data).map(f => [f, humanize(f)]))};

  if (existsSync(configPath) && !opts.force) {
    console.log(`  skip    ${shown(configPath)} (exists — --force to overwrite)`);
  } else {
    writeJson(configPath, {targets: [target]});
    console.log(`  create  ${shown(configPath)}`);
  }

  // The entry file is shared by every grid, so it is only ever added to, never rewritten.
  const entryPath = join(dir, 'everygrid.config.json');
  const ref = `/${configName}`;
  if (existsSync(entryPath)) {
    let entry;
    try {
      entry = JSON.parse(readFileSync(entryPath, 'utf8'));
    } catch (e) {
      fail(`cannot parse ${shown(entryPath)}: ${e.message}`);
    }
    entry.configs = Array.isArray(entry.configs) ? entry.configs : [];
    if (entry.configs.includes(ref)) {
      console.log(`  skip    ${shown(entryPath)} (already lists ${ref})`);
    } else {
      entry.configs.push(ref);
      writeJson(entryPath, entry);
      console.log(`  update  ${shown(entryPath)} (+ ${ref})`);
    }
  } else {
    writeJson(entryPath, {configs: [ref]});
    console.log(`  create  ${shown(entryPath)}`);
  }

  console.log(`
Next: put <div id="${id}"></div> on the page, then

  import {mountGrid} from '@everygrid/grid';
  import '@everygrid/grid/css';
  mountGrid('${id}', () => fetch('/your-data.json').then(r => r.json()));

${dir === resolve('.') ? '' : `everygrid.config.json is fetched from the page's own path, so ${shown(dir)}/ must be served at the site root.\n`}`);
}

/** The entry file alone; with a grid id, the first grid's config as well (that is create-config). */
function init(argv) {
  const opts = parseArgs(argv);
  if (opts.id) return createConfig(argv);
  if (opts.data || opts.force) fail('--data and --force need a grid-id');
  const dir = resolve(opts.dir ?? (existsSync('public') ? 'public' : '.'));
  if (!existsSync(dir)) fail(`directory ${dir} does not exist`);
  const entryPath = join(dir, 'everygrid.config.json');
  if (existsSync(entryPath)) {
    console.log(`  skip    ${shown(entryPath)} (exists)`);
  } else {
    writeJson(entryPath, {configs: []});
    console.log(`  create  ${shown(entryPath)}`);
  }
  console.log(`
Next: add a grid — this writes its config and lists it in ${shown(entryPath)}:

  npx @everygrid/grid create-config my-grid [--data rows.json]
`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') init(rest);
else if (command === 'create-config') createConfig(rest);
else if (!command || command === '-h' || command === '--help') console.log(USAGE);
else fail(`unknown command ${command}`);
