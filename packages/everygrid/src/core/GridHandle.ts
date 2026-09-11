import type {Everygrid} from './Everygrid';

/** Identifies a row to the outside world: the `rowKey` field's value, else the row's data index. */
export type RowKey = string | number;

/** One cell's change, original → current. */
export interface CellChange {
  field: string;
  from: unknown;
  to: unknown;
}

export type RowStatus = 'added' | 'modified' | 'deleted';

/**
 * One row's change. `modified`: the row as it is now and as it was loaded, with the cells that
 * differ. `added`: `row` is the new row (`original` is the same object, `cells` empty).
 * `deleted`: `original` is the row as loaded (`cells` empty).
 */
export interface RowChange<T = Record<string, unknown>> {
  status: RowStatus;
  index: number;
  key: RowKey;
  row: T;
  original: T;
  cells: CellChange[];
}

/** A change seen from a column: which row, and the value before and after. */
export interface ColumnChange<T = Record<string, unknown>> extends CellChange {
  index: number;
  key: RowKey;
  row: T;
}

/** One modified row in a patch: its key and only the fields that changed. */
export interface RowPatch {
  key: RowKey;
  changes: Record<string, unknown>;
}

/** The minimal payload for a save — what to POST, PATCH and DELETE. */
export interface Patch<T = Record<string, unknown>> {
  added: T[];
  updated: RowPatch[];
  deleted: RowKey[];
}

export type CellChangeEvent<T = Record<string, unknown>> = ColumnChange<T>;

export interface GridEvents<T = Record<string, unknown>> {
  /** One cell was edited (through the grid's UI or `set`). */
  cellChange: (e: CellChangeEvent<T>) => void;
  /** The set of changes moved: an edit, a revert, or a commit. */
  change: (changes: RowChange<T>[]) => void;
}

/**
 * Coordinates into one grid's data — grid → row → cell — with the same verbs at every level:
 * `get`, `set`, `original`, `isModified`, `changes`, `revert`. Handles are stateless views over
 * the grid, so they are cheap to make and never go stale; a handle to a row that does not exist
 * reports `exists() === false` and its writes are no-ops, so a chain never has to null-check.
 *
 * Row indices are positions in the loaded data, so they hold still under sort and filter. For
 * "the n-th row on screen" use `visibleRow`.
 */
export class GridHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly grid: Everygrid<T>;
  public readonly id: string;

  constructor(grid: Everygrid<T>, id: string) {
    this.grid = grid;
    this.id = id;
  }

  exists(): boolean {
    return !this.grid._destroyed;
  }

  /** The loaded rows, in data order. Live objects — read, do not mutate; use `set`. */
  data(): T[] {
    return (this.grid.options.data || []) as T[];
  }

  row(index: number): RowHandle<T> {
    return new RowHandle(this.grid, this, index);
  }

  rowByKey(key: RowKey): RowHandle<T> {
    return this.row(this.grid._indexOfKey(this.id, key));
  }

  find(predicate: (row: T, index: number) => boolean): RowHandle<T> {
    return this.row(this.data().findIndex(predicate));
  }

  /** The n-th row as currently shown (after filter and sort), by its position on screen. */
  visibleRow(position: number): RowHandle<T> {
    const shown = this.grid.getRowsInRange(this.id, position, position + 1)[0];
    return this.row(shown ? this.grid._indexOfRow(shown) : -1);
  }

  cell(index: number, field: string): CellHandle<T> {
    return this.row(index).cell(field);
  }

  column(field: string): ColumnHandle<T> {
    return new ColumnHandle(this, field);
  }

  hasChanges(): boolean {
    return this.grid.checkHasChanges();
  }

  /** Every changed row — added, modified (with its changed cells) or deleted — in data order. */
  changes(): RowChange<T>[] {
    return this.grid._changedRows(this.id);
  }

  // Selectors: the changed rows of one kind, as row handles — `g.updated()[0].cell('x').revert()`.
  added(): RowHandle<T>[] {
    return this.changes().filter(r => r.status === 'added').map(r => this.row(r.index));
  }

  updated(): RowHandle<T>[] {
    return this.changes().filter(r => r.status === 'modified').map(r => this.row(r.index));
  }

  deleted(): RowHandle<T>[] {
    return this.changes().filter(r => r.status === 'deleted').map(r => this.row(r.index));
  }

  /** Original vs current, summarised by kind. */
  diff(): {added: RowChange<T>[]; modified: RowChange<T>[]; deleted: RowChange<T>[]; cells: number} {
    const rows = this.changes();
    return {
      added: rows.filter(r => r.status === 'added'),
      modified: rows.filter(r => r.status === 'modified'),
      deleted: rows.filter(r => r.status === 'deleted'),
      cells: rows.reduce((n, r) => n + r.cells.length, 0),
    };
  }

  /**
   * What to send to a server: the added rows whole, the modified rows as key + changed fields,
   * the deleted rows as keys.
   */
  patch(): Patch<T> {
    const rows = this.changes();
    return {
      added: rows.filter(r => r.status === 'added').map(r => r.row),
      updated: rows.filter(r => r.status === 'modified').map(r => ({
        key: r.key,
        changes: Object.fromEntries(r.cells.map(c => [c.field, c.to])),
      })),
      deleted: rows.filter(r => r.status === 'deleted').map(r => r.key),
    };
  }

  /** Inserts a row (at the top by default) and returns its handle. Needs `rowActions.addRow`. */
  addRow(values: Partial<T> = {}, at = 0): RowHandle<T> {
    if (!this.grid.getRowActions(this.id).addRow) {
      console.warn(`Everygrid: "${this.id}" has no rowActions.addRow — rows cannot be added.`);
      return this.row(-1);
    }
    const row = this.grid.addRow(this.id, values, at);
    return this.row(this.data().indexOf(row));
  }

  /** Puts every row back as loaded: edits undone, added rows dropped, deleted rows restored. */
  revert(): void {
    const el = document.getElementById(this.id);
    if (el) this.grid.reset(el);
  }

  /**
   * Accepts the current state as the new baseline — after a successful save, typically: deleted
   * rows are removed for good, added rows become ordinary rows, edits are no longer marked.
   */
  commit(): void {
    this.grid.commit(this.id);
  }

  /** Subscribe to grid events; returns the unsubscribe function. */
  on<K extends keyof GridEvents<T>>(event: K, handler: GridEvents<T>[K]): () => void {
    return this.grid.on(event, handler);
  }
}

export class RowHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly grid: Everygrid<T>;
  private readonly parent: GridHandle<T>;
  public readonly index: number;
  /** The grid this row belongs to. */
  public readonly gridId: string;

  constructor(grid: Everygrid<T>, parent: GridHandle<T>, index: number) {
    this.grid = grid;
    this.parent = parent;
    this.index = index;
    this.gridId = parent.id;
  }

  exists(): boolean {
    return this.index >= 0 && this.index < this.parent.data().length;
  }

  /** The row's key: its `rowKey` field, else its index. */
  key(): RowKey {
    const row = this.get();
    return row ? this.grid._keyOf(this.parent.id, row, this.index) : this.index;
  }

  get(): T | undefined {
    return this.exists() ? this.parent.data()[this.index] : undefined;
  }

  /** The row as it was loaded (the row itself when it has not been edited). */
  original(): T | undefined {
    const row = this.get();
    return row ? this.grid._originalOf(row) : undefined;
  }

  isModified(): boolean {
    const row = this.get();
    return !!row && Object.keys(row).some(f => this.grid.isCellModified(row, f));
  }

  isAdded(): boolean {
    const row = this.get();
    return !!row && this.grid.isRowAdded(row);
  }

  isDeleted(): boolean {
    const row = this.get();
    return !!row && this.grid.isRowDeleted(row);
  }

  /** `added` / `deleted` / `modified`, or null for a row exactly as loaded. */
  status(): RowStatus | null {
    if (this.isAdded()) return 'added';
    if (this.isDeleted()) return 'deleted';
    return this.isModified() ? 'modified' : null;
  }

  /** Marks the row deleted (struck through until commit; revert restores it). Needs `rowActions.deleteRow`. */
  delete(): boolean {
    const row = this.get();
    if (!row) return false;
    if (!this.grid.getRowActions(this.gridId).deleteRow) {
      console.warn(`Everygrid: "${this.gridId}" has no rowActions.deleteRow — rows cannot be deleted.`);
      return false;
    }
    this.grid.deleteRow(this.gridId, row);
    return true;
  }

  /** Undoes `delete()`. */
  restore(): void {
    const row = this.get();
    if (row) this.grid.restoreRow(this.gridId, row);
  }

  changes(): CellChange[] {
    const row = this.get();
    return row ? this.grid._cellChanges(row) : [];
  }

  cell(field: string): CellHandle<T> {
    return new CellHandle(this.grid, this, field);
  }

  /**
   * Edits several cells at once. Fields the grid's `editableCols` does not allow are skipped (with
   * a warning) unless `force` is set. Returns how many cells were written.
   */
  set(values: Partial<T>, opts: {force?: boolean} = {}): number {
    let n = 0;
    for (const [field, value] of Object.entries(values)) if (this.cell(field).set(value, opts)) n++;
    return n;
  }

  /** Back as loaded: an added row is dropped, a deleted one restored, edits undone. */
  revert(): void {
    const row = this.get();
    if (!row) return;
    if (this.grid.isRowAdded(row)) { this.grid.deleteRow(this.gridId, row); return; }
    if (this.grid.isRowDeleted(row)) this.grid.restoreRow(this.gridId, row);
    for (const c of this.changes()) this.cell(c.field).revert();
  }
}

export class CellHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly grid: Everygrid<T>;
  public readonly row: RowHandle<T>;
  public readonly field: string;

  constructor(grid: Everygrid<T>, row: RowHandle<T>, field: string) {
    this.grid = grid;
    this.row = row;
    this.field = field;
  }

  exists(): boolean {
    return this.row.exists();
  }

  get(): unknown {
    return this.row.get()?.[this.field];
  }

  original(): unknown {
    return this.row.original()?.[this.field];
  }

  isModified(): boolean {
    const row = this.row.get();
    return !!row && this.grid.isCellModified(row, this.field);
  }

  /** Whether the grid's `editableCols` lets this column be edited (from the UI or here). */
  isEditable(): boolean {
    return this.grid.getEditableFields(this.row.gridId).includes(this.field);
  }

  /**
   * Edits the cell exactly as typing into it would: tracked, marked, synced to the engine. Honours
   * `editableCols` like the UI does — a column not listed there is refused (false, with a warning)
   * unless `force` is set, which is for code that knows better than the config.
   */
  set(value: unknown, opts: {force?: boolean} = {}): boolean {
    const row = this.row.get();
    if (!row) return false;
    if (!opts.force && !this.isEditable()) {
      console.warn(`Everygrid: "${this.field}" is not an editable column of "${this.row.gridId}" — pass {force: true} to set it anyway.`);
      return false;
    }
    this.grid.updateData(row, this.field, value);
    return true;
  }

  revert(): void {
    const row = this.row.get();
    const el = document.getElementById(this.row.gridId);
    if (row && el && this.isModified()) this.grid.resetCell(row, this.field, el);
  }
}

export class ColumnHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  private readonly parent: GridHandle<T>;
  public readonly field: string;

  constructor(parent: GridHandle<T>, field: string) {
    this.parent = parent;
    this.field = field;
  }

  /** Current values down the column, in data order. */
  values(): unknown[] {
    return this.parent.data().map(r => r[this.field]);
  }

  /** Rows whose value in this column changed. */
  changes(): ColumnChange<T>[] {
    const out: ColumnChange<T>[] = [];
    for (const r of this.parent.changes()) {
      const c = r.cells.find(c => c.field === this.field);
      if (c) out.push({...c, index: r.index, key: r.key, row: r.row});
    }
    return out;
  }

  revert(): void {
    for (const c of this.changes()) this.parent.row(c.index).cell(this.field).revert();
  }
}
