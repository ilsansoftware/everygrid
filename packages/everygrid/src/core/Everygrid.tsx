import '../styles/Everygrid.css';
import {GridEngineWasm} from '../wasm/GridEngineWasm';
import {EverygridComponent} from '../components/EverygridComponent';
import {isJsonString, parseIfJson} from './utils';
import {ExcelView} from './ExcelView';
import {runExcelExport} from '../wasm/ExcelExportClient';
import {ColumnSelectorComponent} from '../components/ColumnSelectorComponent';
import {HiddenColumnSelectorComponent} from '../components/HiddenColumnSelectorComponent';
import {I18n} from '../i18n/I18n';
import React from 'react';
import {PopupComponent} from '../components/PopupComponent';
import {TextEditorPopupComponent} from '../components/TextEditorPopupComponent';
import {createRoot, type Root} from 'react-dom/client';
import {
  type GridColumn,
  type GridOptions,
  type GridPaginationConfig,
  type GridTargetConfig,
  type IEverygrid,
  type KeyTree,
  type ServerFetchParams,
} from './types';

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
  public activePopup: React.ReactNode | null = null;
  // Nested-table popup data. Stored (not pre-built) so the popup is assembled at render time with
  // the CURRENT filterText — highlighting stays live if the filter changes while it is open.
  public activePopupData: {data: unknown} | null = null;
  public activePopupRow: unknown | null = null;
  public activePopupRowKey: string | null = null;
  private originalData: T[] = [];
  public currentPage: Map<string, number> = new Map();
  private originalDataMap: Map<T, T> = new Map();
  // Edited rows keyed by their current-value JSON, so WASM-derived page copies (which are new
  // object refs, not keys in originalDataMap) can be remapped back to the live edited reference
  // in getDisplayItems — that reference is what makes isCellModified / resetCell work by identity.
  private _editedKeys: Map<string, T> = new Map();
  private selectedRows: Map<string, Set<T>> = new Map(); // Manages selected rows per targetId
  public checkedValues: Map<string, Set<unknown>> = new Map(); // Manages checked values per targetId (checkbox config)
  private syncTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private roots: Map<HTMLElement, Root> = new Map();
  private subscribers: Set<() => void> = new Set();
  private domObserver: MutationObserver | null = null;
  // Set by destroy(). Pending polls check it so an unmounted grid stops working immediately
  // instead of spinning out its timeout.
  private _destroyed = false;
  public filterText: string = '';
  private _wasmEngines: Map<string, GridEngineWasm> = new Map();
  private _wasmEngineReady: Map<string, boolean> = new Map();
  private _wasmDataLoaded: Map<string, boolean> = new Map();
  // Cache: last getPage result per containerId (updated after each applyWasmFilter)
  public _wasmPageCache: Map<string, { rows: unknown[]; total: number }> = new Map();
  public get wasmReady(): boolean { return this._wasmEngines.size > 0 && [...this._wasmEngineReady.values()].some(v => v); }
  private _serverTotal: Map<string, number> = new Map();
  private _serverFetching: Map<string, boolean> = new Map();
  // Streaming mode: total row count
  public _streamTotal: Map<string, number> = new Map();
  // Streaming mode: all rows stored in JS memory
  public _streamRows: Map<string, Record<string, unknown>[]> = new Map();
  // Streaming mode: source URL (stored for reference, no re-fetch needed)
  public _streamUrl: Map<string, string> = new Map();
  // Processing state: true while WASM filter/sort is running
  public _processing: Map<string, boolean> = new Map();
  private _processingTimer: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _filterSeq: Map<string, number> = new Map();
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
  // Where each target's data came from, kept so the toolbar can re-load it on demand.
  // Unlike _streamUrl (cleared once a load finishes) this survives for the grid's lifetime.
  public _dataSource: Map<string, string | (() => Promise<Record<string, unknown>[]>)> = new Map();
  // True while a reloadData() call is in flight, so repeated clicks don't stack fetches.
  public _reloading: Map<string, boolean> = new Map();

  constructor(options: GridOptions<T>) {
    this.options = options;

    if (this.options.data) {
      this.originalData = JSON.parse(JSON.stringify(this.options.data));
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
        if (this.options.data && this.options.data.length > 0) {
          engine.setData(this.options.data as unknown[]).then(() => {
            this._wasmDataLoaded.set(id, true);
            this.applyWasmFilter(id).catch(console.error);
          }).catch(console.error);
        } else {
          this.applyWasmFilter(id).catch(console.error);
        }
      }).catch(err => {
        console.warn(`Everygrid: WASM engine init failed for ${id}:`, err);
      });
    });
  }

  /** Unmounts every grid and forgets all loaded config — the next loadConfig re-fetches. */
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
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
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
   * @param opts.reload Bypass the cache and re-fetch
   * @returns The target ids that are now registered (across every config file listed)
   */
  public static loadConfig(
    entryConfigUrl: string = '/everygrid.config.json',
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
      if (u.startsWith('http://') || u.startsWith('https://')) return u;
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
   * Mounts one registered target into the element with the same id. Requires `loadConfig()` first
   * and requires the element to already be in the DOM — nothing is allocated for a target this
   * screen doesn't show, so cost scales with grids rendered, not with configs that exist.
   *
   * Idempotent: mounting an already-mounted target returns the live instance.
   *
   * @param targetId Element id, matching a target id from the loaded config
   * @param opts.fetcher Data source for this target — a URL (streamed) or an async function
   */
  public static async mount<D extends Record<string, unknown> = Record<string, unknown>>(
    targetId: string,
    opts: {fetcher?: string | (() => Promise<Record<string, unknown>[]>)} = {},
  ): Promise<Everygrid<D> | null> {
    const existing = Everygrid.instances.get(targetId);
    if (existing) return existing as Everygrid<D>;

    if (!document.getElementById(targetId)) {
      console.warn(`Everygrid.mount: no element with id "${targetId}" — render it before mounting.`);
      return null;
    }

    const entry = Everygrid._targetRegistry.get(targetId);
    if (!entry) {
      console.warn(`Everygrid.mount: target "${targetId}" is not registered — call loadConfig() first.`);
      return null;
    }

    const {config, target} = entry;
    Everygrid._initializedTargets.add(targetId);

    const fetcherOrUrl = opts.fetcher;
    if (typeof fetcherOrUrl === 'string') {
      const url = Everygrid._resolveUrl(fetcherOrUrl);
      // Mount with empty data so the skeleton paints now, then stream in the background.
      const instance = new Everygrid({...config, targets: [target], data: []});
      instance._streamUrl.set(targetId, url);
      instance._dataSource.set(targetId, url);
      instance._loadFromUrl(targetId, url);
      return instance as unknown as Everygrid<D>;
    }
    if (fetcherOrUrl) {
      // Same shape as the URL path: paint the skeleton first, fill it in when the rows arrive.
      // Awaiting the fetcher before constructing left the container blank for the whole fetch.
      const instance = new Everygrid({...config, targets: [target], data: []});
      instance._dataSource.set(targetId, fetcherOrUrl);
      instance._loading.add(targetId);
      void fetcherOrUrl()
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
    entryConfigUrl: string = '/everygrid.config.json',
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
  private _loadFromUrl(targetId: string, url: string): Promise<void> {
    this._loading.add(targetId);
    return fetch(url, { cache: this.options.dataCache ?? 'no-store' })
      .then(async res => {
        if (!res.ok || !res.body) return;
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
        // deep-copy for originalData + setData clone) and freezes the tab. Streaming is safe
        // for small payloads too — it just shows the indexing UI briefly. contentLength===0
        // makes _streamJsonToWasm fall back to a "rows ingested" count instead of a fake %.
        const isLarge = isNaN(declaredLength) || declaredLength >= 50 * 1024 * 1024;
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
      })
      .catch(err => {
        console.warn('Everygrid: fetch failed for', targetId, err);
      })
      .finally(() => {
        this._loading.delete(targetId);
        const el = document.getElementById(targetId);
        if (el) this.renderGrid(el);
      });
  }

  /** Installs freshly loaded rows as the target's data and hands them to its WASM engine. */
  private async _setRows(targetId: string, rows: Record<string, unknown>[]): Promise<void> {
    this._streamRows.delete(targetId);
    this._streamUrl.delete(targetId);
    this._searchKeysCache.delete(targetId); // recompute autocomplete keys for the new data
    (this.options as { data: unknown[] }).data = rows;
    // The rows just fetched are the new baseline — edits made against the previous load no
    // longer have anything to compare to, so drop them rather than leave stale "modified"
    // markers pointing at cells the server may have changed underneath.
    this.originalData = JSON.parse(JSON.stringify(rows)) as T[];
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
      await engine.setData(rows);
      this._wasmEngineReady.set(targetId, true);
      await this.applyWasmFilter(targetId);
    } catch {
      const el = document.getElementById(targetId);
      if (el) this.renderGrid(el);
    }
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
   */
  public async reloadData(containerId: string): Promise<void> {
    const source = this._dataSource.get(containerId);
    if (!source || this._reloading.get(containerId)) return;

    this._reloading.set(containerId, true);
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

    try {
      await engine.streamStart(false);
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        // Transfer raw bytes to the worker — the main thread does NO parsing.
        total = await engine.streamChunk(value);
        instance._streamTotal.set(targetId, total);
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

  public closePopup() {
    this.activePopup = null;
    this.activePopupData = null;
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

  public getSelectedRows(containerId: string): Set<T> {
    return this.selectedRows.get(containerId) || new Set();
  }

  public setSelectedRows(containerId: string, rows: Set<T>) {
    this.selectedRows.set(containerId, rows);
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

  public checkHasChanges(): boolean {
    const data = (this.options.data || []) as T[];
    return data.some(item => {
      const original = this.originalDataMap.get(item);
      if (!original) {
        return false;
      }

      // Call isCellModified for each field for consistent comparison
      return Object.keys(item).some(field => this.isCellModified(item, field));
    });
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
      this.originalData = JSON.parse(JSON.stringify(result.data));
      this.initOriginalDataMap();
      // Server-side: sync current page data to the WASM engine
      const engine = this._wasmEngines.get(containerId);
      if (engine && this._wasmEngineReady.get(containerId)) {
        engine.setData(this.options.data as unknown[]).then(() => {
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
      const pageIndex = isPaginationActive ? currentPage - 1 : 0;
      const fetchSize = isPaginationActive ? pageSize : 10000;
      const result = await engine.filterSortAndGetPage(this.filterText, sortField, sortAsc, pageIndex, fetchSize);
      // If a newer call has been issued, skip caching and rendering
      if (this._filterSeq.get(containerId) !== seq) return;
      this._wasmPageCache.set(containerId, { rows: result.rows, total: result.filtered });
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
  private _parseFilterExpr(text: string): (row: Record<string, unknown>) => boolean {
    const trimmed = text.trim();
    if (!trimmed) return () => true;
    // OR has lower precedence than AND
    const orParts = trimmed.split('||').map(p => p.trim()).filter(p => p.length > 0);
    const orMatchers = orParts.map(orPart => {
      const andParts = orPart.split('&&').map(p => p.trim()).filter(p => p.length > 0);
      return (row: Record<string, unknown>) =>
        andParts.every(term =>
          Object.values(row).some(v => String(v ?? '').toLowerCase().includes(term.toLowerCase()))
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
    const inMemory = ((): unknown[] | null => {
      const data = this.options.data as Record<string, unknown>[] | undefined;
      const rawData = (data && data.length > 0)
        ? data
        : (this._streamRows.get(containerId) ?? null);
      if (!rawData || rawData.length === 0) return null;
      return scope === 'filtered' ? this._applyStreamFilter(containerId, rawData) : rawData;
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
  private buildBaseColumns(containerId: string, items: T[]): GridColumn[] {
    if (this.options.columns) {
      return [...this.options.columns];
    }
    if (items.length > 0) {
      const firstItem = items[0];
      return Object.keys(firstItem).map(key => ({
        headerName: key,
        field: key
      }));
    }
    // Streaming mode: get column names from JS stream rows first row
    const streamRows = this._streamRows.get(containerId);
    if (streamRows && streamRows.length > 0) {
      return Object.keys(streamRows[0]).map(key => ({
        headerName: key,
        field: key
      }));
    }
    // Fallback: try WASM first row
    const engine = this._wasmEngines.get(containerId);
    if (engine && this._wasmEngineReady.get(containerId)) {
      const cached = this._wasmPageCache.get(containerId);
      if (cached && cached.rows.length > 0) {
        return Object.keys(cached.rows[0] as Record<string, unknown>).map(key => ({
          headerName: key,
          field: key
        }));
      }
    }
    return [];
  }

  public getColumns(containerId: string, items: T[]): GridColumn[] {
    let columns: GridColumn[] = this.buildBaseColumns(containerId, items);

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
    return columns.filter(col => !hiddenFields.has(col.field));
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


  public showPopup(data: unknown, rowData?: unknown) {
    this.activePopupRow = rowData || null;
    this.activePopupRowKey = rowData ? JSON.stringify(rowData) : null;
    // Store data only; EverygridComponent builds the popup with the live filterText each render.
    this.activePopupData = {data};
    this.activePopup = null;
    const {targets} = this.options;
    targets?.forEach(idConfig => {
      const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
      const container = document.getElementById(id);
      if (container) this.renderGrid(container);
    });
  }

  // Full-text popup for long / multi-line plain string cells (the cell shows a prefix button).
  public showTextPopup(text: string, rowData?: unknown) {
    this.activePopupRow = rowData || null;
    this.activePopupRowKey = rowData ? JSON.stringify(rowData) : null;
    this.activePopup = (
      <PopupComponent onClose={() => this.closePopup()} title={I18n.t('popup.detailTitle')}>
        <pre className="m-0 p-4 text-sm whitespace-pre-wrap wrap-break-word text-slate-700">{text}</pre>
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

      // Create a new object so React.memo detects the change and re-renders
      const newRow = {...rowData, [field]: parseIfJson(value)} as T;
      data[idx] = newRow;

      // Move the original snapshot onto the new row reference
      const originalSnapshot = this.originalDataMap.get(rowData as T) ?? this.originalDataMap.get(prevRef);
      if (originalSnapshot) {
        this.originalDataMap.delete(rowData as T);
        this.originalDataMap.delete(prevRef);
        this.originalDataMap.set(newRow, originalSnapshot);
      }

      // Track the edited row so getDisplayItems can remap WASM copies to this live reference.
      this._editedKeys.delete(JSON.stringify(rowData));
      this._editedKeys.set(JSON.stringify(newRow), newRow);

      // Sync updated live data to WASM engine
      const {targets} = this.options;
      targets?.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        const eng = this._wasmEngines.get(id);
        if (eng && this._wasmEngineReady.get(id)) {
          eng.setData(this.options.data as unknown[]);
          this.applyWasmFilter(id);
        }
      });

      if (this.options.onDataChange) {
        this.options.onDataChange(this.options.data, this.originalData);
      }

      // Re-render to reflect modifications
      targets?.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        const container = document.getElementById(id);
        if (container) this.renderGrid(container, this.pinnedColumns.has(field));
      });
    }
  }

  public reset(container: HTMLElement) {
    if (this.originalData) {
      this._editedKeys.clear();
      const data = (this.options.data || []) as Record<string, unknown>[];

      // Replace each modified row with a new object (restored from original) so React.memo re-renders
      data.forEach((item, idx) => {
        const originalItem = this.originalDataMap.get(item as T) as Record<string, unknown>;
        if (originalItem) {
          const restoredRow = JSON.parse(JSON.stringify(originalItem)) as T;
          data[idx] = restoredRow;
          this.originalDataMap.delete(item as T);
          this.originalDataMap.set(restoredRow, originalItem as T);
        }
      });

      // Sync restored data to WASM engine
      const {targets: resetTargets} = this.options;
      resetTargets?.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        const eng = this._wasmEngines.get(id);
        if (eng && this._wasmEngineReady.get(id)) {
          eng.setData(this.options.data as unknown[]);
          this.applyWasmFilter(id);
        }
      });

      this.renderGrid(container);

      if (this.options.onDataChange && this.options.data) {
        this.options.onDataChange(this.options.data, this.originalData);
      }
    }
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

      // Update the edited-row remap: keep it only if the row is still modified elsewhere.
      this._editedKeys.delete(JSON.stringify(rowData));
      if (Object.keys(newRow as Record<string, unknown>).some(f => this.isCellModified(newRow, f))) {
        this._editedKeys.set(JSON.stringify(newRow), newRow);
      }
      // Sync restored cell data to WASM engine
      const {targets: resetCellTargets} = this.options;
      resetCellTargets?.forEach(idConfig => {
        const id = typeof idConfig === 'string' ? idConfig : idConfig.id;
        const eng = this._wasmEngines.get(id);
        if (eng && this._wasmEngineReady.get(id)) {
          eng.setData(this.options.data as unknown[]);
          this.applyWasmFilter(id);
        }
      });

      this.renderGrid(container);

      if (this.options.onDataChange && this.options.data) {
        this.options.onDataChange(this.options.data, this.originalData);
      }
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
    // filter 반영 총 행 수
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

  private initOriginalDataMap() {
    this.originalDataMap.clear();
    this._editedKeys.clear();
    const data = (this.options.data || []) as T[];
    const original = (this.originalData || []) as T[];

    data.forEach((item, index) => {
      if (original[index]) {
        // Deep copy each item to avoid reference sharing
        this.originalDataMap.set(item, JSON.parse(JSON.stringify(original[index])));
      }
    });
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
        this.originalData = JSON.parse(JSON.stringify(fetchedData));
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
        try {
          engine.setData(this.options.data as unknown[]);
          this._wasmDataLoaded.set(id, true);
        } catch (err) {
          console.warn(`Everygrid: WASM setData failed for ${id}:`, err);
        }
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