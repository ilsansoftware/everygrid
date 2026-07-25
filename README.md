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

Mount each grid after its container element exists — and unmount it when the screen goes away.
`mount` reads the root config on demand (cached — one fetch app-wide), so there's no separate
bootstrap: a matching config target customizes the grid, otherwise it renders with defaults. Grid
lifetime is yours to control; nothing is allocated for a target this screen doesn't render.

```tsx
import { Everygrid } from '@everygrid/core';
import '@everygrid/core/css';

// No bootstrap — mount loads /everygrid.config.json itself (cached) and renders with defaults if the
// id isn't in the config.
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

In React, wrap the lifecycle in a hook and drop it into whatever component renders the container —
each screen registers its own grid, no central wiring:

```tsx
// useEverygrid.ts
import { useEffect } from 'react';
import { Everygrid } from '@everygrid/core';

type Fetcher = string | (() => Promise<Record<string, unknown>[]>);

export function useEverygrid(id: string, fetcher?: Fetcher) {
  useEffect(() => {
    void Everygrid.mount(id, { fetcher });      // loads the config on demand; defaults if unlisted
    return () => { Everygrid.unmount(id); };     // tear down when the screen unmounts
    // Remount only when the id changes — a new fetcher shouldn't rebuild the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
```

```tsx
function UserGrid() {
  useEverygrid('user-grid', () => fetch('/api/users').then(r => r.json()));
  return <div id="user-grid" />;
}
```

The config target for `user-grid` (if any) customizes it; otherwise it renders with defaults. Nothing
else on the page needs to know the grid exists.

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
| `virtualScroll` | `GridVirtualScrollConfig[]` | Virtual scrolling settings per grid (replaces pagination for that grid) |
| `dataLimit` | `GridDataLimitConfig[]` | Cap on rows loaded per grid — a safety net against out-of-memory tab crashes |
| `colors` | `GridColorConfig[]` | Header/body color settings per grid |
| `columnI18n` | `ColumnI18n` | Localized column display names — see [Column i18n](#column-i18n) |
| `mobileColumns` | `GridMobileColumnsConfig[]` | Which columns the narrow (mobile) layout shows — see [Mobile layout](#mobile-layout) |
| `dataCache` | `RequestCache` | `cache` mode for URL data loads. Defaults to `'no-store'` (always re-fetch). Use `'default'` for large, rarely-changing datasets so a reload revalidates instead of re-downloading. |

### Lifecycle API

| Method | Description |
|--------|-------------|
| `loadConfig(entryConfigUrl?, opts?)` | Fetches the entry config and every file it lists, registering their targets. No DOM work, no engines, no data. Cached per URL (concurrent calls share one request); pass `{reload: true}` to bypass. Returns the registered target ids. |
| `createEverygrid(id, fetcher?)` | Ergonomic form of `mount` — also a standalone named export (`import { createEverygrid }`). Loads the root config on demand, applies a matching target or renders with defaults. |
| `loadEverygridConfig(urls?)` | Preload one or more entry configs (default `/everygrid.config.json`; pass an array for sub-apps / several entries). Standalone export too. Usually unnecessary — `createEverygrid` loads on demand. |
| `mount(targetId, opts?)` | Mounts a grid into the element with the same id. Self-sufficient — loads the root config (`/everygrid.config.json`, cached) on demand, so no `loadConfig()` bootstrap is needed; a matching config target customizes the grid, otherwise it renders with defaults. `opts.fetcher` is a URL or a function returning rows. Requires the element to be in the DOM — returns `null` with a warning otherwise. Idempotent. |
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

### Row count placement

Every grid states what it is showing — "Showing 1–5 of 10" — in a band **above and below the
table**, always, whether or not it has pagination. `rowCount` only decides who draws that line:

```json
{
  "pagination": [
    { "id": "user-grid", "pageSize": 10, "position": "bottom", "rowCount": "inline" }
  ]
}
```

| Value | Layout |
|-------|--------|
| `'strip'` *(default)* | The band draws the count itself; pagination bars hold only the page controls |
| `'inline'` | The pagination bar draws it beside its controls, as before the band existed |

`'inline'` applies only at an end that actually has a pagination bar — where there is none, the
band draws the count itself, so both ends always carry it. Virtual grids always use `'strip'`,
having no pagination bar at all.

---

### Data limit (memory guard)

Loading a whole large dataset into the browser — once into JS, again into the WASM worker — can
exceed a device's per-tab memory limit and crash the tab (common on phones: the page opens, then
reloads itself into an error screen). `dataLimit` caps how many rows a grid loads and shows a
banner instead of crashing.

```json
{
  "dataLimit": [
    { "id": "user-grid", "maxRows": "auto" }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Target grid id |
| `maxRows` | `number \| 'auto'` | Hard cap. A number caps at exactly that; `'auto'` derives a device-appropriate cap from reported RAM (`navigator.deviceMemory`) and whether the device looks mobile — a roomy desktop gets no cap. |
| `active` | `boolean` | Set `false` to disable without removing the entry |

It applies on every load path:

- **In-memory / fetched arrays** — the array is sliced to the cap; the banner reads *"Showing the
  first N of M rows"*.
- **Streamed URLs** — ingestion stops once the cap is reached, so the rest of the file is never
  downloaded or held (this is where a phone actually runs out of memory). The full size isn't known
  because the stream was cut short, so the banner reads *"Showing the first N rows"*.

**This is a safety net, not the primary tool for large data.** For datasets that are genuinely too
big for the client, use server-side pagination (`pagination.serverSide` + `serverFetcher`) so only
one page is ever in memory. `dataLimit` is there for when a full dataset reaches the client anyway.

---

### Virtual scrolling

Renders only the rows in view instead of a page at a time, so one continuous scroll covers the
whole filtered result. Rows are fetched from the engine in blocks as you scroll; a block that
hasn't arrived yet shows a placeholder row rather than shifting the scrollbar.

```json
{
  "virtualScroll": [
    {
      "id": "user-grid",
      "active": true,
      "rowHeight": 34,
      "overscan": 8
    }
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | `string` | — | Target grid id |
| `active` | `boolean` | `true` | Set `false` to turn it off without removing the entry |
| `rowHeight` | `number` | `36` | Row height in px. Every row is forced to exactly this |
| `overscan` | `number` | `6` | Extra rows rendered above and below the viewport |
| `blockSize` | `number` | `200` | Rows fetched from the engine per request |

**Constraints.** Enabling it for a grid changes a few behaviours, all of them consequences of
never having more than a screenful of rows in the DOM:

- **Pagination is ignored** for that grid, and its controls are hidden.
- **Row heights are fixed.** Cells are clipped to `rowHeight`; variable-height rows are not
  supported in this mode.
- **The header "select all" checkbox is hidden.** It means "every row rendered right now", which
  under virtual scrolling is whatever happens to be in the viewport — not a selection anyone
  asked for. Per-row checkboxes work as usual.
- **Server-side pagination is not supported** alongside it; `serverSide` pagination wins and
  virtual scrolling stays off for that grid.
- **Excel view** previews the head of the current result rather than a page.

The container must have a bounded height — with an auto height there is nothing to overflow and
every row would render:

```css
#user-grid { height: 560px; display: flex; flex-direction: column; }
```

Browsers cap element height (~33.5M px in Chrome), which at the default 36px row is around
930,000 rows before the scrollbar stops tracking exactly. Lower `rowHeight` to raise the ceiling.

---

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

## Column i18n

`columnI18n` gives columns localized display names without touching the data. It maps
`locale → ('common' | gridId) → field → label`; a grid id's entry overrides `common`, and any field
with no label falls back to its raw key. Locale is the global `I18n` locale, so `I18n.setLocale(l)`
followed by `Everygrid.refreshAll()` relabels every grid.

```json
"columnI18n": {
  "ko": {
    "common": { "id": "아이디", "name": "이름", "age": "나이" },
    "orders": { "name": "주문자" }
  },
  "en": {
    "common": { "id": "ID", "name": "Name", "age": "Age" }
  }
}
```

Labels are **display-only**. The search box still uses real field keys (`name() && age()`) — the
suggestion dropdown just annotates each key with its label, e.g. `name(이름)`, and inserts the key.
So queries, WASM filtering, and highlighting are locale-independent, and switching language never
invalidates a typed query.

## Mobile layout

Below 720px the grid drops to a touch-friendly layout that **doesn't scroll horizontally**: it shows
a fixed set of up to 3 columns plus a per-row **detail button** that opens the whole row in a modal.
Rows are taller and controls are larger for touch; pinning, resizing and the checkbox column are off.

Which 3 columns show, in priority order:

1. The user's in-session pick — the toolbar's **Mobile Columns** action (mobile only) lets them choose up to 3.
2. `mobileColumns` config for the grid.
3. The first three data columns (default).

```json
"mobileColumns": [
  { "id": "orders", "cols": ["name", "status", "total"] }
]
```

`cols` are field keys (first 3 used); any that don't exist are skipped. Column labels follow
[Column i18n](#column-i18n) like everywhere else.

## Excel export

The toolbar's export button downloads the grid as `.xlsx`:

- **Filtered vs All** — when a filter is active the button offers both scopes (with row counts);
  otherwise it downloads directly.
- **Nested arrays → child sheets** — object arrays are exported as normalized child sheets linked to
  the main sheet by `_mainSheetRowNum` (with `_key` / `_idx` for the sub-path and position), so the
  data stays analysable in Excel/Power Query. On those child sheets, nested objects flatten to
  `parent_child` columns to any depth.
- **Nested objects → one cell** — on the main sheet a nested object stays a single column, its
  contents rendered into the one cell (the same treatment object arrays get), so every nested value
  reads the same way rather than a `{name, division}` object splitting into `_name` / `_division`
  columns while an object holding arrays stays whole.
- **Large data** — built off the main thread in a worker, streamed and zip-split so even multi-GB
  grids export without freezing the UI; the progress badge shows a percentage and a **Cancel**.

### Excel preview

The toolbar's preview button swaps the grid for a spreadsheet-shaped rendering of the same data —
the nested-column layout the export produces — without downloading anything. It takes over the
grid's own box, so a grid with a fixed height keeps it and the preview scrolls inside.

**It navigates the way the grid does**, so the whole result is reachable either way:

| Grid | Preview |
|------|---------|
| Paged | Pages, using that grid's own `pageSize` |
| Virtual scrolling | Keeps scrolling, appending the next chunk as you near the end |
| Neither | One page of 50 |

The row count under the table reports what is on screen against the full result — `Showing
1–50 of 2,000`. Leaving and re-entering the preview returns to the page you were on; changing the
filter or sort starts again from the top.

A grid sized by its content is capped at `60vh` so a preview of wide, deeply nested rows cannot
push the page around; it scrolls within the cap. Override with `.everygrid-excel-body`.

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
