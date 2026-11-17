import {describe, expect, it, vi} from 'vitest';
import {buildAiSearchPrompt, cleanAiQuery, describeFields, loadRecentQuestions, updateRecentQuestions} from './aiSearch';

describe('describeFields', () => {
  const rows = [
    {name: 'Kim', age: 31, active: true, dept: 'HR', role: [{team: 'front', years: 2}]},
    {name: 'Lee', age: 28, active: false, dept: 'HR', role: [{team: 'back', years: 1}]},
    {name: 'Park', age: 40, active: true, dept: 'Design', note: null},
  ];

  it('types each column and keeps distinct samples', () => {
    const fields = describeFields(rows, 5);
    const byKey = Object.fromEntries(fields.map(f => [f.key, f]));
    expect(byKey.age).toMatchObject({type: 'number', samples: [31, 28, 40]});
    expect(byKey.active).toMatchObject({type: 'boolean', samples: [true, false]});
    expect(byKey.dept.samples).toEqual(['HR', 'Design']);
    expect(byKey.note).toMatchObject({type: 'string', samples: []});
  });

  it('describes the sub-keys of array-of-object columns', () => {
    const role = describeFields(rows, 5).find(f => f.key === 'role')!;
    expect(role.type).toBe('array');
    expect(role.keys?.map(k => k.key)).toEqual(['team', 'years']);
    expect(role.keys?.[0].samples).toEqual(['front', 'back']);
  });

  it('caps samples, honours 0, and labels top-level keys', () => {
    expect(describeFields(rows, 1).find(f => f.key === 'name')!.samples).toEqual(['Kim']);
    expect(describeFields(rows, 0).every(f => f.samples.length === 0)).toBe(true);
    const labelled = describeFields(rows, 0, k => (k === 'dept' ? '부서' : k));
    expect(labelled.find(f => f.key === 'dept')!.label).toBe('부서');
    expect(labelled.find(f => f.key === 'name')!.label).toBeUndefined();
  });
});

describe('buildAiSearchPrompt', () => {
  it('lists the fields with labels and samples', () => {
    const prompt = buildAiSearchPrompt(describeFields([{dept: 'HR'}], 5, () => '부서'), 'ko', new Date('2026-11-18T00:00:00Z'));
    expect(prompt).toContain('- dept "부서" (string) — e.g. "HR"');
    expect(prompt).toContain('Today is 2026-11-18');
    expect(prompt).toContain('writes in Korean');
  });
});

describe('cleanAiQuery', () => {
  it('strips fences, quotes and trailing lines', () => {
    expect(cleanAiQuery('```\nage(>=30) && dept(in[HR,Design])\n```')).toBe('age(>=30) && dept(in[HR,Design])');
    expect(cleanAiQuery('"dept(HR)"')).toBe('dept(HR)');
    expect(cleanAiQuery('`active(==true)`')).toBe('active(==true)');
    expect(cleanAiQuery('\n  name(kim)\nThis finds Kim.')).toBe('name(kim)');
    expect(cleanAiQuery('')).toBe('');
  });
});

describe('recent questions', () => {
  it('keeps the newest five per grid, without duplicates, and forgets on request', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v)});
    for (const q of ['a', 'b', 'c', 'd', 'e', 'f', 'b']) { updateRecentQuestions('g1', q, true); }
    expect(loadRecentQuestions('g1')).toEqual(['b', 'f', 'e', 'd', 'c']);
    expect(loadRecentQuestions('g2')).toEqual([]);
    updateRecentQuestions('g1', 'f', false);
    expect(loadRecentQuestions('g1')).toEqual(['b', 'e', 'd', 'c']);
    vi.unstubAllGlobals();
  });

  it('reads as empty when browser storage is unavailable', () => {
    expect(loadRecentQuestions('g1')).toEqual([]);
    expect(updateRecentQuestions('g1', 'a', true)).toEqual(['a']);
  });
});
