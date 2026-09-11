import '../styles/Everygrid.css';
import {GridEngineWasm} from '../wasm/GridEngineWasm';
import {EverygridComponent} from '../components/EverygridComponent';
import {isJsonString, parseIfJson} from './utils';
import {GridHandle, type GridEvents, type RowKey, type CellChange, type RowChange} from './GridHandle';
import {ExcelView} from './ExcelView';
import {runExcelExport} from '../wasm/ExcelExportClient';
import {ColumnSelectorComponent} from '../components/ColumnSelectorComponent';
import {MobileColumnSelectorComponent} from '../components/MobileColumnSelectorComponent';
import {RowDetailComponent} from '../components/RowDetailComponent';
import {HiddenColumnSelectorComponent} from '../components/HiddenColumnSelectorComponent';
import {highlightText} from './highlightUtils';
import {I18n} from '../i18n/I18n';
import React from 'react';
import {PopupComponent} from '../components/PopupComponent';
import {TextEditorPopupComponent} from '../components/TextEditorPopupComponent';
import {createRoot, type Root} from 'react-dom/client';
import {
  type GridColumn,
  type GridLoadProgress,
  type GridOptions,
  type GridPaginationConfig,
  type GridTargetConfig,
  type GridVirtualScrollConfig,
  type IEverygrid,
  type KeyTree,
  type ReloadOptions,
  type ServerFetchParams,
} from './types';

/** Rows per engine fetch in virtual mode. Big enough that a normal scroll rarely crosses a
 *  boundary, small enough that a fetch stays imperceptible. */
const VIRTUAL_BLOCK_SIZE = 200;
/** Blocks kept per grid before the oldest are evicted (200 × 60 = 12k rows). */
const VIRTUAL_BLOCK_CACHE_MAX = 60;

export class Everygrid<T extends Record<string, unknown> = Record<string, unknown>> implements IEverygrid<T> {
  public static readonly POPUP_OVERLAY_CLASS = 'everygrid-popup-overlay';
  public static readonly POPUP_CONTENT_CLASS = 'everygrid-popup-content';
  public static readonly POPUP_CLOSE_CLASS = 'everygrid-popup-close';
  public static readonly POPUP_CLOSE_HTML = '&times;';
  private static instances: Map<string, unknown> = new Map();
  private static _initializedTargets: Set<string> = new Set();
  // Config URL → in-flight/resolved load. Caching the promise (not the result) also dedupes
  // concurrent loadConfig calls, so N screens asking at once still make one network request.
  private static _configCache: Map<string, Promise<string[]>> = new Map();
  // Target id → the config it came from. Populated by loadConfig, consumed by mount.
  private static _targetRegistry: Map<string, {config: Record<string, unknown>; target: GridTargetConfig}> = new Map();
  // In-flight mounts, keyed by target id, so concurrent mount() calls for the same id share one
  // creation instead of each running createRoot on the container (React StrictMode double-invoke).
  private static _mounting: Map<string, Promise<Everygrid | null>> = new Map();
  public static I18n = I18n;
  public static options: GridOptions = { targets: [] };
  readonly options: GridOptions<T>;
  public hiddenFieldsMap: Map<string, Set<string>> = new Map(); // Manages hidden fields per targetId
  public displayColsMap: Map<string, Set<string>> = new Map(); // Column selector whitelist per targetId (empty = show all)
  public exportState: Map<string, {done: number; total: number}> = new Map(); // Excel export progress (files done/total) per targetId
  private _exportControllers: Map<string, AbortController> = new Map(); // aborts in-flight exports (terminates the worker) on re-export or destroy
  public pinnedColumns: Set<string> = new Set(); // Manages pinned columns
  public commaSeparatedFields: Set<string> = new Set(); // Manages comma-separated columns
  public linkFields: Set<string> = new Set(); // Manages link-converted columns
  public isExcelViewMode: boolean = false;
  public sortConfig: Map<string, { field: string; direction: 'asc' | 'desc' | null }> = new Map();
  public columnWidths: Map<string, Map<string, number>> = new Map(); // Manages column widths per targetId
  public activeEditFields: Map<string, Set<string>> = new Map();
  // Cache of the searchable-key tree per target, for the search autocomplete. See getSearchKeys.
  private _searchKeysCache: Map<string, KeyTree> = new Map();
  public activePopup: React.ReactElement | null = null;
  // Nested-table popup data. Stored (not pre-built) so the popup is assembled at render time with
  // the CURRENT filterText — highlighting stays live if the filter changes while it is open.
  public activePopupData: {data: unknown} | null = null;
  public activePopupTitle: string | null = null;
  public activePopupRow: unknown | null = null;
  public activePopupRowKey: string | null = null;
  public currentPage: Map<string, number> = new Map();
  private originalDataMap: Map<T, T> = new Map();
  // Edited rows keyed by their current-value JSON, so WASM-derived page copies (which are new
  // object refs, not keys in originalDataMap) can be remapped back to the live edited reference
  // in getDisplayItems — that reference is what makes isCellModified / resetCell work by identity.
  private _editedKeys: Map<string, T> = new Map();
  // Rows inserted / deleted since load, by live reference (migrated along with the reference on
  // edit, like originalDataMap). A deleted row stays in the data and the engine, struck through,
  // until commit removes it; an inserted row is in both from the moment it is inserted.
  private _insertedRows: Set<T> = new Set();
  private _deletedRows: Set<T> = new Set();
  public checkedValues: Map<string, Set<unknown>> = new Map(); // Manages checked values per targetId (checkbox config)
  private syncTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private roots: Map<HTMLElement, Root> = new Map();
  private subscribers: Set<() => void> = new Set();
  private domObserver: MutationObserver | null = null;
  // Set by destroy(). Pending polls check it so an unmounted grid stops working immediately
  // instead of spinning out its timeout.
  public _destroyed = false;
  public filterText: string = '';
  private _wasmEngines: Map<string, GridEngineWasm> = new Map();
  private _wasmEngineReady: Map<string, boolean> = new Map();
  private _wasmDataLoaded: Map<string, boolean> = new Map();
  // Cache: last getPage result per containerId (updated after each applyWasmFilter)
  public _wasmPageCache: Map<string, { rows: unknown[]; total: number }> = new Map();
  public get wasmReady(): boolean { return this._wasmEngines.size > 0 && [...this._wasmEngineReady.values()].some(v => v); }

  /** Loading/indexing progress for one of this instance's targets. Mirrors the flags the toolbar
   *  uses for its progress pill, but as plain data so a host (tab bar, shell) can render it too. */
  public loadProgress(containerId: string): GridLoadProgress {
    const streaming = this._wasStreaming.has(containerId);
    const stage = this._indexingStage.get(containerId);
    const hasReadyPage = this._wasmPageCache.has(containerId);
    const indexing = streaming && (stage === 'indexing' || !hasReadyPage);
    const active = indexing || this._loading.has(containerId);
    const percent = this._indexingProgress.get(containerId) ?? -1;
    const rowsLoaded = this._streamRows.get(containerId)?.length
      ?? this._streamTotal.get(containerId)
      ?? ((this.options.data as unknown[] | undefined)?.length ?? 0);
    return { active, percent, rowsLoaded, stage };
  }

  /** Loading/indexing progress for a mounted target, or null if nothing is mounted under that id.
   *  Lets a tab bar or shell show a grid's load progress while that grid's own view is hidden —
   *  a keep-alive tab keeps streaming in the background, so its progress outlives its visibility. */
  public static getLoadProgress(id: string): GridLoadProgress | null {
    const inst = Everygrid.instances.get(id) as Everygrid | undefined;
    return inst?.loadProgress(id) ?? null;
  }
  private _serverTotal: Map<string, number> = new Map();
  private _serverFetching: Map<string, boolean> = new Map();
  // Streaming mode: total row count
  public _streamTotal: Map<string, number> = new Map();
  // Set when a target's load was capped by dataLimit: rows actually loaded, and the true total
  // when known (in-memory) — null when a stream was stopped early and the full size is unknown.
  public _dataLimited: Map<string, {shown: number; total: number | null}> = new Map();
  // Streaming mode: all rows stored in JS memory
  public _streamRows: Map<string, Record<string, unknown>[]> = new Map();
  // Streaming mode: source URL (stored for reference, no re-fetch needed)
  public _streamUrl: Map<string, string> = new Map();
  // Processing state: true while WASM filter/sort is running
  public _processing: Map<string, boolean> = new Map();
  private _processingTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _filterSeq: Map<string, number> = new Map();
  // Virtual scrolling: engine rows cached in fixed-size blocks, keyed by the filter/sort
  // generation (`seq`) they were fetched under so a filter change drops all of them at once.
  private _blockCache: Map<string, {seq: number; blocks: Map<number, unknown[]>; order: number[]}> = new Map();
  // Keyed `${seq}:${block}`: a block still in flight for an old generation must not stop the
  // same block being fetched for the new one, or the hole would stay until the next scroll.
  private _blockPending: Map<string, Set<string>> = new Map();
  private _blockRenderScheduled: Set<string> = new Set();
  // Engine loads, serialised per target. setData uploads the dataset as a sequence of awaited
  // batches, so two overlapping loads interleave in the worker: the second one's opening "clear"
  // lands between the first one's appends and both datasets end up half-written on top of each
  // other. These keep one load in flight at a time and drop any that a newer one superseded.
  private _loadChain: Map<string, Promise<void>> = new Map();
  private _loadSeq: Map<string, number> = new Map();
  // Raw (unfiltered) total per containerId — updated after each WASM handoff/filter
  public _wasmRawTotal: Map<string, number> = new Map();
  public _indexingAllRows: Map<string, Record<string, unknown>[]> = new Map();
  // Indexing stage: 'indexing' while build_index runs, 'ready' when done
  public _indexingStage: Map<string, 'indexing' | 'ready'> = new Map();
  // Indexing progress: 0–100
  public _indexingProgress: Map<string, number> = new Map();
  // Tracks which grids are streaming grids (only these show indexing UI)
  public _wasStreaming: Set<string> = new Set();
  // Targets with a data load in flight, whatever path it takes (stream, buffered fetch, fetcher
  // function). The indexing flags only cover the streaming path and only once the engine is up,
  // so this is what makes "is this grid still loading?" answerable the same way for every grid.
  public _loading: Set<string> = new Set();
  /** Headers an origin may use to advertise the decoded size of a compressed body. */
  private static readonly UNCOMPRESSED_LENGTH_HEADERS = ['X-Uncompressed-Length', 'x-amz-meta-uncompressed-length'];
  // Above this decoded size a payload is streamed into WASM instead of being buffered by res.json().
  private static readonly LARGE_PAYLOAD_BYTES = 50 * 1024 * 1024;
  // Where each target's data came from, kept so the toolbar can re-load it on demand.
  // Unlike _streamUrl (cleared once a load finishes) this survives for the grid's lifetime.
  public _dataSource: Map<string, string | (() => Promise<Record<string, unknown>[]>)> = new Map();
  // True while a reloadData() call is in flight, so repeated clicks don't stack fetches.
  // Which reload is in flight, if any. 'button' means the toolbar's reload was pressed, and only
  // that one puts the button into its spinning, disabled state; 'silent' is a reload the host asked
  // for because the fetcher's inputs changed, which shows the same loading UI as a first load and
  // leaves the button alone. Either value blocks a second reload from starting.
  public _reloading: Map<string, 'button' | 'silent'> = new Map();
  // The reload currently running, and the one asked for while it ran. Latest wins: every request
  // made during a run is folded into a single follow-up, and each caller's promise settles when
  // the run that carries its request has finished.
  private _reloadRun: Map<string, Promise<void>> = new Map();
  private _reloadNext: Map<string, {opts: ReloadOptions; promise: Promise<void>}> = new Map();
  // Targets whose current rows have been thrown away for an incoming, different result. While a
  // target is in here the virtual body must not fall back to the in-memory copy — those rows are
  // the new ones, but they are not indexed yet, and showing them un-indexed means a grid that
  // cannot be filtered or sorted for as long as the load takes.
  private _discarding: Set<string> = new Set();

  constructor(options: GridOptions<T>) {
    this.options = options;

    if (this.options.data) {
      this.initOriginalDataMap();
    }

    this.options.targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const links = typeof idConfig === 'object' ? idConfig.links : undefined;
      if (links) {
        links.forEach(col => this.linkFields.add(col));
      }

      const linkConfig = this.options.links?.find(l => l.id === id);
      if (linkConfig) {
        linkConfig.cols.forEach(col => this.linkFields.add(col));
      }
    });

    // Register instances by target ID
    if (this.options.targets) {
      this.options.targets.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        Everygrid.instances.set(id, this);
      });
    }

    this.observeDOM();
    I18n.initFromBrowser();
    // Initialize an independent WASM engine per containerId
    // Skip engine creation for grids with no data source at all (empty grids)
    if (this.options.data === undefined && !this.options.dataUrl) return;

    const targetIds = (this.options.targets ?? []).map(idConfig =>
      typeof idConfig === 'string' ? idConfig : idConfig.id
    );
    targetIds.forEach(id => {
      GridEngineWasm.create(id, (stage, progress) => {
        if (stage === 'ready') {
          // Show 100% briefly before hiding the progress bar
          this._indexingProgress.set(id, 100);
          const el100 = document.getElementById(id);
          if (el100) this.renderGrid(el100);
          setTimeout(() => {
            this._indexingStage.set(id, 'ready');
            const elDone = document.getElementById(id);
            if (elDone) this.renderGrid(elDone);
          }, 400);
        } else {
          this._indexingStage.set(id, stage);
          this._indexingProgress.set(id, progress);
          const el = document.getElementById(id);
          if (el) this.renderGrid(el);
        }
      }).then(engine => {
        this._wasmEngines.set(id, engine);
        this._wasmEngineReady.set(id, true);
        // `this.options.data` is read here, not at construction, so by now a fetcher's rows may
        // already have been installed by _setRows — which is itself waiting on this very engine
        // to load them. Loading them here too would run the same upload twice, concurrently.
        // _wasmDataLoaded is set by _setRows before it awaits the engine, so it marks exactly
        // that case: someone else owns this target's load.
        if (this.options.data && this.options.data.length > 0 && !this._wasmDataLoaded.get(id)) {
          // Cap directly-supplied data too, and point options.data at the capped slice so the
          // count and the engine agree (and the trimmed rows can be freed).
          const capped = this._capRows(id, this.options.data as Record<string, unknown>[]);
          (this.options as { data: unknown[] }).data = capped;
          this._loadIntoEngine(id, engine, capped as unknown[]).then(() => {
            this._wasmDataLoaded.set(id, true);
            this.applyWasmFilter(id).catch(console.error);
          }).catch(console.error);
        } else if (!this._wasmDataLoaded.get(id)) {
          this.applyWasmFilter(id).catch(console.error);
        }
      }).catch(err => {
        console.warn(`Everygrid: WASM engine init failed for ${id}:`, err);
      });
    });
  }

  /** Unmounts every grid and forgets all loaded config — the next loadConfig re-fetches. */
  /**
   * Re-fetches a mounted grid's data from the source it was created with, in place.
   *
   * The instance method needs a handle the host usually does not keep; this is the same call for
   * callers that only know the target id — what the toolbar's reload button does, by another name.
   * Use it when the fetcher's own inputs have changed (a different row count, a new date range) and
   * the grid should pick that up without being torn down and remounted.
   */
  public static async reload(id: string, opts: ReloadOptions = {}): Promise<void> {
    const instance = Everygrid.instances.get(id) as Everygrid | undefined;
    await instance?.reloadData(id, opts);
  }

  /**
   * A handle onto a mounted grid's data — `Everygrid.get('users').row(3).cell('score').set(90)`.
   * Null when nothing is mounted under that id. See GridHandle.
   */
  public static get<D extends Record<string, unknown> = Record<string, unknown>>(id: string): GridHandle<D> | null {
    const instance = Everygrid.instances.get(id) as Everygrid<D> | undefined;
    return instance ? new GridHandle<D>(instance, id) : null;
  }

  public static resetAutoInit(): void {
    // Destroy all existing instances before clearing to free WASM engines and React roots
    Everygrid.instances.forEach(instance => {
      try { (instance as Everygrid).destroy(); } catch { /* ignore */ }
    });
    Everygrid._initializedTargets.clear();
    Everygrid.instances.clear();
    Everygrid._targetRegistry.clear();
    Everygrid._configCache.clear();
  }

  /**
   * Resolves a config/data URL against the browser's base URI.
   * Absolute paths ('/…') get the base path prefix, so the library works under a sub-path deploy.
   */
  private static _resolveUrl(url: string): string {
    if (/^https?:\/\//.test(url)) return url;
    if (url.startsWith('/')) {
      const base = new URL(document.baseURI);
      const prefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
      return base.origin + prefix + url;
    }
    return new URL(url, document.baseURI).href;
  }

  /**
   * Loads config files and registers their targets — no DOM work, no engines, no data fetching.
   * Mount the ones this screen actually shows with `mount()`.
   *
   * Cached per entry URL, so calling it from every screen costs one network round trip for the
   * lifetime of the page. Config edits are picked up on reload, or explicitly via
   * `invalidateConfig()` / `{reload: true}`.
   *
   * @param entryConfigUrl Path to the static entry config file (default: /everygrid.config.json)
   * @param opts Options.
   * @param opts.reload Bypass the cache and re-fetch
   * @returns The target ids that are now registered (across every config file listed)
   */
  public static loadConfig(
    entryConfigUrl: string = 'everygrid.config.json',
    opts: {reload?: boolean} = {},
  ): Promise<string[]> {
    if (opts.reload) Everygrid._configCache.delete(entryConfigUrl);
    const cached = Everygrid._configCache.get(entryConfigUrl);
    if (cached) return cached;

    const load = Everygrid._fetchConfig(entryConfigUrl).catch(error => {
      // Don't cache a failure — the next call should be able to retry.
      Everygrid._configCache.delete(entryConfigUrl);
      console.error('Everygrid.loadConfig error:', error);
      return [] as string[];
    });
    Everygrid._configCache.set(entryConfigUrl, load);
    return load;
  }

  /** Drops cached config so the next loadConfig re-fetches. Already-mounted grids keep their config. */
  public static invalidateConfig(entryConfigUrl?: string): void {
    if (entryConfigUrl) Everygrid._configCache.delete(entryConfigUrl);
    else Everygrid._configCache.clear();
  }

  private static async _fetchConfig(entryConfigUrl: string): Promise<string[]> {
    const resolvedEntry = Everygrid._resolveUrl(entryConfigUrl);
    const entryResponse = await fetch(resolvedEntry);
    if (!entryResponse.ok) {
      console.warn('Everygrid.loadConfig: entry config not found at', entryConfigUrl);
      return [];
    }

    const entryConfig = await entryResponse.json();
    if (!Array.isArray(entryConfig.configs) || entryConfig.configs.length === 0) {
      console.warn('Everygrid.loadConfig: "configs" array not found or empty in', entryConfigUrl);
      return [];
    }

    const configBase = resolvedEntry.substring(0, resolvedEntry.lastIndexOf('/') + 1);
    const configUrls: string[] = entryConfig.configs.map((u: string) => {
      if (/^https?:\/\//.test(u)) return u;
      if (u.startsWith('/')) return Everygrid._resolveUrl(u);
      return configBase + u.replace(/^\.\//, '');
    });

    // Fetch all config files in parallel, keep each config separate
    const configs = await Promise.all(
      configUrls.map(async (url) => {
        try {
          const res = await fetch(url);
          if (!res.ok) {
            console.warn('Everygrid.loadConfig: failed to load config at', url);
            return null;
          }
          return await res.json() as Record<string, unknown>;
        } catch {
          console.warn('Everygrid.loadConfig: error loading config at', url);
          return null;
        }
      })
    );

    const ids: string[] = [];
    for (const config of configs) {
      if (!config || !Array.isArray(config.targets)) continue;
      for (const target of config.targets as GridTargetConfig[]) {
        Everygrid._targetRegistry.set(target.id, {config, target});
        ids.push(target.id);
      }
    }
    return ids;
  }

  /**
   * Mounts a grid into the element with the same id. Self-sufficient: it loads the root config
   * (`/everygrid.config.json`, cached — one fetch app-wide) on demand, so a screen can just call
   * `mount('a-grid', { fetcher })` with no separate `loadConfig()` bootstrap. If the config carries
   * a target for this id, its settings apply; if not, the grid renders with defaults — config is
   * for customization, not a requirement. The element must be in the DOM (nothing is allocated for a
   * target this screen doesn't show).
   *
   * Idempotent: mounting an already-mounted target returns the live instance.
   *
   * @param targetId Element id; any id renders (a matching config target just customizes it)
   * @param opts Mount options.
   * @param opts.fetcher Data source for this target — a URL (streamed) or an async function
   */
  public static async mount<D extends Record<string, unknown> = Record<string, unknown>>(
    targetId: string,
    opts: {fetcher?: string | (() => Promise<Record<string, unknown>[]>)} = {},
  ): Promise<Everygrid<D> | null> {
    const existing = Everygrid.instances.get(targetId);
    if (existing) return existing as Everygrid<D>;
    // Coalesce concurrent mounts of the same id (e.g. React StrictMode's mount→unmount→mount) so the
    // container is never handed to createRoot twice.
    const inflight = Everygrid._mounting.get(targetId);
    if (inflight) return inflight as Promise<Everygrid<D> | null>;
    const p = Everygrid._doMount<D>(targetId, opts);
    Everygrid._mounting.set(targetId, p as Promise<Everygrid | null>);
    try {
      return await p;
    } finally {
      Everygrid._mounting.delete(targetId);
    }
  }

  private static async _doMount<D extends Record<string, unknown> = Record<string, unknown>>(
    targetId: string,
    opts: {fetcher?: string | (() => Promise<Record<string, unknown>[]>)},
  ): Promise<Everygrid<D> | null> {
    if (!document.getElementById(targetId)) {
      console.warn(`Everygrid.mount: no element with id "${targetId}" — render it before mounting.`);
      return null;
    }

    let entry = Everygrid._targetRegistry.get(targetId);
    if (!entry) {
      // Not registered yet — read the root config (cached, so at most one fetch app-wide) and look
      // again. Awaiting opens a race for the same id, so re-check the live instance afterwards.
      await Everygrid.loadConfig();
      const raced = Everygrid.instances.get(targetId);
      if (raced) return raced as Everygrid<D>;
      entry = Everygrid._targetRegistry.get(targetId);
    }

    // An id with no config target still renders, with defaults.
    const {config, target} = entry ?? {
      config: {targets: [{id: targetId}]} as Record<string, unknown>,
      target: {id: targetId} as GridTargetConfig,
    };
    Everygrid._initializedTargets.add(targetId);

    const fetcherOrUrl = opts.fetcher;
    if (typeof fetcherOrUrl === 'string') {
      const url = Everygrid._resolveUrl(fetcherOrUrl);
      // Mount with empty data so the skeleton paints now, then stream in the background.
      const instance = new Everygrid({...config, targets: [target], data: []});
      instance._streamUrl.set(targetId, url);
      instance._dataSource.set(targetId, url);
      void instance._loadFromUrl(targetId, url);
      return instance as unknown as Everygrid<D>;
    }
    if (fetcherOrUrl) {
      // Same shape as the URL path: paint the skeleton first, fill it in when the rows arrive.
      // Awaiting the fetcher before constructing left the container blank for the whole fetch.
      const instance = new Everygrid({...config, targets: [target], data: []});
      instance._dataSource.set(targetId, fetcherOrUrl);
      instance._loading.add(targetId);
      // The skeleton has to reach the screen before the fetcher runs: a fetcher that builds its
      // rows synchronously would otherwise block the paint it was mounted for.
      void Everygrid._afterPaint()
        .then(fetcherOrUrl)
        .then(rows => instance._setRows(targetId, rows))
        .catch(err => console.warn('Everygrid: fetcher failed for', targetId, err))
        .finally(() => {
          instance._loading.delete(targetId);
          const el = document.getElementById(targetId);
          if (el) instance.renderGrid(el);
        });
      return instance as unknown as Everygrid<D>;
    }
    const instance = new Everygrid({...config, targets: [target], data: target.data});
    return instance as unknown as Everygrid<D>;
  }

  /**
   * Preload one or more entry config files (each an `everygrid.config.json` listing its `configs`).
   * Usually unnecessary — `createGrid` / `mount` read the root config on demand — but call it to
   * point at a non-root path (a sub-app), or to load several entries up front. Cached per URL.
   * Returns every registered target id. Also exported as a standalone `loadEverygridConfig`.
   */
  public static async loadEverygridConfig(
    entryConfigUrls: string | string[] = 'everygrid.config.json',
  ): Promise<string[]> {
    const urls = Array.isArray(entryConfigUrls) ? entryConfigUrls : [entryConfigUrls];
    const lists = await Promise.all(urls.map(u => Everygrid.loadConfig(u)));
    return lists.flat();
  }

  /**
   * Create a grid in the element with `id` — the ergonomic form of `mount`. Loads the root config on
   * demand, applies a matching config target or renders with defaults, and returns the instance
   * (null if the element isn't in the DOM). `fetcher` is a URL (streamed) or a `() => Promise<rows>`.
   * Also exported as a standalone `createGrid`.
   */
  public static createGrid<D extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    fetcher?: string | (() => Promise<Record<string, unknown>[]>),
  ): Promise<Everygrid<D> | null> {
    return Everygrid.mount<D>(id, {fetcher});
  }

  /**
   * Tears a mounted grid down completely — React root, WASM engine, worker thread, timers — and
   * makes the target mountable again. Call this when the screen owning the grid goes away.
   *
   * @returns true if a grid was mounted and is now gone
   */
  public static unmount(targetId: string): boolean {
    const instance = Everygrid.instances.get(targetId) as Everygrid | undefined;
    if (!instance) return false;
    instance.destroy();
    return true;
  }

  /**
   * Loads config and mounts every target already present in the DOM.
   *
   * @deprecated Prefer `loadConfig()` + `mount()`. Targets whose element doesn't exist yet are
   * skipped rather than waited for, so a screen that renders its container later must mount it
   * itself.
   * @param apiFetchers Map of data fetch functions or absolute URL strings keyed by target id
   * @param entryConfigUrl Path to the static entry config file (default: /everygrid.config.json)
   */
  public static async autoInit(
    apiFetchers: Record<string, string | (() => Promise<Record<string, unknown>[]>)> = {},
    entryConfigUrl: string = 'everygrid.config.json',
  ): Promise<void> {
    const ids = await Everygrid.loadConfig(entryConfigUrl);
    // Mount sequentially: function-fetchers are awaited, and grids should appear in config order.
    for (const id of ids) {
      if (!document.getElementById(id)) continue;
      await Everygrid.mount(id, {fetcher: apiFetchers[id]});
    }
  }

  /**
   * Fetches a target's data from `url` and loads it in — streaming straight into WASM when
   * the payload is large, otherwise parsing it as one JSON document.
   *
   * Shared by autoInit's first load and by reloadData(), so both take the identical path.
   */
  private async _loadFromUrl(targetId: string, url: string): Promise<void> {
    this._loading.add(targetId);
    try {
      const res = await fetch(url, { cache: this.options.dataCache ?? 'no-store' });
      if (res.ok && res.body) {
        // Two different measures, deliberately:
        //  - the streaming decision needs a *lower bound* on size, and an encoded
        //    Content-Length is exactly that (compressed <= decoded), so a big compressed
        //    payload still streams instead of being buffered whole by res.json().
        //  - progress needs a total comparable to the *decoded* bytes the reader yields,
        //    which an encoded Content-Length is not — see _decodedLength.
        const contentLength = Everygrid._decodedLength(res);
        const declaredLength = contentLength || Number(res.headers.get('Content-Length') ?? NaN);
        // Stream when known-large OR when size is unknown (no comparable length header): a
        // buffered res.json() on an unmeasured-but-large payload spikes memory (whole parse +
        // setData clone) and freezes the tab. Streaming is safe
        // for small payloads too — it just shows the indexing UI briefly. contentLength===0
        // makes _streamJsonToWasm fall back to a "rows ingested" count instead of a fake %.
        const isLarge = isNaN(declaredLength) || declaredLength >= Everygrid.LARGE_PAYLOAD_BYTES;
        if (isLarge) {
          await Everygrid._streamJsonToWasm(this, targetId, res.body, contentLength).catch(err => {
            console.warn('Everygrid: streaming load failed for', targetId, err);
          });
        } else {
          try {
            const json = await res.json();
            const rows: Record<string, unknown>[] = Array.isArray(json) ? json : [json];
            await this._setRows(targetId, rows);
          } catch (err) {
            console.warn('Everygrid: fetch/parse failed for', targetId, err);
          }
        }
      }
    } catch (err) {
      console.warn('Everygrid: fetch failed for', targetId, err);
    } finally {
      this._loading.delete(targetId);
      const el = document.getElementById(targetId);
      if (el) this.renderGrid(el);
    }
  }

  /** Installs freshly loaded rows as the target's data and hands them to its WASM engine. */
  private async _setRows(targetId: string, rows: Record<string, unknown>[]): Promise<void> {
    // Cap first, then treat the capped slice as the data everywhere below — installing the full
    // array would defeat the guard (the whole thing stays in JS memory) and leave the count out
    // of step with what the engine holds.
    rows = this._capRows(targetId, rows);
    this._streamRows.delete(targetId);
    this._streamUrl.delete(targetId);
    this._searchKeysCache.delete(targetId); // recompute autocomplete keys for the new data
    (this.options as { data: unknown[] }).data = rows;
    // The rows just fetched are the new baseline — edits made against the previous load no
    // longer have anything to compare to, so drop them rather than leave stale "modified"
    // markers pointing at cells the server may have changed underneath.
    this.initOriginalDataMap();
    this.activeEditFields.delete(targetId);
    this._wasmRawTotal.set(targetId, rows.length);
    this._wasmDataLoaded.set(targetId, true);
    // This path installs rows whole, so there is no indexing phase to be in. Matters on
    // reload: a target that streamed last time enters 'indexing' on the click, and would sit
    // there forever if its payload came back small enough to take this path instead.
    this._indexingStage.set(targetId, 'ready');

    const engine = await this._awaitEngine(targetId);
    if (!engine) {
      const el = document.getElementById(targetId);
      if (el) this.renderGrid(el);
      return;
    }
    try {
      await this._loadIntoEngine(targetId, engine, rows);
      this._wasmEngineReady.set(targetId, true);
      await this.applyWasmFilter(targetId);
    } catch {
      const el = document.getElementById(targetId);
      if (el) this.renderGrid(el);
    }
  }

  /**
   * The single way rows reach an engine. Queues behind any load already running for the same
   * target, and skips itself if a newer load was requested while it waited — by then its rows
   * are stale and writing them would just undo the newer ones.
   */
  private _loadIntoEngine(targetId: string, engine: GridEngineWasm, rows: unknown[]): Promise<void> {
    const seq = (this._loadSeq.get(targetId) ?? 0) + 1;
    this._loadSeq.set(targetId, seq);
    const run = (this._loadChain.get(targetId) ?? Promise.resolve())
      // A failed predecessor must not poison the queue — the next load still has to run.
      .catch(() => {})
      .then(() => {
        if (this._destroyed || this._loadSeq.get(targetId) !== seq) return;
        return engine.setData(rows);
      });
    this._loadChain.set(targetId, run);
    return run;
  }

  /**
   * Patches edited rows into every ready engine in place, then refreshes the visible page.
   *
   * The alternative, `_loadIntoEngine`, is a full `setData`: it re-uploads and re-indexes the
   * entire dataset to change one cell, and its progress callback puts the indexing bar on
   * screen for every keystroke-sized edit. Rows are addressed by their position in
   * `options.data`, which is the engine's raw row order.
   */
  private _syncRowsToEngines(rows: { index: number; row: unknown }[]): void {
    if (rows.length === 0) return;
    this.options.targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const eng = this._wasmEngines.get(id);
      if (eng && this._wasmEngineReady.get(id)) {
        void eng.updateRows(rows).then(() => this.applyWasmFilter(id)).catch(console.error);
      }
    });
  }

  /** Resolves with the target's engine once it exists, or null if it never shows up. */
  private _awaitEngine(targetId: string, timeoutMs = 10000): Promise<GridEngineWasm | null> {
    const existing = this._wasmEngines.get(targetId);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const startTime = Date.now();
      const poll = setInterval(() => {
        const engine = this._wasmEngines.get(targetId);
        if (engine) {
          clearInterval(poll);
          resolve(engine);
        } else if (this._destroyed) {
          clearInterval(poll);
          resolve(null);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(poll);
          resolve(null);
        }
      }, 50);
    });
  }

  /**
   * Re-fetches a grid's data from the source it was created with and rebuilds its WASM
   * index. No-op for grids whose data was passed in directly (nothing to re-fetch).
   *
   * `silent` marks a reload the host asked for rather than one the reader clicked, so the toolbar's
   * reload button stays as it is. The data still loads with the usual loading UI — the button's
   * spinner reports that *that button* is working, and spinning it for something the reader did not
   * press reads as the grid reloading itself.
   *
   * `discard` says the incoming rows replace the old ones rather than refreshing them — a different
   * query, not the same one again. Holding the previous rows on screen through that is showing an
   * answer to a question nobody asked any more, so the body drops to the loading skeleton the way a
   * first load does. Leave it off for a plain refresh, where the rows on screen stay valid until
   * the new ones land.
   */
  public reloadData(containerId: string, opts: ReloadOptions = {}): Promise<void> {
    if (this._destroyed || !this._dataSource.has(containerId)) return Promise.resolve();
    // Already reloading: fold this request into the follow-up run rather than dropping it. Two
    // requests merge to the stronger of each option — a discard is still a discard, and a button
    // press still shows as one.
    const running = this._reloadRun.get(containerId);
    if (running) {
      const next = this._reloadNext.get(containerId);
      if (next) {
        next.opts = {silent: !!next.opts.silent && !!opts.silent, discard: !!next.opts.discard || !!opts.discard};
        return next.promise;
      }
      const entry = {opts: {...opts}, promise: Promise.resolve()};
      entry.promise = running.then(() => {
        this._reloadNext.delete(containerId);
        return this.reloadData(containerId, entry.opts);
      });
      this._reloadNext.set(containerId, entry);
      return entry.promise;
    }
    const run = this._runReload(containerId, opts).finally(() => {
      if (this._reloadRun.get(containerId) === run) this._reloadRun.delete(containerId);
    });
    this._reloadRun.set(containerId, run);
    return run;
  }

  /** Resolves once the browser has painted — or at once in a hidden tab, where it never will. */
  private static _afterPaint(): Promise<void> {
    return new Promise(resolve => {
      if (typeof document === 'undefined' || document.visibilityState === 'hidden'
          || typeof requestAnimationFrame !== 'function') {
        setTimeout(resolve, 0);
        return;
      }
      // rAF runs just before the paint; the timeout after it runs once the paint is done.
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  private async _runReload(containerId: string, opts: ReloadOptions): Promise<void> {
    const source = this._dataSource.get(containerId);
    if (!source) return;

    this._reloading.set(containerId, opts.silent ? 'silent' : 'button');
    if (opts.discard) {
      // Drop what is on screen so the body falls back to the skeleton: these rows answer the
      // previous query, and the incoming ones are not a newer version of them.
      this._wasmPageCache.delete(containerId);
      this._wasmRawTotal.delete(containerId);
      this._blockCache.delete(containerId);
      // Also the in-memory copy: a virtual grid bridges missing blocks from it while the engine
      // catches up, so leaving it in place would keep serving the previous result's rows straight
      // past the cleared caches.
      (this.options as {data: unknown[]}).data = [];
      this._loading.add(containerId);
      this._discarding.add(containerId);
    }
    // Drop every derived view of the old data so nothing stale can be rendered while the
    // new rows are in flight. NOT _wasmEngineReady: that flag means "the engine finished
    // initialising", which a reload does not undo — the engine object outlives it and only
    // its data is replaced. Clearing it stranded the streaming path, whose loader never sets
    // it back (only _setRows does), so applyWasmFilter bailed out at the end of the load and
    // the grid rendered nothing at all. _wasmDataLoaded already marks the data as stale.
    // NOT _wasmPageCache / _wasmRawTotal: those hold the rows currently on screen, and a reload
    // has something to show the whole time. Dropping them collapsed the grid into a skeleton and
    // back, which read as "the data vanished". Nothing partial leaks in — the streaming path only
    // publishes rows at the end (via applyWasmFilter), so the swap is atomic either way.
    this._streamRows.delete(containerId);
    this._streamTotal.delete(containerId);
    this._indexingAllRows.delete(containerId);
    this._indexingProgress.delete(containerId);
    this._wasmDataLoaded.set(containerId, false);
    this.currentPage.set(containerId, 1);

    // A streaming grid re-enters the same indexing UI its first load used; anything else gets
    // the processing overlay. Keying off _wasStreaming — what this target did last time — is
    // what the toolbar itself already does, so both agree from the click, before any response
    // header has arrived to confirm the payload is still large.
    if (this._wasStreaming.has(containerId)) {
      this._indexingStage.set(containerId, 'indexing');
      // Start the bar at 0 rather than at -1 ("size unknown", which counts rows instead): this
      // target streamed with a known length last time, so a percentage is what it will almost
      // certainly show again, and opening on the other mode just flickers. If the new response
      // turns out to be unmeasurable, _streamJsonToWasm sets -1 and the UI switches over.
      this._indexingProgress.set(containerId, 0);
      this._streamTotal.set(containerId, 0);
    } else {
      this._processing.set(containerId, true);
    }
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);

    try {
      if (typeof source === 'string') {
        this._streamUrl.set(containerId, source);
        await this._loadFromUrl(containerId, source);
      } else {
        // Let the loading UI just rendered reach the screen before the fetcher runs; one that
        // builds its rows synchronously would otherwise block that paint (and whatever the user
        // was interacting with when they asked for the reload).
        await Everygrid._afterPaint();
        await this._setRows(containerId, await source());
      }
    } catch (err) {
      console.warn('Everygrid: reload failed for', containerId, err);
      // Nothing more is coming — leaving the stage on 'indexing' would show a progress UI
      // that can never finish.
      this._indexingStage.set(containerId, 'ready');
    } finally {
      this._reloading.delete(containerId);
      this._processing.delete(containerId);
      this._loading.delete(containerId);
      this._discarding.delete(containerId);
      const el2 = document.getElementById(containerId);
      if (el2) this.renderGrid(el2);
    }
  }

  /**
   * Size in bytes of the body as the reader will actually deliver it, or 0 when unknown.
   *
   * `Content-Length` counts bytes *on the wire*, but `res.body` yields bytes *after* the
   * browser has undone any `Content-Encoding`. For a compressed response the two differ by
   * the compression ratio, so comparing read bytes against Content-Length would report
   * nonsense (an 11x-compressed 1GB file would "finish" at 9%). When the body is encoded we
   * only have a real total if the origin advertises the decoded size out of band, via either
   * header below — `x-amz-meta-uncompressed-length` is what S3 returns for user metadata,
   * and it must also be listed in the bucket's CORS ExposeHeaders to be readable here.
   */
  private static _decodedLength(res: Response): number {
    for (const header of Everygrid.UNCOMPRESSED_LENGTH_HEADERS) {
      const declared = Number(res.headers.get(header) ?? NaN);
      if (!isNaN(declared) && declared > 0) return declared;
    }
    if (res.headers.get('Content-Encoding')) return 0; // encoded: Content-Length is not comparable
    const contentLength = Number(res.headers.get('Content-Length') ?? NaN);
    return !isNaN(contentLength) && contentLength > 0 ? contentLength : 0;
  }

  /**
   * Streams a JSON array from a ReadableStream directly into the WASM engine.
   *
   * The raw fetch bytes are transferred to the worker (zero-copy) without ever being
   * parsed on the main thread — the worker runs the brace-depth scan and feeds complete
   * objects into WASM. This keeps the main thread free during multi-GB loads (no
   * blank-screen freeze) and avoids holding the whole dataset as JS objects on the heap.
   */
  private static async _streamJsonToWasm(
    instance: Everygrid,
    targetId: string,
    body: ReadableStream<Uint8Array>,
    knownContentLength?: number,
  ): Promise<void> {
    const RENDER_INTERVAL_MS = 500;
    const reader = body.getReader();
    const contentLength = (knownContentLength && knownContentLength > 0) ? knownContentLength : 0;
    let total = 0;
    let totalBytes = 0;

    // Wait for the WASM engine, which is created asynchronously during init().
    const engine = await new Promise<GridEngineWasm | undefined>(resolve => {
      const existing = instance._wasmEngines.get(targetId);
      if (existing) { resolve(existing); return; }
      const start = Date.now();
      const poll = setInterval(() => {
        const eng = instance._wasmEngines.get(targetId);
        if (eng) { clearInterval(poll); resolve(eng); }
        else if (instance._destroyed || Date.now() - start > 10000) { clearInterval(poll); resolve(undefined); }
      }, 50);
    });
    if (!engine) {
      console.warn('Everygrid: WASM engine not ready for streaming', targetId);
      reader.releaseLock();
      return;
    }

    // Enter the indexing UI immediately. _streamTotal drives the live "rows loaded" count;
    // rows themselves are shown once the worker has finished indexing.
    instance._wasStreaming.add(targetId);
    instance._indexingStage.set(targetId, 'indexing');
    // -1 = total size unknown, so the UI shows rows ingested instead of a fabricated %.
    instance._indexingProgress.set(targetId, contentLength > 0 ? 0 : -1);
    instance._streamTotal.set(targetId, 0);
    instance._wasmDataLoaded.set(targetId, true);

    // Render via interval so the streaming reader loop is never blocked by React re-renders.
    const doRender = () => {
      const el = document.getElementById(targetId);
      if (el) instance.renderGrid(el);
    };
    doRender();
    const renderTimer = setInterval(doRender, RENDER_INTERVAL_MS);

    // Row cap for this target, if any. Streaming stops once it is reached, so the whole file is
    // never downloaded or held — the point of the guard on the path where OOM actually happens.
    const cap = instance.getDataLimit(targetId);
    instance._dataLimited.delete(targetId);

    try {
      await engine.streamStart(false);
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        // Transfer raw bytes to the worker — the main thread does NO parsing.
        total = await engine.streamChunk(value);
        instance._streamTotal.set(targetId, total);
        // Cap reached: stop reading. The chunk just fed may carry a few rows past the cap (bytes,
        // not rows, are the unit fed), which is fine — memory is bounded to cap + one chunk. The
        // true total is unknown because we stopped early, so the banner reports shown-only.
        if (cap !== undefined && total >= cap) {
          instance._dataLimited.set(targetId, {shown: total, total: null});
          reader.cancel().catch(() => {});
          break;
        }
        if (contentLength > 0) {
          // totalBytes counts what the reader delivered and contentLength is that same
          // (decoded) measure — see _decodedLength — so this ratio is real progress, not an
          // estimate: each streamChunk is awaited, so bytes read == rows parsed into WASM,
          // and no eager index build happens at load (col_index is lazy). Capped at 99%
          // until streamEnd confirms the final flush finished.
          instance._indexingProgress.set(targetId, Math.min(99, Math.round((totalBytes / contentLength) * 100)));
        }
      }
      console.log(`Everygrid: streaming complete for ${targetId}, total rows: ${total}`);

      // Pre-set raw total so toolbar/pagination stay visible through the handoff.
      instance._wasmRawTotal.set(targetId, total);
      instance._indexingProgress.set(targetId, 99);

      // Flush remaining rows + build the index in the worker. reportProgress=true drives
      // the shared 'ready' UI transition (100% shown briefly before the bar hides).
      await engine.streamEnd(true);

      // Streaming counters are no longer needed — WASM is the source of truth now.
      instance._streamTotal.delete(targetId);
      instance._streamUrl.delete(targetId);
      instance._streamRows.delete(targetId);
      instance._wasmDataLoaded.set(targetId, true);

      // A payload this small only streamed because its length was unmeasurable — give it the
      // JS-side copy the buffered path would have installed, so edits work here too.
      if (total > 0 && totalBytes < Everygrid.LARGE_PAYLOAD_BYTES) {
        await Everygrid._materializeStreamedRows(instance, targetId, engine, total);
      }

      // Populate the first page from WASM (suppressProcessing: initial load, not a user action).
      await instance.applyWasmFilter(targetId, true);
    } catch (e) {
      console.warn(`Everygrid: streaming load failed for ${targetId}`, e);
      instance._indexingStage.set(targetId, 'ready');
      doRender();
    } finally {
      clearInterval(renderTimer);
      reader.releaseLock();
    }
  }


  /**
   * Pulls a just-streamed dataset back out of WASM and installs it as `options.data`.
   *
   * Streaming is chosen whenever the response length is unmeasurable, and a compressed CDN
   * response (`Content-Encoding` with no comparable length header) always is — so small payloads
   * routinely take the streaming path in production while taking the buffered one locally. Those
   * targets would otherwise be left with an empty `options.data`, and everything keyed off it —
   * updateData, the modification marker, resetCell — would silently no-op. Only done while the
   * payload really is small; a genuinely large stream keeps WASM as its only copy.
   */
  private static async _materializeStreamedRows(
    instance: Everygrid,
    targetId: string,
    engine: GridEngineWasm,
    total: number,
  ): Promise<void> {
    try {
      const {rows} = await engine.getRawPage(0, total);
      (instance.options as { data: unknown[] }).data = rows;
      instance.initOriginalDataMap();
    } catch (e) {
      console.warn('Everygrid: could not materialize streamed rows for', targetId, e);
    }
  }

  /**
   * Re-renders all grid instances that are currently in the DOM.
   * Grids visible in the viewport are rendered immediately.
   * Grids outside the viewport are rendered lazily via IntersectionObserver.
   * Grids not attached to the DOM are skipped entirely.
   */
  public static refreshAll(): void {
    Everygrid.instances.forEach(grid => {
      const g = grid as Everygrid;
      const targets = g.options.targets ?? [];

      const el = targets.reduce<HTMLElement | null>((found, t) => {
        if (found) return found;
        const id = typeof t === 'string' ? t : t.id;
        return document.getElementById(id);
      }, null);

      if (!el) return;

      const observer = new IntersectionObserver(([entry], obs) => {
        if (entry.isIntersecting) {
          obs.disconnect();
          g.init().catch((err: unknown) => console.error('Everygrid.refreshAll error:', err));
        }
      }, {threshold: 0});

      observer.observe(el);
    });
  }

  /**
   * Re-render every mounted grid immediately — no viewport gating and no data re-fetch. Use this
   * for changes that only affect rendering, like a locale switch (headers, labels, toolbar strings):
   * `refreshAll` would miss grids scrolled out of view and needlessly reload data.
   */
  public static rerenderAll(): void {
    Everygrid.instances.forEach(grid => {
      const g = grid as Everygrid;
      (g.options.targets ?? []).forEach(t => {
        const id = typeof t === 'string' ? t : t.id;
        const el = document.getElementById(id);
        if (el) g.renderGrid(el);
      });
    });
  }

  /**
   * Switch the UI locale and refresh every mounted grid so headers, labels and toolbar strings
   * update — the one call a host app needs on a language change. (Facade over `I18n.setLocale` +
   * `rerenderAll`; use `I18n.setLocale` directly only if you want to set the locale without redraw.)
   */
  public static setLocale(locale: 'ko' | 'en'): void {
    I18n.setLocale(locale);
    Everygrid.rerenderAll();
  }

  // Message type for cross-window (iframe) locale sync — namespaced so it can't collide with the
  // host app's own postMessage traffic.
  private static readonly LOCALE_MESSAGE = 'everygrid:setLocale';

  /**
   * For grids embedded in an iframe / separate window, where the host app's global `setLocale`
   * can't reach them: listen for a locale pushed by the parent (via {@link sendLocale}) and apply it.
   * Call once inside the embedded page. Returns a function that removes the listener.
   *
   * @param opts.origin only accept messages from this origin (recommended for security). Omit to
   *   accept any origin.
   * @param opts.source only accept messages sent from this window (e.g. `window.parent`). Use it
   *   when several places could post a locale and only one is authoritative — messages from any
   *   other window are ignored, so it settles the "which sender wins" ambiguity. Omit to accept
   *   from any window.
   */
  public static listenForLocale(opts: {origin?: string; source?: Window | null} = {}): () => void {
    const handler = (e: MessageEvent) => {
      if (opts.origin && e.origin !== opts.origin) return;
      if (opts.source && e.source !== opts.source) return;
      const data = e.data as {type?: unknown; locale?: unknown} | null;
      if (data && data.type === Everygrid.LOCALE_MESSAGE && (data.locale === 'ko' || data.locale === 'en')) {
        Everygrid.setLocale(data.locale);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  /**
   * Push the current locale to an embedded grid window (an iframe's `contentWindow`) whose page
   * called {@link listenForLocale}. The parent/host side of the same handshake.
   *
   * @param target the embedded window to deliver to (e.g. an iframe's `contentWindow`).
   * @param locale the locale to apply in the target — `'ko'` or `'en'`.
   * @param targetOrigin restrict delivery to this origin (recommended); defaults to any (`'*'`).
   */
  public static sendLocale(target: Window, locale: 'ko' | 'en', targetOrigin: string = '*'): void {
    target.postMessage({type: Everygrid.LOCALE_MESSAGE, locale}, targetOrigin);
  }

  public closePopup() {
    this.activePopup = null;
    this.activePopupData = null;
    this.activePopupTitle = null;
    this.activePopupRow = null;
    this.activePopupRowKey = null;
    const {targets} = this.options;
    targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) this.renderGrid(container);
    });
  }

  public isColumnNumeric(field: string): boolean {
    const data = (this.options.data || []) as T[];
    if (data.length === 0) {
      return false;
    }

    // Use first 100 rows for sampling to improve performance on large datasets
    const sampleSize = Math.min(data.length, 100);
    let foundNumeric = false;
    for (let i = 0; i < sampleSize; i++) {
      const item = data[i];
      const value = item[field];

      if (typeof value === 'boolean') {
        return false;
      }

      if (value !== null && value !== undefined && String(value).trim() !== '') {
        if (this.isDate(value)) {
          return false;
        }
        if (isNaN(Number(value))) {
          return false;
        }
        foundNumeric = true;
      }
    }
    return foundNumeric;
  }

  /** True when every non-empty value in the sampled rows is a boolean. */
  public isColumnBoolean(field: string): boolean {
    const data = (this.options.data || []) as T[];
    const sampleSize = Math.min(data.length, 100);
    let found = false;
    for (let i = 0; i < sampleSize; i++) {
      const value = data[i][field];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value !== 'boolean') return false;
      found = true;
    }
    return found;
  }

  public isColumnDate(field: string): boolean {
    const data = (this.options.data || []) as T[];
    if (data.length === 0) {
      return false;
    }

    const sampleSize = Math.min(data.length, 100);
    let foundDate = false;
    for (let i = 0; i < sampleSize; i++) {
      const item = data[i];
      const value = item[field];
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        if (!this.isDate(value)) {
          return false;
        }
        foundDate = true;
      }
    }
    return foundDate;
  }

  public isColumnObject(field: string): boolean {
    const data = (this.options.data || []) as T[];
    if (data.length === 0) {
      return false;
    }
    const sampleSize = Math.min(data.length, 100);
    for (let i = 0; i < sampleSize; i++) {
      const val = data[i][field];
      if ((typeof val === 'object' && val !== null) || isJsonString(val)) {
        return true;
      }
    }
    return false;
  }

  public getGridTitle(containerId: string): string | undefined {
    const config = this.options.targets?.find(c => {
      if (typeof c === 'string') {
        return c === containerId;
      }
      return c.id === containerId;
    });
    if (config && typeof config !== 'string') {
      return config.title || undefined;
    }
    return undefined;
  }


  public resetColumnWidths(container: HTMLElement) {
    const containerId = container.id;
    this.columnWidths.delete(containerId);

    // Reset DOM inline styles
    const tables = container.querySelectorAll('.everygrid-table') as NodeListOf<HTMLElement>;
    tables.forEach(table => {
      table.style.tableLayout = '';
      table.style.width = '';
      table.style.minWidth = '';

      const ths = table.querySelectorAll('thead th') as NodeListOf<HTMLElement>;
      ths.forEach(th => {
        th.style.width = '';
        th.style.minWidth = '';
      });
    });

    this.renderGrid(container);
  }

  // ---- Row add / delete ------------------------------------------------------------------------

  public getRowActions(containerId: string): {insertRow: boolean; deleteRow: boolean} {
    const conf = this.options.rowActions?.find(c => c.id === containerId);
    return {insertRow: !!conf?.insertRow, deleteRow: !!conf?.deleteRow};
  }

  /** The live reference for a row the grid handed out (a WASM copy is matched by content). */
  private _liveRef(row: T): T {
    const data = (this.options.data || []) as T[];
    const i = this._indexOfRow(row);
    return i === -1 ? row : data[i];
  }

  public isRowInserted(row: T): boolean {
    return this._insertedRows.has(this._liveRef(row));
  }

  public isRowDeleted(row: T): boolean {
    return this._deletedRows.has(this._liveRef(row));
  }

  /**
   * Inserts a new row at `at` (default: the top) and returns it. Every data field starts empty
   * unless `values` supplies it. The row is tracked as inserted: revert drops it, commit keeps it.
   */
  public insertRow(containerId: string, values: Partial<T> = {}, at = 0): T {
    const data = (this.options.data || []) as T[];
    // Empty cells are null — what clearing a cell in the editor produces — so the row reads as
    // "unset" everywhere (type detection skips it, the patch carries null, not "").
    const row = {} as Record<string, unknown>;
    for (const f of this.getDataFields(containerId)) row[f] = null;
    Object.assign(row, values);
    const index = Math.max(0, Math.min(at, data.length));
    data.splice(index, 0, row as T);
    this._insertedRows.add(row as T);
    // Registered so the render path maps the engine's copy of it back to this reference.
    this._editedKeys.set(JSON.stringify(row), row as T);
    this._insertRowsToEngines(index, [row]);
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);
    this._emitChange(containerId);
    return row as T;
  }

  /**
   * Marks a row deleted. It stays on screen struck through and can be restored; commit removes
   * it. Deleting a row that was only just inserted simply drops it.
   */
  public deleteRow(containerId: string, rowData: T): void {
    const row = this._liveRef(rowData);
    const data = (this.options.data || []) as T[];
    const index = data.indexOf(row);
    if (index === -1) return;
    if (this._insertedRows.has(row)) {
      this._dropRows(containerId, [row]);
    } else {
      this._deletedRows.add(row);
      this._editedKeys.set(JSON.stringify(row), row);
    }
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);
    this._emitChange(containerId);
  }

  /** Undoes a delete. */
  public restoreRow(containerId: string, rowData: T): void {
    const row = this._liveRef(rowData);
    if (!this._deletedRows.delete(row)) return;
    if (!this.originalDataMap.has(row)) this._editedKeys.delete(JSON.stringify(row));
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);
    this._emitChange(containerId);
  }

  /** Physically removes rows from the data and the engine, and forgets everything about them. */
  private _dropRows(containerId: string, rows: T[]): void {
    const data = (this.options.data || []) as T[];
    const indices = rows.map(r => data.indexOf(r)).filter(i => i !== -1).sort((a, b) => b - a);
    for (const i of indices) data.splice(i, 1);
    for (const r of rows) {
      this._insertedRows.delete(r);
      this._deletedRows.delete(r);
      this.originalDataMap.delete(r);
      this._editedKeys.delete(JSON.stringify(r));
    }
    this._removeRowsFromEngines(indices);
    void containerId;
  }

  private _insertRowsToEngines(index: number, rows: unknown[]): void {
    this.options.targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const eng = this._wasmEngines.get(id);
      if (eng && this._wasmEngineReady.get(id)) {
        void eng.insertRows(index, rows).then(() => this.applyWasmFilter(id)).catch(console.error);
      }
    });
  }

  private _removeRowsFromEngines(indices: number[]): void {
    if (indices.length === 0) return;
    this.options.targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const eng = this._wasmEngines.get(id);
      if (eng && this._wasmEngineReady.get(id)) {
        void eng.removeRows(indices).then(() => this.applyWasmFilter(id)).catch(console.error);
      }
    });
  }

  // ---- Checkbox column --------------------------------------------------------------------------

  /** The field whose value a checked row is remembered by (`checkbox.mapping`), if configured. */
  public getCheckboxMapping(containerId: string): string | undefined {
    const confs = Array.isArray(this.options.checkbox) ? this.options.checkbox : [];
    const conf = confs.find(c => c.id === containerId);
    return conf && (conf.active ?? true) ? conf.mapping : undefined;
  }

  public getCheckedValues(containerId: string): unknown[] {
    return Array.from(this.checkedValues.get(containerId) ?? []);
  }

  /** The rows currently checked, in data order. */
  public getCheckedRows(containerId: string): T[] {
    const mapping = this.getCheckboxMapping(containerId);
    const set = this.checkedValues.get(containerId);
    if (!mapping || !set || set.size === 0) return [];
    return ((this.options.data || []) as T[]).filter(row => set.has(row[mapping]));
  }

  /**
   * Checks or unchecks rows by their mapping values — the one path every checkbox change takes,
   * from the UI or the API, so the `check` event sees all of them.
   */
  public setChecked(containerId: string, values: unknown[], checked: boolean): void {
    const set = this.checkedValues.get(containerId) ?? new Set();
    const changed: unknown[] = [];
    for (const v of values) {
      if (checked ? !set.has(v) : set.has(v)) {
        if (checked) set.add(v); else set.delete(v);
        changed.push(v);
      }
    }
    this.checkedValues.set(containerId, set);
    if (changed.length === 0) return;
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);
    this._emit('check', {values: Array.from(set), rows: this.getCheckedRows(containerId), changed, checked});
  }

  public clearChecked(containerId: string): void {
    this.setChecked(containerId, this.getCheckedValues(containerId), false);
  }

  // ---- Change tracking (the GridHandle API) --------------------------------------------------

  private _listeners: Map<keyof GridEvents<T>, Set<(arg: unknown) => void>> = new Map();

  /** Subscribe to `cellChange` / `change`; returns the unsubscribe function. */
  public on<K extends keyof GridEvents<T>>(event: K, handler: GridEvents<T>[K]): () => void {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    const fn = handler as unknown as (arg: unknown) => void;
    set.add(fn);
    return () => { set.delete(fn); };
  }

  private _emit<K extends keyof GridEvents<T>>(event: K, arg: Parameters<GridEvents<T>[K]>[0]): void {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of set) fn(arg);
  }

  /** Fires `change` with the current change set; every edit, revert and commit ends here. */
  private _emitChange(containerId: string): void {
    if (this._listeners.get('change')?.size) this._emit('change', this._changedRows(containerId));
  }

  /** The row's key per the `rowKey` config, else its index. */
  public _keyOf(containerId: string, row: T, index: number): RowKey {
    const conf = this.options.rowKey?.find(c => c.id === containerId);
    if (!conf) return index;
    const fields = Array.isArray(conf.field) ? conf.field : [conf.field];
    const parts = fields.map(f => row[f]);
    if (parts.length === 1) {
      const v = parts[0];
      return typeof v === 'number' ? v : String(v);
    }
    return parts.map(String).join('|');
  }

  public _indexOfKey(containerId: string, key: RowKey): number {
    const data = (this.options.data || []) as T[];
    if (!this.options.rowKey?.some(c => c.id === containerId)) {
      return typeof key === 'number' && key >= 0 && key < data.length ? key : -1;
    }
    return data.findIndex((row, i) => this._keyOf(containerId, row, i) === key);
  }

  /** Data index of a row handed out by the grid — a WASM copy is matched by content. */
  public _indexOfRow(row: T): number {
    const data = (this.options.data || []) as T[];
    const live = this._editedKeys.get(JSON.stringify(row)) ?? row;
    const idx = data.indexOf(live);
    if (idx !== -1) return idx;
    const key = JSON.stringify(row);
    return data.findIndex(d => JSON.stringify(d) === key);
  }

  public _originalOf(row: T): T {
    return this.originalDataMap.get(row) ?? row;
  }

  public _cellChanges(row: T): CellChange[] {
    const original = this.originalDataMap.get(row);
    if (!original) return [];
    const fields = new Set([...Object.keys(original), ...Object.keys(row)]);
    const out: CellChange[] = [];
    for (const field of fields) {
      if (this.isCellModified(row, field)) out.push({field, from: original[field], to: row[field]});
    }
    return out;
  }

  /**
   * Every row that differs from the loaded data: inserted, deleted, or edited so that it still
   * differs from its original. Inserted rows carry their current values and no cell list; deleted
   * rows their original and no cell list.
   */
  public _changedRows(containerId: string): RowChange<T>[] {
    const data = (this.options.data || []) as T[];
    const out: RowChange<T>[] = [];
    for (const row of this._editedKeys.values()) {
      const index = data.indexOf(row);
      if (index === -1) continue;
      // The key is taken from the original row: if the key field itself was edited, a save still
      // has to find the record by the key the server knows.
      const original = this._originalOf(row);
      const key = this._keyOf(containerId, original, index);
      if (this._insertedRows.has(row)) {
        out.push({status: 'inserted', index, key, row, original: row, cells: []});
      } else if (this._deletedRows.has(row)) {
        out.push({status: 'deleted', index, key, row, original, cells: []});
      } else {
        const cells = this._cellChanges(row);
        if (cells.length > 0) out.push({status: 'updated', index, key, row, original, cells});
      }
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /**
   * Accepts the current state as the new baseline: deleted rows are removed for good, inserted row
   * become ordinary rows, and no row is modified any more.
   */
  public commit(containerId: string): void {
    this._dropRows(containerId, Array.from(this._deletedRows));
    this._insertedRows.clear();
    this.originalDataMap.clear();
    this._editedKeys.clear();
    const el = document.getElementById(containerId);
    if (el) this.renderGrid(el);
    this._emitChange(containerId);
  }

  /**
   * Walks only the rows that have been edited, not the whole dataset. This runs on every render,
   * including the synchronous one per scroll event, and over a million rows the full scan cost
   * ~300ms a frame — the main thread fell that far behind the compositor, which is what the blank
   * band during a scroll actually was. _editedKeys is maintained by every path that mutates a row.
   */
  public checkHasChanges(): boolean {
    if (this._insertedRows.size > 0 || this._deletedRows.size > 0) return true;
    for (const item of this._editedKeys.values()) {
      if (!this.originalDataMap.has(item)) continue;
      if (Object.keys(item).some(field => this.isCellModified(item, field))) return true;
    }
    return false;
  }

  /** Server-side paging: calls serverFetcher, loads the result into WASM, and re-renders */
  public async fetchServerPage(containerId: string): Promise<void> {
    if (!this.options.serverFetcher || this._serverFetching.get(containerId)) return;
    const paginationConfig = this.getPagination(containerId);
    if (!paginationConfig?.serverSide) return;

    this._serverFetching.set(containerId, true);
    const pageSize = Math.min((paginationConfig.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10, 100);
    const currentPage = this.currentPage.get(containerId) || 1;
    const sortInfo = this.sortConfig.get(containerId);

    const params: ServerFetchParams = {
      page: currentPage - 1,
      pageSize,
      sortField: sortInfo?.direction ? sortInfo.field : undefined,
      sortAsc: sortInfo?.direction === 'asc',
      filterText: this.filterText || undefined,
    };

    try {
      const result = await this.options.serverFetcher(params);
      this._serverTotal.set(containerId, result.total);
      (this.options as GridOptions<T>).data = result.data as T[];
      this.initOriginalDataMap();
      // Server-side: sync current page data to the WASM engine
      const engine = this._wasmEngines.get(containerId);
      if (engine && this._wasmEngineReady.get(containerId)) {
        this._loadIntoEngine(containerId, engine, this.options.data as unknown[]).then(() => {
          this.applyWasmFilter(containerId).catch(console.error);
        }).catch(console.error);
      }
      const el = document.getElementById(containerId);
      if (el) this.renderGrid(el);
    } catch (err) {
      console.error('Everygrid: serverFetcher failed:', err);
    } finally {
      this._serverFetching.set(containerId, false);
    }
  }

  /** Applies the current filter/sort state to the WASM engine, fetches the current page, caches result, then re-renders */
  public async applyWasmFilter(containerId: string, suppressProcessing = false): Promise<void> {
    const engine = this._wasmEngines.get(containerId);
    if (!engine || !this._wasmEngineReady.get(containerId)) {
      // No WASM engine yet — just render with JS data
      const el = document.getElementById(containerId);
      if (el) this.renderGrid(el);
      return;
    }
    // Sequence number to detect stale (superseded) calls
    const seq = (this._filterSeq.get(containerId) ?? 0) + 1;
    this._filterSeq.set(containerId, seq);
    const sortInfo = this.sortConfig.get(containerId);
    const sortField = (sortInfo && sortInfo.direction) ? sortInfo.field : '';
    const sortAsc = (sortInfo && sortInfo.direction) ? sortInfo.direction === 'asc' : true;
    const hasFilterOrSort = !!this.filterText || !!sortField;
    // Show loading indicator after 150ms delay only when filter/sort is active (avoids flicker for fast ops)
    let processingTimer: ReturnType<typeof setTimeout> | undefined;
    if (hasFilterOrSort && !suppressProcessing) {
      // Cancel a timer left by a prior (superseded) call — otherwise it fires after this call's
      // finally has cleared _processing, flipping it back on with nothing left to clear it.
      const prevTimer = this._processingTimer.get(containerId);
      if (prevTimer !== undefined) clearTimeout(prevTimer);
      processingTimer = setTimeout(() => {
        // Only the latest call may raise the indicator; a stale timer must not.
        if (this._filterSeq.get(containerId) !== seq) return;
        this._processing.set(containerId, true);
        const elBefore = document.getElementById(containerId);
        if (elBefore) this.renderGrid(elBefore);
      }, 150);
      this._processingTimer.set(containerId, processingTimer);
    }
    try {
      // Single atomic Worker call: filter+sort+getPage+rawCount — no interleaving possible
      const paginationConfig = this.getPagination(containerId);
      const isPaginationActive = (paginationConfig?.active ?? true);
      const pageSize = Math.min((paginationConfig?.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10, 100);
      const currentPage = this.currentPage.get(containerId) || 1;
      // Virtual mode has no page to land on: a filter/sort always returns to the top of the
      // result, so it fetches block 0 and seeds the block cache with it — the first screenful
      // is already there when the scroller re-renders.
      const virtual = this.getVirtualScroll(containerId);
      const pageIndex = (virtual || !isPaginationActive) ? 0 : currentPage - 1;
      const fetchSize = virtual ? this._blockSize(containerId) : (isPaginationActive ? pageSize : 10000);
      const result = await engine.filterSortAndGetPage(this.filterText, sortField, sortAsc, pageIndex, fetchSize);
      // If a newer call has been issued, skip caching and rendering
      if (this._filterSeq.get(containerId) !== seq) return;
      this._wasmPageCache.set(containerId, { rows: result.rows, total: result.filtered });
      if (virtual) {
        this._blockCache.set(containerId, {seq, blocks: new Map([[0, result.rows]]), order: [0]});
        this._blockPending.delete(containerId);
      }
      this._wasmRawTotal.set(containerId, result.raw);
    } finally {
      // Only clean up processing state if this is still the latest call
      if (this._filterSeq.get(containerId) === seq) {
        const timer = this._processingTimer.get(containerId);
        if (timer !== undefined) { clearTimeout(timer); this._processingTimer.delete(containerId); }
        this._processing.delete(containerId);
        const el = document.getElementById(containerId);
        if (el) this.renderGrid(el);
      }
    }
  }

  /**
   * Fetches only the requested page from WASM, reusing the already-computed filtered/sorted
   * result (no re-filter, no re-sort). Use this for page navigation when the filter and sort
   * are unchanged — it slices the cached result in O(pageSize) instead of rescanning every row.
   */
  public async fetchWasmPage(containerId: string): Promise<void> {
    const engine = this._wasmEngines.get(containerId);
    if (!engine || !this._wasmEngineReady.get(containerId)) {
      const el = document.getElementById(containerId);
      if (el) this.renderGrid(el);
      return;
    }
    // Share the filter sequence so a concurrent filter/sort supersedes this page fetch.
    const seq = (this._filterSeq.get(containerId) ?? 0) + 1;
    this._filterSeq.set(containerId, seq);
    try {
      const paginationConfig = this.getPagination(containerId);
      const isPaginationActive = (paginationConfig?.active ?? true);
      const pageSize = Math.min((paginationConfig?.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10, 100);
      const currentPage = this.currentPage.get(containerId) || 1;
      const pageIndex = isPaginationActive ? currentPage - 1 : 0;
      const result = await engine.getPage(pageIndex, isPaginationActive ? pageSize : 10000);
      // If a newer call (page change or filter/sort) was issued, drop this stale result.
      if (this._filterSeq.get(containerId) !== seq) return;
      this._wasmPageCache.set(containerId, { rows: result.rows, total: result.total });
    } finally {
      if (this._filterSeq.get(containerId) === seq) {
        const el = document.getElementById(containerId);
        if (el) this.renderGrid(el);
      }
    }
  }

  /** @deprecated Replaced by applyWasmFilter */
  public applyWasmState(containerId: string): void {
    this.applyWasmFilter(containerId).catch(console.error);
  }

  /** For rendering: reads and returns the current page data directly from the WASM engine or JS stream rows */
  public getDisplayItems(containerId: string, items: T[]): T[] {
    const paginationConfig = this.getPagination(containerId);

    // --- Server-side path: data is already the current page ---
    if (paginationConfig?.serverSide && this.options.serverFetcher) {
      return items;
    }

    const isPaginationActive = (paginationConfig?.active ?? true);
    const pageSize = Math.min((paginationConfig?.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10, 100);
    const currentPage = this.currentPage.get(containerId) || 1;
    const pageIndex = isPaginationActive ? currentPage - 1 : 0;

    // --- Streaming mode: filter/sort in JS, then slice ---
    const streamRows = this._streamRows.get(containerId);
    if (streamRows) {
      const filtered = this._applyStreamFilter(containerId, streamRows);
      if (isPaginationActive) {
        const start = pageIndex * pageSize;
        return filtered.slice(start, start + pageSize) as T[];
      }
      return filtered as T[];
    }

    // --- WASM not ready: fallback to JS data ---
    const engine = this._wasmEngines.get(containerId);
    if (!engine || !this._wasmEngineReady.get(containerId)) {
      if (isPaginationActive) {
        const start = pageIndex * pageSize;
        return items.slice(start, start + pageSize);
      }
      return items;
    }

    // Use cached WASM page result (populated by applyWasmFilter)
    const cached = this._wasmPageCache.get(containerId);
    if (cached) {
      const rows = cached.rows as T[];
      // WASM returns fresh row copies; swap edited ones for their live reference so the
      // modification marker (reference-based isCellModified) and reset button work.
      if (this._editedKeys.size > 0) {
        return rows.map(r => this._editedKeys.get(JSON.stringify(r)) ?? r);
      }
      return rows;
    }
    // Cache not yet populated (e.g. during WASM handoff / indexing) — fall back to JS items
    if (isPaginationActive) {
      const start = pageIndex * pageSize;
      return items.slice(start, start + pageSize);
    }
    return items;
  }

  /** @deprecated Cache invalidation is no longer needed since data is read directly from WASM. Kept for backward compatibility. */
  public invalidateSortCache(_containerId?: string) { /* no-op */ }

  /** Sets the text filter and re-renders the grid */
  public setFilter(text: string, container?: HTMLElement) {
    this.filterText = text;
    const {targets} = this.options;
    const targetList = container ? [{id: container.id}] : (targets ?? []);
    targetList.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      this.currentPage.set(id, 1);
      const paginationConfig = this.getPagination(id);
      if (paginationConfig?.serverSide && this.options.serverFetcher) {
        this.fetchServerPage(id).catch(console.error);
      } else if (this._streamRows.has(id) || this._streamTotal.has(id)) {
        // Streaming mode (JS rows or count-only): filter/sort in JS, just re-render
        const el = document.getElementById(id);
        if (el) this.renderGrid(el);
      } else {
        this.applyWasmFilter(id).catch(console.error);
      }
    });
  }

  /** Total row count after filter is applied (used for pagination calculation) */
  public getFilteredTotal(containerId: string): number {
    // Streaming mode (JS rows not yet handed off to WASM)
    const streamRows = this._streamRows.get(containerId);
    if (streamRows) {
      const filtered = this._applyStreamFilter(containerId, streamRows);
      return filtered.length;
    }
    // Streaming count-only phase (before any rows parsed). Skipped when the live count is still
    // 0 but a page cache survives: that's a reload streaming in over rows already on screen, and
    // reporting 0 would collapse the pagination we're deliberately keeping up (just disabled).
    const streamTotal = this._streamTotal.get(containerId);
    if (streamTotal !== undefined && (streamTotal > 0 || !this._wasmPageCache.has(containerId))) {
      return streamTotal;
    }
    const engine = this._wasmEngines.get(containerId);
    if (!engine || !this._wasmEngineReady.get(containerId)) {
      const items = (this.options.data || []) as T[];
      return items.length;
    }
    // Use cached total from WASM (populated by applyWasmFilter)
    const cached = this._wasmPageCache.get(containerId);
    if (cached) return cached.total;
    // During WASM handoff/indexing: _wasmRawTotal is pre-set so toolbar stays visible
    const rawTotal = this._wasmRawTotal.get(containerId);
    if (rawTotal !== undefined) return rawTotal;
    return 0;
  }

  /** Parse filter text supporting && (AND) and || (OR) operators */
  /**
   * Lower-cased searchable text for a cell value, mirroring the WASM engine: nested objects/arrays
   * are matched by their JSON serialization (lib.rs FieldVal::Json), not "[object Object]". Keeping
   * this in sync is what makes the JS re-filter (used for the 'filtered' Excel export) select the
   * same rows the visible WASM-filtered grid shows.
   */
  private static _searchText(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'object') {
      try { return JSON.stringify(v).toLowerCase(); } catch { return ''; }
    }
    return String(v).toLowerCase();
  }

  private _parseFilterExpr(text: string): (row: Record<string, unknown>) => boolean {
    const trimmed = text.trim();
    if (!trimmed) return () => true;
    // OR has lower precedence than AND
    const orParts = trimmed.split('||').map(p => p.trim()).filter(p => p.length > 0);
    const orMatchers = orParts.map(orPart => {
      const andParts = orPart.split('&&').map(p => p.trim()).filter(p => p.length > 0);
      return (row: Record<string, unknown>) =>
        andParts.every(term =>
          Object.values(row).some(v => Everygrid._searchText(v).includes(term.toLowerCase()))
        );
    });
    return (row: Record<string, unknown>) => orMatchers.some(m => m(row));
  }

  /** Filter/sort JS stream rows without WASM */
  private _applyStreamFilter(containerId: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    // Fast path: no filter, no sort
    if (!this.filterText && !this.sortConfig.get(containerId)?.direction) return rows;
    let result = rows;
    if (this.filterText) {
      const matcher = this._parseFilterExpr(this.filterText);
      result = result.filter(matcher);
    }
    const sortInfo = this.sortConfig.get(containerId);
    if (sortInfo && sortInfo.direction) {
      const { field, direction } = sortInfo;
      result = [...result].sort((a, b) => {
        const av = a[field] ?? '';
        const bv = b[field] ?? '';
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return direction === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }

  public getPagination(containerId: string): GridPaginationConfig | undefined {
    if (this.options.pagination) {
      if (Array.isArray(this.options.pagination)) {
        return this.options.pagination.find(p => p.id === containerId);
      } else if ('active' in this.options.pagination || 'pageSize' in this.options.pagination) {
        return this.options.pagination as GridPaginationConfig;
      }
    }
    return undefined;
  }

  /**
   * Rows this device can safely hold, for `dataLimit: 'auto'`. Derived from reported RAM
   * (`navigator.deviceMemory`, Chromium only) and whether the device looks mobile. Conservative on
   * purpose — a grid that loads beats one that shows everything and crashes the tab.
   */
  private static _deviceRowBudget(): number | null {
    const nav = (typeof navigator !== 'undefined' ? navigator : undefined) as
      (Navigator & {deviceMemory?: number; userAgentData?: {mobile?: boolean}}) | undefined;
    if (!nav) return null;
    const mem = nav.deviceMemory; // GB, or undefined
    const width = typeof window !== 'undefined'
      ? Math.min(window.innerWidth || Infinity, window.screen?.width || Infinity)
      : Infinity;
    const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    const mobile = !!nav.userAgentData?.mobile
      || /Mobi|Android|iPhone|iPod|iPad/i.test(nav.userAgent)
      || (coarse && nav.maxTouchPoints > 0 && width < 820);
    if (mobile || width < 820) {
      // ~3k rows per GB, floored so even a 1–2GB phone shows a working grid; 5k when RAM is unknown.
      return mem ? Math.max(3000, Math.round(mem * 3000)) : 5000;
    }
    if (mem && mem <= 4) return 25000; // low-RAM laptop
    return null; // roomy desktop — no cap
  }

  public getDataLimit(containerId: string): number | undefined {
    const dl = this.options.dataLimit;
    if (!dl) return undefined;
    const conf = Array.isArray(dl) ? dl.find(d => d.id === containerId) : (dl.id === containerId ? dl : undefined);
    if (!conf || conf.active === false || conf.maxRows === undefined) return undefined;
    const cap = conf.maxRows === 'auto' ? Everygrid._deviceRowBudget() : conf.maxRows;
    return (typeof cap === 'number' && cap > 0) ? Math.floor(cap) : undefined;
  }

  /**
   * Applies the row cap to an in-memory array. Returns the (possibly sliced) rows and records the
   * cap so the banner can report it. A no-op when there is no cap or the data is within it.
   */
  private _capRows(targetId: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const cap = this.getDataLimit(targetId);
    if (cap === undefined || rows.length <= cap) {
      this._dataLimited.delete(targetId);
      return rows;
    }
    this._dataLimited.set(targetId, {shown: cap, total: rows.length});
    return rows.slice(0, cap);
  }

  public getVirtualScroll(containerId: string): GridVirtualScrollConfig | undefined {
    const vs = this.options.virtualScroll;
    if (!vs) return undefined;
    const conf = Array.isArray(vs) ? vs.find(v => v.id === containerId) : (vs.id === containerId ? vs : undefined);
    if (!conf || conf.active === false) return undefined;
    // Server-side pagination owns its own windowing contract (page/pageSize requests), so the two
    // can't both drive the view. Pagination wins; virtual scroll stays off for that target.
    if (this.getPagination(containerId)?.serverSide && this.options.serverFetcher) return undefined;
    return conf;
  }

  /** Resolved block size for a virtualised target — the unit every engine fetch is aligned to. */
  private _blockSize(containerId: string): number {
    const size = this.getVirtualScroll(containerId)?.blockSize;
    return (size && size > 0) ? Math.min(size, 1000) : VIRTUAL_BLOCK_SIZE;
  }

  /**
   * Rows for [start, end) of the current filtered result. Synchronous: whatever is cached comes
   * back immediately, missing blocks come back as `undefined` holes and are fetched in the
   * background. Callers render a placeholder for the holes; the fetch re-renders when it lands.
   */
  public getRowsInRange(containerId: string, start: number, end: number): (T | undefined)[] {
    if (end <= start) return [];

    // Streaming mode: rows are already in JS memory, so the window is a plain slice.
    const streamRows = this._streamRows.get(containerId);
    if (streamRows) {
      return this._applyStreamFilter(containerId, streamRows).slice(start, end) as T[];
    }

    const engine = this._wasmEngines.get(containerId);
    if (!engine || !this._wasmEngineReady.get(containerId)) {
      return ((this.options.data || []) as T[]).slice(start, end);
    }

    const blockSize = this._blockSize(containerId);
    const seq = this._filterSeq.get(containerId) ?? 0;
    let cache = this._blockCache.get(containerId);
    if (!cache || cache.seq !== seq) {
      // A new filter/sort generation invalidates every cached block at once.
      cache = {seq, blocks: new Map(), order: []};
      this._blockCache.set(containerId, cache);
    }

    // Bridge source for blocks that are still loading. In natural order (no filter/sort) the
    // absolute row index maps straight to the in-memory data, so a missing block can borrow from
    // it instead of rendering a blank. This kills the data→blank→data flash on the JS→WASM handoff:
    // the moment the engine turns ready, getPage's block cache is empty, and without this fallback
    // the whole window would blank out until the first block arrives. A filter/sort makes
    // options.data (unfiltered) the wrong source, so we skip the bridge and let those blanks stand.
    // Not while discarding: the bridge exists to cover the JS→WASM handoff on a load whose rows are
    // already the ones on screen. Through a discard the body should read as loading, not hand back
    // rows the engine has not taken yet.
    const naturalOrder = !this.filterText && !this.sortConfig.get(containerId)?.direction
      && !this._discarding.has(containerId);
    const jsData = naturalOrder ? ((this.options.data || []) as T[]) : undefined;

    const out: (T | undefined)[] = [];
    const firstBlock = Math.floor(start / blockSize);
    const lastBlock = Math.floor((end - 1) / blockSize);
    for (let b = firstBlock; b <= lastBlock; b++) {
      const block = cache.blocks.get(b);
      if (!block) this._fetchBlock(containerId, b, seq);
      const blockStart = b * blockSize;
      const from = Math.max(start, blockStart);
      const to = Math.min(end, blockStart + blockSize);
      for (let i = from; i < to; i++) {
        const row = (block?.[i - blockStart] as T | undefined) ?? jsData?.[i];
        // WASM hands back fresh copies; swap edited rows for their live reference so the
        // modification marker (reference-based isCellModified) and reset keep working.
        out.push(row && this._editedKeys.size > 0 ? (this._editedKeys.get(JSON.stringify(row)) ?? row) : row);
      }
    }
    // Prefetch the neighbours. A block is many screenfuls tall, so asking for the next one while
    // the reader is still inside this one lands it well before the window crosses the boundary —
    // without it every crossing showed a band of placeholders for one worker round trip.
    const lastValid = Math.floor(Math.max(0, this.getFilteredTotal(containerId) - 1) / blockSize);
    if (firstBlock > 0 && !cache.blocks.has(firstBlock - 1)) this._fetchBlock(containerId, firstBlock - 1, seq);
    if (lastBlock < lastValid && !cache.blocks.has(lastBlock + 1)) this._fetchBlock(containerId, lastBlock + 1, seq);
    return out;
  }

  /** Fetches one block from the engine into the cache, then coalesces a re-render. */
  private _fetchBlock(containerId: string, blockIndex: number, seq: number): void {
    let pending = this._blockPending.get(containerId);
    if (!pending) { pending = new Set(); this._blockPending.set(containerId, pending); }
    const key = `${seq}:${blockIndex}`;
    if (pending.has(key)) return;
    pending.add(key);

    const engine = this._wasmEngines.get(containerId);
    if (!engine) return;
    const blockSize = this._blockSize(containerId);
    engine.getPage(blockIndex, blockSize).then(result => {
      pending.delete(key);
      // The generation moved on while this was in flight — the rows belong to a result set that
      // is no longer on screen, so they must not be cached under the new seq.
      const cache = this._blockCache.get(containerId);
      if (this._destroyed || !cache || cache.seq !== seq || this._filterSeq.get(containerId) !== seq) return;
      cache.blocks.set(blockIndex, result.rows);
      cache.order.push(blockIndex);
      while (cache.order.length > VIRTUAL_BLOCK_CACHE_MAX) {
        const evicted = cache.order.shift();
        if (evicted !== undefined) cache.blocks.delete(evicted);
      }
      this._scheduleVirtualRender(containerId);
    }).catch(err => {
      pending.delete(key);
      console.error('Everygrid: virtual block fetch failed:', err);
    });
  }

  /**
   * Blocks land one by one but a fast scroll requests several at once, so renders are coalesced
   * into a single pass instead of one per arriving block.
   *
   * A timeout rather than requestAnimationFrame: rAF does not run in a background tab or an
   * occluded window, and this render is what makes arrived rows visible at all — not just a
   * smoothing step. Waiting on a frame left the Excel preview showing its cold-start stand-in
   * long after the real rows had been cached.
   */
  private _scheduleVirtualRender(containerId: string): void {
    if (this._blockRenderScheduled.has(containerId)) return;
    this._blockRenderScheduled.add(containerId);
    setTimeout(() => {
      this._blockRenderScheduled.delete(containerId);
      if (this._destroyed) return;
      const el = document.getElementById(containerId);
      if (el) this.renderGrid(el);
    }, 0);
  }

  public getEditableFields(containerId: string): string[] {
    const editableConfig = this.options.editableCols?.find(conf => conf.id === containerId);
    return editableConfig ? editableConfig.cols : [];
  }

  public getCurrentWidths(containerId: string): Map<string, number> {
    return this.columnWidths.get(containerId) || new Map();
  }

  // All data field names, ignoring the display whitelist and hidden filters — used by the column
  // selector so it always lists every column, even after some have been unchecked/hidden.
  public getDataFields(containerId: string): string[] {
    const items = (this.options.data || []) as T[];
    return this.buildBaseColumns(containerId, items)
      .filter(c => c.type !== 'data_checkbox')
      .map(c => c.field);
  }

  // A TREE of searchable keys (all depths) built from a data sample — used by the search box's
  // autocomplete so it can suggest only the sub-keys valid at the current scope
  // (`role(engineering(…))` → suggest subRole/years). Arrays merge their elements' keys into one
  // node. Cached per target; recomputed when the data changes.
  public getSearchKeys(containerId: string, fallbackSample?: unknown[]): KeyTree {
    const cached = this._searchKeysCache.get(containerId);
    if (cached) return cached;
    // Sample from whichever source holds JS rows: in-memory data, JS stream rows, or the rows the
    // caller is rendering (guaranteed present for a visible streamed/WASM-only grid).
    const data = this.options.data as unknown[] | undefined;
    const sample = (data && data.length > 0)
      ? data
      : (this._streamRows.get(containerId) ?? fallbackSample ?? []);
    const tree: KeyTree = {};
    const merge = (v: unknown, node: KeyTree) => {
      if (Array.isArray(v)) { for (const x of v) merge(x, node); return; }
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          if (!node[k]) node[k] = {};
          merge(child, node[k]);
        }
      }
    };
    for (const r of sample.slice(0, 200)) merge(r, tree);
    // Cache only a non-empty result — an empty tree means data hasn't arrived yet, so recompute
    // on the next render instead of getting stuck empty.
    if (Object.keys(tree).length > 0) this._searchKeysCache.set(containerId, tree);
    return tree;
  }

  // Excel export for the whole dataset, from whichever source holds it. In-memory data (or JS
  // stream rows) is handed to ExcelView directly. For large/streamed grids the data lives only in
  // the WASM engine, so we pull it in chunks and stream it into the workbook — the full dataset is
  // never materialised in memory at once. Reflects the current filter/sort (the engine already
  // holds that state from the last render).
  /** Aborts an in-flight worker export for this grid; the export's finally clears state + re-renders. */
  public cancelExport(containerId: string): void {
    this._exportControllers.get(containerId)?.abort();
  }

  public async exportExcel(containerId: string, scope: 'filtered' | 'all' = 'filtered'): Promise<void> {
    const gridId = containerId;
    const SMALL_MAX = 50000;
    const CHUNK = 50000;

    const render = () => { const el = document.getElementById(containerId); if (el) this.renderGrid(el); };
    // The heavy work (xlsx build + zip) runs in the export worker, so the main thread stays free —
    // just update the overlay; React can paint because we're not blocking.
    const onProgress = (done: number, total: number) => {
      this.exportState.set(containerId, {done, total});
      render();
    };

    // JS-resident rows (normal grids / JS stream rows), if any. For scope 'filtered' the
    // current filter+sort is applied here; 'all' takes the raw set. Large WASM-only grids
    // have no JS copy — they fall to the engine branch below.
    const inMemory = await (async (): Promise<unknown[] | null> => {
      const data = this.options.data as Record<string, unknown>[] | undefined;
      const rawData = (data && data.length > 0)
        ? data
        : (this._streamRows.get(containerId) ?? null);
      if (!rawData || rawData.length === 0) return null;
      if (scope !== 'filtered') return rawData;
      // Filtered scope: the WASM engine already holds the correct result for the active query —
      // including column-group syntax like `age(>40)` that the lightweight JS matcher can't parse.
      // Pull the filtered rows straight from it (nested objects/arrays survive the JSON round-trip),
      // so the export matches the visible grid exactly. Large results (> SMALL_MAX) return null and
      // stream through the engine branch below; the JS matcher is only the fallback for pure-JS
      // stream grids that have no engine.
      const engine = this._wasmEngines.get(containerId);
      if (engine && this._wasmEngineReady.get(containerId)) {
        const count = await engine.getTotalCount();
        if (count === 0) return [];
        if (count > SMALL_MAX) return null;
        return (await engine.getPage(0, count)).rows;
      }
      return this._applyStreamFilter(containerId, rawData);
    })();

    const baseName = `everygrid_${gridId}_${new Date().getTime()}`;

    // Cancel any export already running for this grid, then track this one so it can be aborted
    // (worker terminated) on re-export or when the grid is destroyed.
    this._exportControllers.get(containerId)?.abort();
    const controller = new AbortController();
    this._exportControllers.set(containerId, controller);

    // Parent key for relational child sheets: the configured checkbox mapping, else an id-like
    // field auto-detected from the data (resolved with a sample row at each use site below).
    const configKey = (Array.isArray(this.options.checkbox) ? this.options.checkbox : [])
      .find(c => c.id === containerId)?.mapping;

    try {
      let total: number;
      let fetchChunk: (page: number, size: number) => Promise<unknown[]>;

      if (inMemory) {
        // Small enough: the rich DOM path (array expansion / merged cells). The build runs
        // synchronously on the main thread, so — like the worker path — show the loading pill
        // (total:0 = indeterminate) and yield two frames so React can paint it before the freeze.
        if (inMemory.length <= SMALL_MAX) {
          this.exportState.set(containerId, {done: 0, total: 0});
          render();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          // Relational export: top-level object arrays go to normalized child sheets (single sheet
          // when there are none). The on-screen preview is unaffected.
          const keyField = configKey ?? ExcelView.detectKeyField(inMemory[0]);
          ExcelView.downloadRelationalExcel(inMemory, gridId, keyField);
          return;
        }
        total = inMemory.length;
        fetchChunk = (page, size) => Promise.resolve(inMemory.slice(page * size, (page + 1) * size));
      } else {
        const engine = this._wasmEngines.get(containerId);
        if (!engine || !this._wasmEngineReady.get(containerId)) {
          ExcelView.downloadExcel([], gridId);
          return;
        }
        // High ceiling: the worker streams + zip-splits so memory stays bounded regardless of size.
        const EXPORT_MAX = 20000000;
        if (scope === 'all') {
          // getRawPage ignores the active filter/sort — the complete dataset.
          total = Math.min(await engine.getRawCount(), EXPORT_MAX);
          fetchChunk = async (page, size) => (await engine.getRawPage(page, size)).rows;
        } else {
          // getPage reads the engine's current (already filtered/sorted) result, page by page.
          total = Math.min(await engine.getTotalCount(), EXPORT_MAX);
          fetchChunk = async (page, size) => (await engine.getPage(page, size)).rows;
        }

      }

      // Large path (in-memory > SMALL_MAX, or engine/stream). Sample the first page: object arrays
      // → a relational workbook (parent + one child sheet per array); otherwise a single flat sheet.
      // Both stream chunk-by-chunk and zip-split in the worker, so memory stays bounded (~one part
      // file per sheet at a time) even for very large inputs.
      const firstPage = total > 0 ? await fetchChunk(0, CHUNK) : [];
      const relational = ExcelView.arrayPaths(firstPage as Record<string, unknown>[]).length > 0;
      const keyField = configKey ?? ExcelView.detectKeyField(firstPage[0]);
      onProgress(0, relational ? Math.max(1, Math.ceil(total / CHUNK)) : Math.max(1, Math.ceil(total / 200000)));
      const {bytes, isZip} = await runExcelExport({baseName, total, chunkSize: CHUNK, fetchChunk, onProgress, signal: controller.signal, relational, keyField});
      ExcelView.triggerDownload(
        bytes,
        isZip ? `${baseName}.zip` : `${baseName}.xlsx`,
        isZip ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    } catch (err) {
      // A cancelled export (re-export / grid destroyed) is expected — swallow it; surface others.
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.error('Everygrid export failed:', err);
    } finally {
      // Only clear if this call still owns the controller (a newer export may have replaced it).
      if (this._exportControllers.get(containerId) === controller) {
        this._exportControllers.delete(containerId);
        this.exportState.delete(containerId);
        render();
      }
    }
  }

  // Raw columns from the data source (config columns / first row / stream / WASM), before any
  // checkbox injection, whitelist, or hidden-field filtering.
  /**
   * Localized display name for a field: `columnI18n[locale][containerId][field]`, falling back to
   * the `common` bucket and then the raw field key. Locale comes from the global `I18n`, so a
   * `setLocale` + re-render is all it takes to relabel. Queries never use this — they stay in field
   * keys — so nothing downstream (WASM/matcher/highlight) needs to know about labels.
   */
  public columnLabel(field: string, containerId: string): string {
    const loc = this.options.columnI18n?.[I18n.getLocale()];
    return loc?.[containerId]?.[field] ?? loc?.common?.[field] ?? field;
  }

  private buildBaseColumns(containerId: string, items: T[]): GridColumn[] {
    if (this.options.columns) {
      return [...this.options.columns];
    }
    const fromKeys = (keys: string[]): GridColumn[] =>
      keys.map(key => ({headerName: this.columnLabel(key, containerId), field: key}));
    if (items.length > 0) {
      return fromKeys(Object.keys(items[0]));
    }
    // Streaming mode: get column names from JS stream rows first row
    const streamRows = this._streamRows.get(containerId);
    if (streamRows && streamRows.length > 0) {
      return fromKeys(Object.keys(streamRows[0]));
    }
    // Fallback: try WASM first row
    const engine = this._wasmEngines.get(containerId);
    if (engine && this._wasmEngineReady.get(containerId)) {
      const cached = this._wasmPageCache.get(containerId);
      if (cached && cached.rows.length > 0) {
        return fromKeys(Object.keys(cached.rows[0] as Record<string, unknown>));
      }
    }
    return [];
  }

  /** Mobile column keys from config (`mobileColumns`), or undefined when none is set for this grid. */
  public getMobileColumns(containerId: string): string[] | undefined {
    const conf = this.options.mobileColumns?.find(c => c.id === containerId);
    return conf?.cols;
  }

  public getColumns(containerId: string, items: T[], isMobile: boolean = false): GridColumn[] {
    let columns: GridColumn[] = this.buildBaseColumns(containerId, items);

    // Mobile: fixed-width columns that scroll horizontally, plus a per-row detail button that opens
    // the full row in a modal. Column choice uses the same "Select Columns" whitelist as desktop
    // (displayColsMap) — no longer capped at 3, since the row now scrolls. Default when nothing is
    // selected: the configured mobileColumns, else every column. Desktop-only chrome (pinning, the
    // checkbox column) is deliberately skipped.
    if (isMobile) {
      let picked: GridColumn[];
      // An explicit whitelist (even empty, i.e. "deselect all") is honoured as-is; columns always
      // render in the base column order, never the pick order. Only when the user has never chosen do
      // we fall back to the configured mobileColumns, else every column.
      if (this.displayColsMap.has(containerId)) {
        const set = this.displayColsMap.get(containerId)!;
        picked = columns.filter(col => set.has(col.field));
      } else {
        const configured = this.getMobileColumns(containerId)?.filter(f => columns.some(c => c.field === f));
        picked = configured && configured.length > 0
          ? columns.filter(col => configured.includes(col.field))
          : columns;
      }
      const hiddenFields = this.hiddenFieldsMap.get(containerId) || new Set();
      return [
        ...picked.filter(col => !hiddenFields.has(col.field)),
        {headerName: '', field: '__detail__', type: 'row_detail'},
        ...this._actionsColumn(containerId),
      ];
    }

    // Display whitelist: empty = show all; when the column selector has checked columns, show
    // only those, in the order they were checked (Set preserves insertion order). data_checkbox
    // is injected afterwards, so it's never filtered out here.
    const displayCols = this.displayColsMap.get(containerId);
    if (displayCols && displayCols.size > 0) {
      columns = Array.from(displayCols)
        .map(field => columns.find(col => col.field === field))
        .filter((col): col is GridColumn => !!col);
    }

    // Inject checkbox config column at the front if active
    const checkboxConfigs = Array.isArray(this.options.checkbox) ? this.options.checkbox : [];
    const checkboxConfig = checkboxConfigs.find(c => c.id === containerId);
    if (checkboxConfig && (checkboxConfig.active ?? true)) {
      const alreadyExists = columns.some(col => col.type === 'data_checkbox');
      if (!alreadyExists) {
        columns = [
          { headerName: '', field: '__checkbox__', type: 'data_checkbox', mapping: checkboxConfig.mapping },
          ...columns,
        ];
      }
    }

    // Filter out explicitly hidden fields
    const hiddenFields = this.hiddenFieldsMap.get(containerId) || new Set();
    return [...columns.filter(col => !hiddenFields.has(col.field)), ...this._actionsColumn(containerId)];
  }

  /** The row-actions column (add in the header, delete per row), when the config asks for it. */
  private _actionsColumn(containerId: string): GridColumn[] {
    const {insertRow, deleteRow} = this.getRowActions(containerId);
    return insertRow || deleteRow ? [{headerName: '', field: '__actions__', type: 'row_actions'}] : [];
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  public notify() {
    this.subscribers.forEach(cb => cb());
  }

  public renderGrid(container: HTMLElement, _updatePinned: boolean = true) {
    this.notify();
    const root = this.getRoot(container);
    root.render(<EverygridComponent grid={this} container={container}/>);
  }

  public isCellModified(rowData: T, field: string): boolean {
    // An inserted row is new as a whole; none of its cells is "modified from the original".
    if (this._insertedRows.has(rowData)) return false;
    const originalRow = this.originalDataMap.get(rowData);
    if (!originalRow) {
      return false;
    }

    const originalValue = (originalRow as Record<string, unknown>)[field];
    const currentValue = rowData[field];

    if (currentValue === originalValue) {
      return false;
    }

    // Normalize values for comparison (treat null/undefined as same)
    const isCurrentEmpty = currentValue === null || currentValue === undefined || currentValue === '';
    const isOriginalEmpty = originalValue === null || originalValue === undefined || originalValue === '';

    if (isCurrentEmpty && isOriginalEmpty) {
      return false;
    }

    // If one is empty and other is not, it's modified
    if (isCurrentEmpty !== isOriginalEmpty) {
      return true;
    }

    const currentStr = JSON.stringify(currentValue);
    const originalStr = JSON.stringify(originalValue);

    return currentStr !== originalStr;
  }

  public syncRowHeights(container: HTMLElement) {
    if (this.pinnedColumns.size === 0) {
      return;
    }

    if (this.syncTimeoutId) {
      window.cancelAnimationFrame(this.syncTimeoutId);
    }

    this.syncTimeoutId = window.requestAnimationFrame(() => {
      const mainTable = container.querySelector('.everygrid-table-container:not(.everygrid-pinned-table-container) .everygrid-table') as HTMLTableElement;
      const pinnedTable = container.querySelector('.everygrid-pinned-table-container .everygrid-table') as HTMLTableElement;

      if (mainTable && pinnedTable && mainTable.tBodies.length > 0 && pinnedTable.tBodies.length > 0) {
        const mainRows = Array.from(mainTable.tBodies[0].rows) as HTMLElement[];
        const pinnedRows = Array.from(pinnedTable.tBodies[0].rows) as HTMLElement[];

        mainRows.forEach((mainRow, index) => {
          const pinnedRow = pinnedRows[index];
          if (pinnedRow) {
            // We use natural heights or fixed heights from CSS
            // Only sync if they differ significantly to avoid layout thrashing
            const mh = mainRow.offsetHeight;
            const ph = pinnedRow.offsetHeight;
            if (Math.abs(mh - ph) > 0.5) {
              const height = Math.max(mh, ph);
              mainRow.style.height = `${height}px`;
              pinnedRow.style.height = `${height}px`;
            }
          }
        });
      }
      this.syncTimeoutId = undefined;
    });
  }


  public showPopup(data: unknown, rowData?: unknown, title?: string) {
    this.activePopupRow = rowData || null;
    this.activePopupRowKey = rowData ? JSON.stringify(rowData) : null;
    // Store data only; EverygridComponent builds the popup with the live filterText each render.
    this.activePopupData = {data};
    this.activePopupTitle = title ?? null;
    this.activePopup = null;
    const {targets} = this.options;
    targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) this.renderGrid(container);
    });
  }

  // Full-text popup for long / multi-line plain string cells (the cell shows a prefix button).
  public showTextPopup(text: string, rowData?: unknown, title?: string) {
    this.activePopupRow = rowData || null;
    this.activePopupRowKey = rowData ? JSON.stringify(rowData) : null;
    this.activePopup = (
      <PopupComponent onClose={() => this.closePopup()} title={title || I18n.t('popup.detailTitle')}>
        <pre className='m-0 p-4 text-sm whitespace-pre-wrap wrap-break-word text-slate-700'>{highlightText(text, this.filterText)}</pre>
      </PopupComponent>
    );
    const {targets} = this.options;
    targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) this.renderGrid(container);
    });
  }

  showEditPopup(rowData: Record<string, unknown>, field: string, data: unknown) {
    this.activePopupRow = rowData;
    this.activePopupRowKey = JSON.stringify(rowData);
    this.activePopup = (
      <TextEditorPopupComponent
        field={field}
        data={data}
        onClose={() => this.closePopup()}
        onSave={(updatedData) => {
          this.updateData(rowData, field, updatedData);
          this.closePopup();
        }}
      />
    );
    const {targets} = this.options;
    targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) this.renderGrid(container);
    });
  }

  public updateData(rowData: Record<string, unknown>, field: string, value: unknown) {
    if (rowData && this.options.data) {
      const data = this.options.data as Record<string, unknown>[];
      let idx = data.indexOf(rowData as T & Record<string, unknown>);
      // Fallback: find by JSON key if reference lookup fails (e.g. stale closure)
      if (idx === -1) {
        const key = JSON.stringify(rowData);
        idx = data.findIndex(d => JSON.stringify(d) === key);
      }
      if (idx === -1) return;

      // The live reference currently at this index owns the original snapshot. rowData may be a
      // WASM-derived copy (not a map key), so look the snapshot up via the live ref, not rowData.
      const prevRef = data[idx] as T;
      const from = prevRef[field];

      // Create a new object so React.memo detects the change and re-renders
      const newRow = {...rowData, [field]: parseIfJson(value)} as T;
      data[idx] = newRow;

      // The row's original is captured here, on its first edit, rather than for every row at
      // load: prevRef is still the untouched row at that point. Later edits move the snapshot
      // onto each new row reference.
      // An inserted row has no original to snapshot: it is new as a whole.
      const inserted = this._insertedRows.delete(prevRef);
      if (inserted) {
        this._insertedRows.add(newRow);
      } else {
        const originalSnapshot = this.originalDataMap.get(rowData as T)
          ?? this.originalDataMap.get(prevRef)
          ?? JSON.parse(JSON.stringify(prevRef)) as T;
        this.originalDataMap.delete(rowData as T);
        this.originalDataMap.delete(prevRef);
        this.originalDataMap.set(newRow, originalSnapshot);
      }
      if (this._deletedRows.delete(prevRef)) this._deletedRows.add(newRow);

      // Track the edited row so getDisplayItems can remap WASM copies to this live reference.
      this._editedKeys.delete(JSON.stringify(rowData));
      this._editedKeys.set(JSON.stringify(newRow), newRow);

      // Sync just the edited row to the WASM engines — see _syncRowsToEngines.
      const {targets} = this.options;
      this._syncRowsToEngines([{index: idx, row: newRow}]);

      if (this.options.onDataChange) {
        this.options.onDataChange(this.options.data, this._originalData());
      }

      // Re-render to reflect modifications
      targets?.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        const container = document.getElementById(id);
        if (container) this.renderGrid(container, this.pinnedColumns.has(field));
      });

      const gridId = this._firstTargetId();
      this._emit('cellChange', {index: idx, key: this._keyOf(gridId, newRow, idx), field, from, to: newRow[field], row: newRow});
      this._emitChange(gridId);
    }
  }

  /** The id this instance renders into — one instance serves one target under createGrid/mount. */
  private _firstTargetId(): string {
    const t = this.options.targets?.[0];
    return typeof t === 'string' ? t : (t?.id ?? '');
  }

  public reset(container: HTMLElement) {
    // Inserted rows go; deleted rows come back.
    this._dropRows(container.id, Array.from(this._insertedRows));
    this._deletedRows.clear();
    this._editedKeys.clear();
    const data = (this.options.data || []) as Record<string, unknown>[];

    // Replace each modified row with a new object (restored from original) so React.memo
    // re-renders. Only edited rows have a snapshot, and once restored they need none.
    const restored: { index: number; row: unknown }[] = [];
    data.forEach((item, idx) => {
      const originalItem = this.originalDataMap.get(item as T) as Record<string, unknown>;
      if (originalItem) {
        const restoredRow = JSON.parse(JSON.stringify(originalItem)) as T;
        data[idx] = restoredRow;
        this.originalDataMap.delete(item as T);
        if (JSON.stringify(item) !== JSON.stringify(restoredRow)) {
          restored.push({index: idx, row: restoredRow});
        }
      }
    });

    // Sync the restored rows to the WASM engines — see _syncRowsToEngines.
    this._syncRowsToEngines(restored);

    this.renderGrid(container);

    if (this.options.onDataChange && this.options.data) {
      this.options.onDataChange(this.options.data, this._originalData());
    }
    this._emitChange(container.id);
  }

  public resetCell(rowData: Record<string, unknown>, field: string, container: HTMLElement) {
    if (!this.options.data) return;
    const data = this.options.data as Record<string, unknown>[];
    let idx = data.indexOf(rowData as T & Record<string, unknown>);
    if (idx === -1) {
      const key = JSON.stringify(rowData);
      idx = data.findIndex(d => JSON.stringify(d) === key);
    }
    if (idx === -1) return;

    // rowData may be a WASM-derived copy; the snapshot is keyed by the live ref at this index.
    const prevRef = data[idx] as T;
    const originalRow = this.originalDataMap.get(rowData as T) ?? this.originalDataMap.get(prevRef);
    if (originalRow) {
      // Create a new object with the field restored so React.memo re-renders
      const originalValue = originalRow[field];
      const newRow = {...rowData} as T;
      if (originalValue === undefined) {
        delete (newRow as Record<string, unknown>)[field];
      } else {
        (newRow as Record<string, unknown>)[field] = JSON.parse(JSON.stringify(originalValue));
      }
      data[idx] = newRow;
      this.originalDataMap.delete(rowData as T);
      this.originalDataMap.delete(prevRef);
      this.originalDataMap.set(newRow, originalRow);
      const inserted = this._insertedRows.delete(prevRef);
      if (inserted) this._insertedRows.add(newRow);
      const deleted = this._deletedRows.delete(prevRef);
      if (deleted) this._deletedRows.add(newRow);

      // Update the edited-row remap: keep it only if the row still matters — modified elsewhere,
      // or added / deleted.
      this._editedKeys.delete(JSON.stringify(rowData));
      if (inserted || deleted || Object.keys(newRow as Record<string, unknown>).some(f => this.isCellModified(newRow, f))) {
        this._editedKeys.set(JSON.stringify(newRow), newRow);
      }
      // Sync just the restored row to the WASM engines — see _syncRowsToEngines.
      this._syncRowsToEngines([{index: idx, row: newRow}]);

      this.renderGrid(container);

      if (this.options.onDataChange && this.options.data) {
        this.options.onDataChange(this.options.data, this._originalData());
      }
      this._emitChange(container.id);
    }
  }

  public updateColumnWidth(containerId: string, field: string, width: number) {
    let widths = this.columnWidths.get(containerId);
    if (!widths) {
      widths = new Map();
      this.columnWidths.set(containerId, widths);
    }
    widths.set(field, width);
  }

  public resetSort(container: HTMLElement) {
    const containerId = container.id;
    this.sortConfig.delete(containerId);
    // Mirror the sort-apply routing (see handleSort): clearing the sort must also
    // refresh the active data source, otherwise a WASM grid keeps serving the
    // previously sorted page from _wasmPageCache and the reset appears to do nothing.
    const paginationConfig = this.getPagination(containerId);
    if (paginationConfig?.serverSide && this.options.serverFetcher) {
      this.currentPage.set(containerId, 1);
      this.fetchServerPage(containerId).catch(console.error);
    } else if (this._streamRows.has(containerId)) {
      this.currentPage.set(containerId, 1);
      this.renderGrid(container);
    } else {
      this.applyWasmFilter(containerId).catch(console.error);
    }
  }

  public toggleExcelViewMode(container: HTMLElement) {
    this.isExcelViewMode = !this.isExcelViewMode;
    this.renderGrid(container);
  }

  public setCurrentPage(containerId: string, page: number, _container: HTMLElement) {
    this.currentPage.set(containerId, page);
    const paginationConfig = this.getPagination(containerId);
    if (paginationConfig?.serverSide && this.options.serverFetcher) {
      this.fetchServerPage(containerId).catch(err => console.error(err));
    } else if (this._streamUrl.has(containerId)) {
      // Streaming mode: data is already in memory, just re-render
      const container = document.getElementById(containerId);
      if (container) this.renderGrid(container);
    } else if (this._indexingStage.get(containerId) === 'indexing') {
      // During indexing: if WASM data is already loaded, use WASM directly
      if (this._wasmDataLoaded.get(containerId)) {
        this.applyWasmFilter(containerId, true).catch(console.error);
      } else {
        // WASM not ready yet — slice from JS allRows if available
        const indexingRows = this._indexingAllRows.get(containerId);
        const paginationConfig = this.getPagination(containerId);
        const pageSize = (paginationConfig?.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10;
        const start = (page - 1) * pageSize;
        if (indexingRows) {
          this._wasmPageCache.set(containerId, { rows: indexingRows.slice(start, start + pageSize), total: indexingRows.length });
        } else {
          // No allRows (e.g. small grid whose Worker finalize is blocked by large grid).
          // Slice from the full cached data if available, otherwise just re-render.
          const existingCache = this._wasmPageCache.get(containerId);
          if (existingCache) {
            // We don't have allRows but we know the total — re-render with current cache
            // The page number is already saved; once indexing completes applyWasmFilter will correct it.
          }
        }
        const container = document.getElementById(containerId);
        if (container) this.renderGrid(container);
      }
    } else {
      // On page change, fetch only the new page from WASM — the filter/sort result is
      // already computed and cached, so we just slice it (O(pageSize)) instead of
      // rescanning every row via applyWasmFilter's filter+sort recompute.
      this.fetchWasmPage(containerId).catch(console.error);
    }
  }

  public getCurrentPage(containerId: string): number {
    return this.currentPage.get(containerId) || 1;
  }

  public getTotalPages(containerId: string): number {
    const paginationConfig = this.getPagination(containerId);
    const pageSize = (paginationConfig?.pageSize && paginationConfig.pageSize > 0) ? paginationConfig.pageSize : 10;
    // Server-side: use server total
    if (paginationConfig?.serverSide) {
      const serverTotal = this._serverTotal.get(containerId);
      if (serverTotal !== undefined) return Math.ceil(serverTotal / pageSize);
    }
    // Total rows with the filter applied.
    const filteredTotal = this.getFilteredTotal(containerId);
    if (filteredTotal !== undefined) {
      return Math.ceil(filteredTotal / pageSize);
    }
    const items = (this.options.data || []) as T[];
    return Math.ceil(items.length / pageSize);
  }

  public showColumnSelector(allFields: string[], container: HTMLElement) {
    this.activePopup = (
      <ColumnSelectorComponent
        allFields={allFields}
        container={container}
        grid={this}
        onClose={() => this.closePopup()}
      />
    );
    this.renderGrid(container);
  }

  public showRowDetail(row: T, container: HTMLElement) {
    this.activePopup = (
      <RowDetailComponent
        row={row}
        container={container}
        grid={this}
        onClose={() => this.closePopup()}
      />
    );
    this.renderGrid(container);
  }

  public showMobileColumnSelector(allFields: string[], container: HTMLElement) {
    this.activePopup = (
      <MobileColumnSelectorComponent
        allFields={allFields}
        container={container}
        grid={this}
        onClose={() => this.closePopup()}
      />
    );
    this.renderGrid(container);
  }

  public showHiddenColumnSelector(container: HTMLElement) {
    const containerId = container.id;
    const hiddenFields = this.hiddenFieldsMap.get(containerId);
    if (!hiddenFields || hiddenFields.size === 0) {
      return;
    }

    this.activePopup = (
      <HiddenColumnSelectorComponent
        container={container}
        grid={this}
        onClose={() => this.closePopup()}
      />
    );
    this.renderGrid(container);
  }

  /**
   * A fresh load is a new baseline: edits against the previous rows have nothing to compare to.
   *
   * Nothing is copied here. originalDataMap used to hold a deep copy of every row (and a second
   * full copy sat in a parallel array), which for a million rows meant two JSON round trips of
   * the whole dataset at load and three times the memory. A row's original is now captured on its
   * first edit — see the edit path — so the map only ever holds the rows that have changed.
   */
  private initOriginalDataMap() {
    this.originalDataMap.clear();
    this._editedKeys.clear();
  }

  /** The dataset as it was before any edits, built for onDataChange from the per-row snapshots. */
  private _originalData(): T[] {
    return ((this.options.data || []) as T[]).map(row => this.originalDataMap.get(row) ?? row);
  }

  private isDate(value: unknown): boolean {
    if (value instanceof Date) {
      return true;
    }
    if (typeof value !== 'string') {
      return false;
    }

    // Simple ISO date regex check (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...)
    const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;
    if (dateRegex.test(value)) {
      const d = new Date(value);
      return !isNaN(d.getTime());
    }
    return false;
  }

  private observeDOM() {
    if (this.checkAndInit()) {
      return;
    }

    this.domObserver = new MutationObserver(() => {
      if (this.checkAndInit()) {
        this.domObserver?.disconnect();
        this.domObserver = null;
      }
    });

    this.domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private checkAndInit(): boolean {
    const {targets} = this.options;
    if (!targets || !Array.isArray(targets)) {
      return true;
    }

    const foundAll = targets.every(id => {
      const targetId = typeof id === 'string' ? id : id.id;
      return document.getElementById(targetId);
    });
    if (foundAll) {
      this.init().catch(err => console.error('Everygrid init error:', err));
      return true;
    }
    return false;
  }

  private async init() {
    const {targets, dataUrl} = this.options;

    if (!targets || !Array.isArray(targets)) {
      console.error('Everygrid: targets is required and must be an array.');
      return;
    }

    // Fetch data from dataUrl if provided
    if (dataUrl && !this.options.data) {
      // Mark every target as loading so this path shows the same skeleton as the others.
      const ids = targets.map(t => typeof t === 'string' ? t : t.id);
      ids.forEach(id => this._loading.add(id));
      try {
        const response = await fetch(dataUrl);
        const fetchedData = await response.json();
        this.options.data = fetchedData;
        this.initOriginalDataMap();
      } catch (error) {
        console.error('Everygrid: Error fetching data:', error);
      } finally {
        ids.forEach(id => this._loading.delete(id));
      }
    }

    // Sync data to WASM engine (per containerId, only if not yet loaded)
    targets.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const engine = this._wasmEngines.get(id);
      if (engine && this._wasmEngineReady.get(id) && this.options.data && !this._wasmDataLoaded.get(id)) {
        void this._loadIntoEngine(id, engine, this.options.data as unknown[])
          .then(() => { this._wasmDataLoaded.set(id, true); })
          .catch(err => console.warn(`Everygrid: WASM setData failed for ${id}:`, err));
      }
    });

    targets.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) {
        this.applyWasmFilter(id).catch(console.error);
      }
    });
  }


  private getRoot(container: HTMLElement): Root {
    if (!this.roots.has(container)) {
      this.roots.set(container, createRoot(container));
    }
    return this.roots.get(container)!;
  }

  public destroy() {
    // Flag first: pending polls bail out instead of running to their timeout.
    this._destroyed = true;

    // Disconnect MutationObserver
    this.domObserver?.disconnect();
    this.domObserver = null;

    // Cancel pending requestAnimationFrame
    if (this.syncTimeoutId !== undefined) {
      window.cancelAnimationFrame(this.syncTimeoutId);
      this.syncTimeoutId = undefined;
    }

    // Unmount React roots
    this.roots.forEach(root => root.unmount());
    this.roots.clear();

    // Clear subscribers
    this.subscribers.clear();

    // Remove from the static instances map, and release the target so it can be mounted again —
    // destroy() has to be the exact inverse of construction for client-owned lifecycles to work.
    this.options.targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      Everygrid.instances.delete(id);
      Everygrid._initializedTargets.delete(id);
    });

    // Abort any in-flight Excel exports (terminates their worker) and drop progress state.
    this._exportControllers.forEach(controller => controller.abort());
    this._exportControllers.clear();
    this.exportState.clear();

    // Terminate each grid's worker — releases its WASM memory and the worker thread at once.
    this._wasmEngines.forEach(engine => engine.terminate());
    this._wasmEngines.clear();
    this._wasmEngineReady.clear();
    this._wasmDataLoaded.clear();
  }
}