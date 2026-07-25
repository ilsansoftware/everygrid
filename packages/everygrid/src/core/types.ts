import React from 'react';

// Recursive tree of searchable keys (child keys under each key) for search autocomplete.
export interface KeyTree { [key: string]: KeyTree }

export interface GridTargetConfig {
  id: string;
  title?: string;
  data?: Record<string, unknown>[];
  links?: string[];
}

/**
 * Localized column display names: `locale → ('common' | gridId) → field → label`.
 * A grid id's entry overrides `common`; any field with no entry falls back to the raw field key.
 * Only display and the search-suggestion label use this — queries stay in real field keys, so WASM,
 * the JS matcher, and highlight are untouched and locale can switch with no query rewriting.
 */
export type ColumnI18n = Record<string, Record<string, Record<string, string>>>;

export interface GridColumn {
  headerName: string;
  field: string;
  type?: string;
  width?: number;
  options?: string[];
  mapping?: string;
}

export interface EditableColConfig {
  id: string;
  cols: string[];
}

/**
 * Columns shown on a narrow (mobile) layout, where the grid drops to a no-horizontal-scroll view of
 * a few fixed columns plus a per-row detail button. `cols` lists the field keys (first 3 used); with
 * no entry the grid falls back to the first three data columns. A user can also pick up to 3 at
 * runtime, which overrides this.
 */
export interface GridMobileColumnsConfig {
  id: string;
  cols: string[];
}

export interface GridColorConfig {
  id: string;
  font?: {
    header?: string;
    body?: string;
  };
  bg?: {
    header?: string;
    body?: string;
  };
}

export interface ServerFetchParams {
  page: number;       // 0-based
  pageSize: number;
  sortField?: string;
  sortAsc?: boolean;
  filterText?: string;
}

export interface ServerFetchResult<T = Record<string, unknown>> {
  data: T[];
  total: number;      // total row count (for pagination)
}

export interface GridPaginationConfig {
  id: string;
  pageSize?: number;
  active?: boolean;
  position?: 'top' | 'bottom' | 'all';
  serverSide?: boolean;
  /**
   * Where the "Showing 1–5 of 10" line goes.
   * - `'strip'` (default) — the band between the toolbar and the table, so it shows even on a
   *   grid with a single page or no pagination at all.
   * - `'inline'` — inside the pagination bar, the layout used before that band existed.
   */
  rowCount?: 'strip' | 'inline';
}

/**
 * Virtual scrolling: renders only the rows in view instead of a whole page.
 * When active for a target, that target's pagination is ignored (the grid becomes one
 * continuous scroll over the full filtered result).
 *
 * Requires a fixed row height — variable-height rows are not supported in this mode.
 */
export interface GridVirtualScrollConfig {
  id: string;
  active?: boolean;
  /** Row height in px. Every row is forced to exactly this. Default 36. */
  rowHeight?: number;
  /** Extra rows rendered above and below the viewport. Default 6. */
  overscan?: number;
  /** Rows fetched from the engine per request. Default 200. */
  blockSize?: number;
}

/**
 * Caps how many rows a target loads into the browser. Loading a whole large dataset — into JS and
 * again into the WASM worker — can exceed a device's per-tab memory limit and crash the tab
 * (typical on phones). With a cap the grid loads only the first N rows and shows a banner instead.
 *
 * For genuinely large data the right answer is server-side pagination (`pagination.serverSide` +
 * `serverFetcher`); this is a safety net for when a full dataset reaches the client anyway.
 */
export interface GridDataLimitConfig {
  id: string;
  /**
   * Hard cap on rows loaded. A number caps at exactly that; `'auto'` derives a device-appropriate
   * cap from reported RAM and whether the device looks mobile. Omit (or `active: false`) for no cap.
   */
  maxRows?: number | 'auto';
  active?: boolean;
}

export interface GridRowCheckboxConfig {
  id: string;
  active: boolean;
}

export interface GridCheckboxConfig {
  id: string;
  mapping: string;
  active?: boolean;
}

export interface GridLinkConfig {
  id: string;
  cols: string[];
}

export interface IEverygrid<T extends Record<string, unknown>> {
  options: GridOptions<T>;
  pinnedColumns: Set<string>;
  activeEditFields: Map<string, Set<string>>;
  sortConfig: Map<string, { field: string; direction: 'asc' | 'desc' | null }>;
  hiddenFieldsMap: Map<string, Set<string>>;
  mobileColsMap: Map<string, Set<string>>;
  exportState: Map<string, {done: number; total: number}>;
  commaSeparatedFields: Set<string>;
  linkFields: Set<string>;
  isExcelViewMode: boolean;
  activePopup: React.ReactElement | null;
  activePopupData: {data: unknown} | null;
  /** Title for the active detail popup — the field the cell belongs to, or undefined for a fallback. */
  activePopupTitle: string | null;
  activePopupRow: unknown | null;
  activePopupRowKey: string | null;
  wasmReady: boolean;
  filterText: string;
  checkedValues: Map<string, Set<unknown>>;
  _streamRows: Map<string, Record<string, unknown>[]>;
  _streamTotal: Map<string, number>;
  _processing: Map<string, boolean>;
  _wasmRawTotal: Map<string, number>;
  _wasmPageCache: Map<string, { rows: unknown[]; total: number }>;
  _dataSource: Map<string, string | (() => Promise<Record<string, unknown>[]>)>;
  _reloading: Map<string, boolean>;
  reloadData(containerId: string): Promise<void>;
  _indexingAllRows: Map<string, Record<string, unknown>[]>;
  _indexingStage: Map<string, 'indexing' | 'ready'>;
  _indexingProgress: Map<string, number>;
  _wasStreaming: Set<string>;
  /** Targets with a data load in flight, on any load path. */
  _loading: Set<string>;

  getSelectedRows(containerId: string): Set<T>;

  setSelectedRows(containerId: string, rows: Set<T>): void;

  renderGrid(container: HTMLElement, _updatePinned?: boolean): void;


  resetCell(item: T, field: string, container: HTMLElement): void;

  syncRowHeights(container: HTMLElement): void;

  showPopup?(data: unknown, rowData?: unknown, title?: string): void;
  closePopup(): void;

  showTextPopup?(text: string, rowData?: unknown, title?: string): void;

  showEditPopup(rowData: Record<string, unknown>, field: string, data: unknown): void;

  updateData(rowData: Record<string, unknown>, field: string, value: unknown): void;

  updateColumnWidth(containerId: string, field: string, width: number): void;

  getCurrentWidths(containerId: string): Map<string, number>;

  isCellModified(rowData: T, field: string): boolean;

  isColumnNumeric(field: string): boolean;

  isColumnDate(field: string): boolean;

  isColumnObject(field: string): boolean;

  getDisplayItems(containerId: string, items: T[]): T[];

  getColumns(containerId: string, items: T[], isMobile?: boolean): GridColumn[];
  columnLabel(field: string, containerId: string): string;
  getMobileColumns(containerId: string): string[] | undefined;
  getMobileFields(containerId: string, available: GridColumn[]): string[];
  showMobileColumnSelector(allFields: string[], container: HTMLElement): void;
  showRowDetail(row: T, container: HTMLElement): void;

  getDataFields(containerId: string): string[];
  getSearchKeys(containerId: string, fallbackSample?: unknown[]): KeyTree;

  exportExcel(containerId: string, scope?: 'filtered' | 'all'): Promise<void>;
  cancelExport(containerId: string): void;

  getEditableFields(containerId: string): string[];

  getPagination(containerId: string): GridPaginationConfig | undefined;

  /** Resolved virtual-scroll config, or undefined when the target scrolls by pages. */
  getVirtualScroll(containerId: string): GridVirtualScrollConfig | undefined;

  /** Resolved row cap for a target (`'auto'` turned into a number), or undefined for no cap. */
  getDataLimit(containerId: string): number | undefined;

  /** Set when a load was capped: how many rows are shown, and the true total if it is known. */
  _dataLimited: Map<string, {shown: number; total: number | null}>;

  /**
   * Rows for the half-open range [start, end) of the current filtered result.
   * Returns synchronously from the block cache; blocks that are missing come back as `undefined`
   * holes and are fetched in the background, which re-renders the grid when they land.
   */
  getRowsInRange(containerId: string, start: number, end: number): (T | undefined)[];

  toggleExcelViewMode(container: HTMLElement): void;

  resetColumnWidths(container: HTMLElement): void;

  showColumnSelector(allFields: string[], container: HTMLElement): void;

  showHiddenColumnSelector(container: HTMLElement): void;

  checkHasChanges(): boolean;

  reset(container: HTMLElement): void;

  resetSort(container: HTMLElement): void;

  setFilter(text: string, container?: HTMLElement): void;

  applyWasmState(containerId: string): void;

  applyWasmFilter(containerId: string): Promise<void>;

  invalidateSortCache(containerId?: string): void;

  fetchServerPage(containerId: string): Promise<void>;

  currentPage: Map<string, number>;

  getCurrentPage(containerId: string): number;

  getTotalPages(containerId: string): number;

  getFilteredTotal(containerId: string): number;

  setCurrentPage(containerId: string, page: number, container: HTMLElement): void;

  getGridTitle(containerId: string): string | undefined;

  subscribe(callback: () => void): () => void;

  notify(): void;

  destroy(): void;
}

export interface GridOptions<T = Record<string, unknown>> {
  targets: (string | GridTargetConfig)[];
  data?: T[];
  dataUrl?: string;
  columns?: GridColumn[];
  columnI18n?: ColumnI18n;
  mobileColumns?: GridMobileColumnsConfig[];
  editableCols?: EditableColConfig[];
  rowCheckbox?: GridRowCheckboxConfig[];
  colors?: GridColorConfig[];
  links?: GridLinkConfig[];
  checkbox?: GridCheckboxConfig[];
  pagination?: GridPaginationConfig | GridPaginationConfig[];
  virtualScroll?: GridVirtualScrollConfig | GridVirtualScrollConfig[];
  dataLimit?: GridDataLimitConfig | GridDataLimitConfig[];
  serverFetcher?: (params: ServerFetchParams) => Promise<ServerFetchResult>;
  /**
   * `cache` mode for the fetch that loads a target's data from a URL.
   * Defaults to 'no-store' (always hit the network). Set to 'default' to let the browser
   * cache the response — worth it for large datasets that rarely change, since a reload
   * then costs a revalidation instead of a full re-download.
   */
  dataCache?: RequestCache;
  onDataChange?: (data: Record<string, unknown>[], originalData: Record<string, unknown>[]) => void;
  onSelectionChange?: (selectedData: Record<string, unknown>[]) => void;
  onCellClick?: (rowData: Record<string, unknown>, field: string) => void;
}
