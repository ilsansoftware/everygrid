# Everygrid

A flexible, config-driven data grid library for React.

## Installation

```bash
npm install @everygrid/core
```

## Quick Start

### 1. Install the library

```bash
npm install @everygrid/core
```

### 2. Import CSS

```ts
import '@everygrid/core/css';
```

### 3. Create your grid config file

Create a JSON file anywhere in your project's `public/` directory, e.g. `public/everygrid-config-users.json`:

```json
{
  "targets": [
    {
      "id": "user-grid",
      "title": "Users"
    }
  ],
  "pagination": [
    {
      "id": "user-grid",
      "pageSize": 10,
      "active": true,
      "position": "bottom"
    }
  ]
}
```

### 4. Register the config path in `everygrid.config.json`

Create `everygrid.config.json` at your **project root**:

```json
{
  "configs": [
    "/everygrid-config-users.json"
  ]
}
```

> Multiple config files are supported. Each file's `targets` arrays are merged automatically.

### 5. Serve `everygrid.config.json` from the root URL

Since `everygrid.config.json` lives at the project root (not in `public/`), you need to tell your dev server to serve it at `/everygrid.config.json`.

**Vite** — add this plugin to your `vite.config.ts`:

```ts
import fs from 'fs';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    {
      name: 'serve-root-everygrid-config',
      configureServer(server) {
        server.middlewares.use('/everygrid.config.json', (_req, res) => {
          const filePath = resolve(__dirname, 'everygrid.config.json');
          res.setHeader('Content-Type', 'application/json');
          res.end(fs.readFileSync(filePath));
        });
      },
      generateBundle() {
        const filePath = resolve(__dirname, 'everygrid.config.json');
        this.emitFile({
          type: 'asset',
          fileName: 'everygrid.config.json',
          source: fs.readFileSync(filePath, 'utf-8'),
        });
      },
    },
  ],
});
```

### 6. Mount grids in your app

Load the config once, then mount each grid after its container element exists — and unmount it
when the screen goes away. Grid lifetime is yours to control; nothing is allocated for a target
this screen doesn't render.

```tsx
import { Everygrid } from '@everygrid/core';
import '@everygrid/core/css';

await Everygrid.loadConfig();                       // cached per page — call it from every screen
await Everygrid.mount('user-grid', {
  fetcher: () => fetch('/api/users').then(r => r.json()),
});

// …when the screen unmounts
Everygrid.unmount('user-grid');
```

Add a container element with the matching `id` in your HTML:

```html
<div id="user-grid"></div>
```

In React, tie it to the component that renders the container:

```tsx
useEffect(() => {
  void Everygrid.loadConfig().then(() => Everygrid.mount('user-grid', { fetcher }));
  return () => { Everygrid.unmount('user-grid'); };
}, []);
```

---

## CDN Usage

You can use Everygrid directly in the browser via CDN (no build step required).

```html
<!-- React (peer dependency) -->
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>

<!-- Everygrid -->
<link rel="stylesheet" href="https://unpkg.com/@everygrid/core/dist/Everygrid.css" />
<script src="https://unpkg.com/@everygrid/core/dist/index.umd.js"></script>

<div id="user-grid"></div>

<script>
  Everygrid.autoInit({
    'user-grid': () => fetch('/api/users').then(r => r.json()),
  });
</script>
```

> **Note:** When using CDN, `everygrid.config.json` must be accessible at `/everygrid.config.json` on your server, and each config file path in `configs` must also be publicly accessible.

---

## Configuration Reference

### `everygrid.config.json`

| Field | Type | Description |
|-------|------|-------------|
| `configs` | `string[]` | List of config file URLs to load (browser-relative paths) |

### Grid Config File

| Field | Type | Description |
|-------|------|-------------|
| `targets` | `GridTargetConfig[]` | Grid instances to initialize |
| `editableCols` | `EditableColConfig[]` | Editable column settings per grid |
| `rowCheckbox` | `GridRowCheckboxConfig[]` | Row checkbox settings per grid |
| `pagination` | `GridPaginationConfig[]` | Pagination settings per grid |
| `colors` | `GridColorConfig[]` | Header/body color settings per grid |
| `dataCache` | `RequestCache` | `cache` mode for URL data loads. Defaults to `'no-store'` (always re-fetch). Use `'default'` for large, rarely-changing datasets so a reload revalidates instead of re-downloading. |

### Lifecycle API

| Method | Description |
|--------|-------------|
| `loadConfig(entryConfigUrl?, opts?)` | Fetches the entry config and every file it lists, registering their targets. No DOM work, no engines, no data. Cached per URL (concurrent calls share one request); pass `{reload: true}` to bypass. Returns the registered target ids. |
| `mount(targetId, opts?)` | Mounts one registered target into the element with the same id. `opts.fetcher` is a URL or a function returning rows. Requires the element to already be in the DOM — returns `null` with a warning otherwise. Idempotent. |
| `unmount(targetId)` | Tears the grid down completely — React root, WASM engine, worker thread, timers — and makes the target mountable again. Returns whether a grid was there. |
| `invalidateConfig(entryConfigUrl?)` | Drops cached config so the next `loadConfig` re-fetches. Mounted grids keep the config they were built with. |
| `refreshAll()` | Re-renders mounted grids that are in the DOM (viewport-lazy). Use after a container changes size or visibility. |
| `resetAutoInit()` | Unmounts every grid and forgets all loaded config. |

A target whose fetcher is a URL is loaded straight into the WASM engine; payloads of 50MB or
more are streamed in chunks so the main thread never holds the whole dataset.

Each mounted grid owns a Web Worker and its own WASM heap, released on `unmount`. Because cost
tracks grids actually mounted — not targets that exist in config — a site with hundreds of
screens pays only for what the current screen renders.

### `autoInit(apiFetchers?, entryConfigUrl?)` *(deprecated)*

Convenience wrapper: `loadConfig()`, then `mount()` for every target whose element is already in
the DOM. Targets whose container doesn't exist yet are skipped rather than waited for, so a
screen that renders its container later must mount it itself. Prefer `loadConfig` + `mount`.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `apiFetchers` | `Record<string, string \| (() => Promise<Row[]>)>` | `{}` | Per target id: a URL to fetch, or a function returning the rows |
| `entryConfigUrl` | `string` | `'/everygrid.config.json'` | Path to the entry config file |

### Serving large datasets

Compress big JSON at rest — it is the single biggest win for load time (a 1GB test set
gzips ~11x, turning a multi-minute download into seconds). Keep the URL unchanged and let
the browser decompress transparently:

```bash
gzip -6 -c large.json > large.json.gz
aws s3 cp large.json.gz s3://<bucket>/data/large.json \
  --content-type application/json \
  --content-encoding gzip \
  --metadata "uncompressed-length=$(stat -f%z large.json)"
```

`Content-Length` then reports the *compressed* size, which is not comparable with the
decoded bytes the grid reads, so the indexing bar falls back to showing rows ingested. To
get a true percentage, advertise the decoded size via `X-Uncompressed-Length` (or S3 user
metadata `uncompressed-length`, surfaced as `x-amz-meta-uncompressed-length`). For
cross-origin loads that header must also be listed in the bucket's CORS `ExposeHeaders`.

---

## Search & filter syntax

The search box runs a small query language against the WASM engine (case-insensitive throughout,
keys included). Everything composes with `&&` / `||`.

| Form | Meaning | Example |
|------|---------|---------|
| `text` | Free text — matches any field at any depth | `frontend` |
| `field(expr)` | Scope into a field; nest for depth | `role(engineering(subRole(front)))` |
| `a(x).b(y)` | Sibling keys ANDed **on the same object/array element** | `subRole(front).years(>=2)` |
| `field(>n)` … | Comparisons: `>` `>=` `<` `<=` `==`/`=` `!=` | `age(>=30)`, `dept(!=HR)` |
| `field(in[a,b])` | Membership | `dept(in[HR,Design])` |
| `field(~re)` | Regex (add `(?i)` for case-insensitive) | `email(~@example\.com$)` |
| `field op value` | Un-parenthesized comparison (single field) | `age >= 30`, `active == true` |

Notes:

- A field scope over an **array** matches when *any* element satisfies it; with the `.` chain the
  conditions must hold on the **same** element (`role(engineering(subRole(front).years(=1)))`).
- Booleans work with the operators: `active(==true)`, `active(!=false)`.
- The search box **autocompletes keys** for the current scope (top-level fields first, then the
  selected field's sub-keys), colours parenthesis pairs by depth, and highlights the bracket next to
  the caret. Enter runs the search; Shift+Enter inserts a newline.

## Excel export

The toolbar's export button downloads the grid as `.xlsx`:

- **Filtered vs All** — when a filter is active the button offers both scopes (with row counts);
  otherwise it downloads directly.
- **Nested arrays → child sheets** — object arrays are exported as normalized child sheets linked to
  the main sheet by `_mainSheetRowNum` (with `_key` / `_idx` for the sub-path and position), so the
  data stays analysable in Excel/Power Query. Scalar nested objects flatten into `parent_child`
  columns.
- **Large data** — built off the main thread in a worker, streamed and zip-split so even multi-GB
  grids export without freezing the UI; the progress badge shows a percentage and a **Cancel**.

---

## Other APIs

```ts
// Re-render all grids (e.g. after language change)
Everygrid.refreshAll();

// Re-fetch one grid's data from the source it was created with and rebuild its index.
// The toolbar shows a "Reload Data" button for exactly those grids; grids given their
// rows inline have no source to re-fetch, so they get no button and this is a no-op.
// Reloaded rows become the new baseline: pending cell edits are discarded.
grid.reloadData('my-grid-id');

// Internationalization
import { I18n } from '@everygrid/core';
I18n.initFromBrowser(); // auto-detect browser language
I18n.setLocale('en');   // 'en' | 'ko'
```

---

## License

MIT
