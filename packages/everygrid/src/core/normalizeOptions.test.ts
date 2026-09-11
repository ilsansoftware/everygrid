import {describe, expect, it} from 'vitest';
import {normalizeOptions, targetConfigOf} from './normalizeOptions';
import type {GridOptions} from './types';

const nested: GridOptions = {
  dataCache: 'no-cache',
  targets: [{
    id: 'g',
    title: 'G',
    links: ['email'],
    rowKey: 'id',
    rowActions: {insertRow: true},
    toolbar: {showConfig: true},
    editableCols: ['name'],
    checkbox: 'id',
    pagination: {pageSize: 10},
    columnI18n: {ko: {name: '이름'}},
  }],
  columnI18n: {ko: {common: {id: '아이디'}}},
};

describe('normalizeOptions', () => {
  it('folds target options into the root per-feature lists', () => {
    const o = normalizeOptions(nested);
    expect(o.targets).toEqual([{id: 'g', title: 'G', links: ['email']}]);
    expect(o.rowKey).toEqual([{id: 'g', field: 'id'}]);
    expect(o.rowActions).toEqual([{id: 'g', insertRow: true}]);
    expect(o.toolbar).toEqual([{id: 'g', showConfig: true}]);
    expect(o.editableCols).toEqual([{id: 'g', cols: ['name']}]);
    expect(o.checkbox).toEqual([{id: 'g', mapping: 'id'}]);
    expect(o.pagination).toEqual([{id: 'g', pageSize: 10}]);
    expect(o.columnI18n).toEqual({ko: {common: {id: '아이디'}, g: {name: '이름'}}});
    expect(o.dataCache).toBe('no-cache');
  });

  it('leaves the per-feature form alone and lets a target entry override it', () => {
    const o = normalizeOptions({
      targets: [{id: 'a', pagination: {pageSize: 5}}, 'b'],
      pagination: [{id: 'a', pageSize: 1}, {id: 'b', pageSize: 2}],
    });
    expect(o.pagination).toEqual([{id: 'b', pageSize: 2}, {id: 'a', pageSize: 5}]);
    expect(o.targets).toEqual([{id: 'a'}, 'b']);
  });

  it('accepts a single object where a list is expected', () => {
    const o = normalizeOptions({targets: ['a'], pagination: {id: 'a', pageSize: 3}});
    expect(o.pagination).toEqual([{id: 'a', pageSize: 3}]);
  });
});

describe('targetConfigOf', () => {
  it('rebuilds the config-file shape for one grid', () => {
    const o = normalizeOptions({...nested, targets: [...nested.targets, {id: 'other', pagination: {pageSize: 1}}]});
    const {targets, ...rest} = nested;
    expect(targetConfigOf(o, 'g')).toEqual({...rest, targets: [targets[0]]});
  });

  it('is the identity on a normalized nested config', () => {
    const o = normalizeOptions(nested);
    expect(normalizeOptions(targetConfigOf(o, 'g') as unknown as GridOptions)).toEqual(o);
  });
});
