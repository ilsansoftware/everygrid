// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';

// No worker, no WASM in a test: the engine never comes up, so every engine op is skipped and the
// grid runs on its in-memory rows — which is exactly the layer under test here.
vi.mock('../wasm/GridEngineWasm', () => ({
  GridEngineWasm: {create: () => new Promise(() => {})},
}));

import {Everygrid} from './Everygrid';

type Row = Record<string, unknown>;

const ID = 'g';

const rows = (): Row[] => [
  {id: 1, name: 'Junie', age: 25, joined: '2024-01-01', active: true, role: {team: 'A'}},
  {id: 2, name: 'Lee', age: 30, joined: '2023-05-15', active: false, role: {team: 'B'}},
  {id: 3, name: 'Kim', age: 28, joined: '2024-02-10', active: true, role: {team: 'C'}},
];

function mount(extra: Partial<ConstructorParameters<typeof Everygrid>[0]> = {}) {
  new Everygrid({
    targets: [{id: ID}],
    data: rows(),
    rowKey: [{id: ID, field: 'id'}],
    editableCols: [{id: ID, cols: ['name', 'age', 'active']}],
    rowActions: [{id: ID, insertRow: true, deleteRow: true}],
    checkbox: [{id: ID, mapping: 'id'}],
    ...extra,
  });
  const g = Everygrid.get<Row>(ID);
  if (!g) throw new Error('grid not mounted');
  return g;
}

afterEach(() => {
  Everygrid.resetAutoInit();
});

describe('cells', () => {
  it('get / set / original / modified / cancel', () => {
    const g = mount();
    const c = g.row(0).cell('age');
    expect(c.get()).toBe(25);
    expect(c.set(26)).toBe(true);
    expect(c.get()).toBe(26);
    expect(c.original()).toBe(25);
    expect(c.modified()).toBe(true);
    c.cancel();
    expect(c.get()).toBe(25);
    expect(c.modified()).toBe(false);
    expect(g.hasChanges()).toBe(false);
  });

  it('honours editableCols unless forced', () => {
    const g = mount();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(g.row(0).cell('joined').isEditable()).toBe(false);
    expect(g.row(0).cell('joined').set('2020-01-01')).toBe(false);
    expect(g.row(0).get()?.joined).toBe('2024-01-01');
    expect(g.row(0).cell('joined').set('2020-01-01', {force: true})).toBe(true);
    expect(g.row(0).get()?.joined).toBe('2020-01-01');
    warn.mockRestore();
  });

  it('a handle to a missing row is inert', () => {
    const g = mount();
    expect(g.row(99).exists()).toBe(false);
    expect(g.row(99).get()).toBeUndefined();
    expect(g.row(99).cell('age').set(1)).toBe(false);
  });
});

describe('rows', () => {
  it('addresses rows by index, key and predicate', () => {
    const g = mount();
    expect(g.rows()).toHaveLength(3);
    expect(Array.isArray(g.rows())).toBe(true);
    expect(g.rowByKey(2).get()?.name).toBe('Lee');
    expect(g.find(r => r.name === 'Kim').index).toBe(2);
    expect(g.row(1).key()).toBe(2);
  });

  it('set() writes several cells and reports the count; changes() lists them', () => {
    const g = mount();
    expect(g.row(1).set({name: 'Lee2', age: 31, joined: 'x'})).toBe(2); // joined not editable
    expect(g.row(1).changes()).toEqual([
      {field: 'name', from: 'Lee', to: 'Lee2'},
      {field: 'age', from: 30, to: 31},
    ]);
    expect(g.row(1).status()).toBe('updated');
    expect(g.updatedRows().map(r => r.index)).toEqual([1]);
    g.row(1).cancel();
    expect(g.row(1).status()).toBeNull();
  });

  it('a row edited back to its original is not a change', () => {
    const g = mount();
    g.row(0).cell('age').set(99);
    g.row(0).cell('age').set(25);
    expect(g.changes()).toEqual([]);
  });
});

describe('delete', () => {
  it('marks the row, keeps it in the data, and cancel brings it back', () => {
    const g = mount();
    expect(g.row(2).delete()).toBe(true);
    expect(g.row(2).deleted()).toBe(true);
    expect(g.data()).toHaveLength(3);
    expect(g.patch().deleted).toEqual([{key: 3, row: rows()[2]}]);
    g.row(2).cancel();
    expect(g.row(2).deleted()).toBe(false);
    expect(g.hasChanges()).toBe(false);
  });

  it('recognises the engine\'s copy of a deleted row by content', () => {
    const g = mount();
    g.row(1).delete();
    const copy = {...rows()[1]};
    expect(Everygrid.instances_get(ID).isRowDeleted(copy)).toBe(true);
  });

  it('commit removes deleted rows for good', () => {
    const g = mount();
    g.row(1).delete();
    g.commit();
    expect(g.data().map(r => r.id)).toEqual([1, 3]);
    expect(g.hasChanges()).toBe(false);
  });
});

describe('insert', () => {
  it('lives outside the data until commit, in its own index space', () => {
    const g = mount();
    const h = g.insertRow({name: 'New'});
    expect(h.kind).toBe('inserted');
    expect(h.index).toBe(0);
    expect(h.inserted()).toBe(true);
    expect(h.key()).toBeNull();                 // id still empty
    expect(g.data()).toHaveLength(3);           // loaded data untouched
    expect(g.row(0).get()?.name).toBe('Junie'); // indices stable
    expect(g.insertedRows()).toHaveLength(1);
    expect(g.patch().inserted[0]).toMatchObject({name: 'New', age: null});
  });

  it('every cell of a new row is editable; edits keep it "inserted"', () => {
    const g = mount();
    const h = g.insertRow();
    expect(h.cell('joined').isEditable()).toBe(true);
    expect(h.cell('id').set(7)).toBe(true);
    expect(h.key()).toBe(7);
    expect(h.status()).toBe('inserted');
    expect(h.changes()).toEqual([]);            // no "original" to differ from
  });

  it('cancel drops it; commit appends it to the data', () => {
    const g = mount();
    g.insertRow({name: 'A'});
    g.insertedRows()[0].cancel();
    expect(g.insertedRows()).toHaveLength(0);
    g.insertRow({name: 'B'});
    g.commit();
    expect(g.insertedRows()).toHaveLength(0);
    expect(g.data()).toHaveLength(4);
    expect(g.rows()[3].get()?.name).toBe('B');
    expect(g.rows()[3].status()).toBeNull();
  });
});

describe('patch', () => {
  it('is inserted rows whole, updated as key + changed fields, deleted as key + row', () => {
    const g = mount();
    g.insertRow({name: 'N'});
    g.row(0).cell('age').set(26);
    g.row(2).delete();
    const p = g.patch();
    expect(p.inserted.map(r => r.name)).toEqual(['N']);
    expect(p.updated).toEqual([{key: 1, changes: {age: 26}}]);
    expect(p.deleted).toEqual([{key: 3, row: rows()[2]}]);
    expect(g.diff()).toMatchObject({cells: 1});
    expect(g.diff().inserted).toHaveLength(1);
  });

  it('keys an updated row by its original key, even when the key field was edited', () => {
    const g = mount();
    g.row(0).cell('id').set(500, {force: true});
    expect(g.patch().updated[0].key).toBe(1);
  });
});

describe('checkbox', () => {
  it('check / uncheck / checkedRows, and a deleted row leaves the selection', () => {
    const g = mount();
    const events: unknown[] = [];
    g.on('check', e => events.push([e.checked, e.changed, e.values]));
    g.check([1, 3]);
    expect(g.checkedRows().map(r => r.key())).toEqual([1, 3]);
    expect(g.row(0).checked()).toBe(true);
    g.row(0).delete();
    expect(g.checkedValues()).toEqual([3]);
    g.row(0).cancel();
    expect(g.checkedValues()).toEqual([3]);   // restoring does not re-check
    g.checkAll();
    expect(g.checkedValues().sort()).toEqual([1, 2, 3]);
    g.uncheckAll();
    expect(g.checkedRows()).toHaveLength(0);
    expect(events[0]).toEqual([true, [1, 3], [1, 3]]);
  });
});

describe('columns', () => {
  it('changes() per column, and cancel()', () => {
    const g = mount();
    g.row(0).cell('age').set(1);
    g.row(2).cell('age').set(2);
    g.row(1).cell('name').set('x');
    expect(g.column('age').changes().map(c => [c.key, c.from, c.to])).toEqual([[1, 25, 1], [3, 28, 2]]);
    g.column('age').cancel();
    expect(g.column('age').changes()).toEqual([]);
    expect(g.row(1).updated()).toBe(true);
  });
});

describe('events', () => {
  it('cellChange and change fire on edit, cancel and commit; off() unsubscribes', () => {
    const g = mount();
    const cells: unknown[] = [];
    let changes = 0;
    const off = g.on('cellChange', e => cells.push([e.key, e.field, e.from, e.to]));
    g.on('change', () => changes++);
    g.row(0).cell('age').set(26);
    expect(cells).toEqual([[1, 'age', 25, 26]]);
    g.row(0).cancel();
    g.commit();
    expect(changes).toBe(3);
    off();
    g.row(0).cell('age').set(27);
    expect(cells).toHaveLength(1);
  });
});

describe('column kinds', () => {
  it('detects numeric / boolean / date / object, ignoring empty cells', () => {
    const g = mount();
    const grid = Everygrid.instances_get(ID);
    expect(grid.isColumnNumeric('age')).toBe(true);
    expect(grid.isColumnBoolean('active')).toBe(true);
    expect(grid.isColumnDate('joined')).toBe(true);
    expect(grid.isColumnObject('role')).toBe(true);
    expect(grid.isColumnNumeric('name')).toBe(false);
    g.row(0).cell('age').set(null, {force: true});   // an empty cell changes nothing
    expect(grid.isColumnNumeric('age')).toBe(true);
  });

  it('re-samples after the data changes', () => {
    const g = mount();
    const grid = Everygrid.instances_get(ID);
    expect(grid.isColumnNumeric('name')).toBe(false);
    for (const r of g.rows()) r.cell('name').set(String(r.index));
    expect(grid.isColumnNumeric('name')).toBe(true);
  });
});
