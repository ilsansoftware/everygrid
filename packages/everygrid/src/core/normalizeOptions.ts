import type {
  GridCheckboxConfig, GridColorConfig, GridDataLimitConfig, GridMobileColumnsConfig, GridOptions,
  GridPaginationConfig, GridRowActionsConfig, GridRowKeyConfig, GridTargetConfig, GridToolbarConfig,
  GridVirtualScrollConfig, EditableColConfig, GridLinkConfig,
} from './types';

/** The per-grid option keys a target may carry, and the root list each one feeds. */
type PerGridKey = 'rowKey' | 'rowActions' | 'toolbar' | 'editableCols' | 'checkbox' | 'colors'
  | 'mobileColumns' | 'pagination' | 'virtualScroll' | 'dataLimit';

const PER_GRID_KEYS: PerGridKey[] = [
  'rowKey', 'rowActions', 'toolbar', 'editableCols', 'checkbox', 'colors', 'mobileColumns',
  'pagination', 'virtualScroll', 'dataLimit',
];

/** Root-list entry for a target's shorthand value. */
function entryOf(key: PerGridKey, id: string, value: unknown): {id: string} {
  switch (key) {
    case 'rowKey': return {id, field: value} as GridRowKeyConfig;
    case 'editableCols': return {id, cols: value} as EditableColConfig;
    case 'mobileColumns': return {id, cols: value} as GridMobileColumnsConfig;
    case 'checkbox': return (typeof value === 'string' ? {id, mapping: value} : {id, ...(value as object)}) as GridCheckboxConfig;
    default: return {id, ...(value as object)};
  }
}

function asList<E>(v: E | E[] | undefined): E[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/**
 * Folds the options a target carries into the root per-feature lists the runtime reads
 * (`pagination: [{id, …}]` and friends), so the rest of the grid keeps one shape to look at.
 * A target's own entry replaces a root entry with the same id. Targets keep only their identity,
 * `data` and `links` afterwards.
 */
export function normalizeOptions<T>(options: GridOptions<T>): GridOptions<T> {
  const out: GridOptions<T> = {...options};
  const lists = new Map<PerGridKey, {id: string}[]>();
  for (const key of PER_GRID_KEYS) lists.set(key, asList(options[key] as {id: string}[] | {id: string} | undefined));
  let columnI18n = options.columnI18n;

  out.targets = (options.targets ?? []).map(target => {
    if (typeof target === 'string') return target;
    const {id, title, data, links, columnI18n: i18n, ...rest} = target;
    for (const key of PER_GRID_KEYS) {
      const value = rest[key];
      if (value === undefined) continue;
      const list = lists.get(key)!.filter(e => e.id !== id);
      list.push(entryOf(key, id, value));
      lists.set(key, list);
    }
    if (i18n) {
      columnI18n = {...columnI18n};
      for (const [locale, labels] of Object.entries(i18n)) {
        columnI18n[locale] = {...columnI18n[locale], [id]: labels};
      }
    }
    const kept: GridTargetConfig = {id};
    if (title !== undefined) kept.title = title;
    if (data !== undefined) kept.data = data;
    if (links !== undefined) kept.links = links;
    return kept;
  });

  const bag = out as unknown as Record<string, unknown>;
  for (const [key, list] of lists) {
    if (list.length > 0) bag[key] = list;
    else delete bag[key];
  }
  if (columnI18n) out.columnI18n = columnI18n;
  return out;
}

/**
 * The inverse for one grid: its target entry with every per-grid option folded back in — the
 * shape a config file uses — plus the root-only options. What the toolbar's "config" button shows.
 */
export function targetConfigOf<T>(options: GridOptions<T>, id: string): Record<string, unknown> {
  const raw = options.targets?.find(t => (typeof t === 'string' ? t : t.id) === id);
  if (!raw) return {};
  const target: Record<string, unknown> = typeof raw === 'string' ? {id: raw} : {...raw, data: undefined};
  const linksEntry = (options.links as GridLinkConfig[] | undefined)?.find(l => l.id === id);
  if (linksEntry) target.links = [...new Set([...(target.links as string[] ?? []), ...linksEntry.cols])];

  const pick = <E extends {id: string}>(list: E | E[] | undefined) => asList(list).find(e => e.id === id);
  const strip = <E extends {id: string}>(e: E): Omit<E, 'id'> => { const {id: _, ...rest} = e; return rest; };

  const rowKey = pick(options.rowKey);
  if (rowKey) target.rowKey = rowKey.field;
  const rowActions = pick(options.rowActions as GridRowActionsConfig[]);
  if (rowActions) target.rowActions = strip(rowActions);
  const toolbar = pick(options.toolbar as GridToolbarConfig[]);
  if (toolbar) target.toolbar = strip(toolbar);
  const editable = pick(options.editableCols);
  if (editable) target.editableCols = editable.cols;
  const checkbox = pick(options.checkbox as GridCheckboxConfig[]);
  if (checkbox) target.checkbox = checkbox.active === undefined ? checkbox.mapping : strip(checkbox);
  const colors = pick(options.colors as GridColorConfig[]);
  if (colors) target.colors = strip(colors);
  const mobile = pick(options.mobileColumns);
  if (mobile) target.mobileColumns = mobile.cols;
  const pagination = pick(options.pagination as GridPaginationConfig[]);
  if (pagination) target.pagination = strip(pagination);
  const virtualScroll = pick(options.virtualScroll as GridVirtualScrollConfig[]);
  if (virtualScroll) target.virtualScroll = strip(virtualScroll);
  const dataLimit = pick(options.dataLimit as GridDataLimitConfig[]);
  if (dataLimit) target.dataLimit = strip(dataLimit);

  if (options.columnI18n) {
    const i18n: Record<string, Record<string, string>> = {};
    for (const [locale, byGrid] of Object.entries(options.columnI18n)) {
      if (byGrid[id]) i18n[locale] = byGrid[id];
    }
    if (Object.keys(i18n).length > 0) target.columnI18n = i18n;
  }

  const out: Record<string, unknown> = {targets: [target]};
  if (options.dataCache !== undefined) out.dataCache = options.dataCache;
  const common: Record<string, Record<string, string>> = {};
  for (const [locale, byGrid] of Object.entries(options.columnI18n ?? {})) {
    if (byGrid.common) common[locale] = {common: byGrid.common} as unknown as Record<string, string>;
  }
  if (Object.keys(common).length > 0) out.columnI18n = common;
  return JSON.parse(JSON.stringify(out));
}
