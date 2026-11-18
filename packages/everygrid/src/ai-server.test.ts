import {describe, expect, it, vi} from 'vitest';
import {AiSearchDeclinedError, conditionsToQuery, createAiSearch, createAiSearchHandler, sanitizeFields, unknownPaths} from './ai-server';

const fields = [{key: 'age', type: 'number', samples: [31]}];

describe('sanitizeFields', () => {
  it('keeps known properties, caps sizes and rejects malformed entries', () => {
    const long = 'x'.repeat(300);
    const [f] = sanitizeFields([{key: 'name', type: 'string', samples: [long, {}, 1], label: 'Name', extra: 'drop me'}])!;
    expect(f).toEqual({key: 'name', type: 'string', samples: ['x'.repeat(100), 1], label: 'Name'});
    expect(sanitizeFields([{key: 'a', type: 'time', samples: []}])).toBeNull();
    expect(sanitizeFields('nope')).toBeNull();
    expect(sanitizeFields(Array.from({length: 300}, (_, i) => ({key: `k${i}`, type: 'string', samples: []})))!).toHaveLength(200);
  });
});

describe('createAiSearch', () => {
  it('builds the prompt server-side and cleans the reply', async () => {
    const complete = vi.fn(async (_call: {system: string; question: string; schema: unknown}) => '```\nage(>=30)\n```');
    const result = await createAiSearch({complete})({question: ' over 30 ', locale: 'en', fields, prompt: 'ignored'});
    expect(result).toEqual({status: 200, body: {query: 'age(>=30)'}});
    const call = complete.mock.calls[0]![0];
    expect(call.question).toBe('over 30');
    expect(call.system).toContain('- age (number) — e.g. 31');
    expect(call.system).not.toContain('ignored');
  });

  it('validates input before calling the model', async () => {
    const complete = vi.fn(async () => 'x');
    const run = createAiSearch({complete, maxQuestionLength: 5});
    expect((await run({question: 'too long', fields})).status).toBe(400);
    expect((await run({question: 'ok', fields: []})).status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it('maps declines, rate limits and API errors to statuses', async () => {
    const run = (e: unknown) => createAiSearch({complete: async () => { throw e; }})({question: 'q', fields});
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await run(new AiSearchDeclinedError())).status).toBe(422);
    expect((await run(Object.assign(new Error('slow down'), {status: 429}))).status).toBe(429);
    expect(await run(Object.assign(new Error('bad key'), {status: 401}))).toEqual({status: 502, body: {error: 'The AI service is not configured'}});
    expect((await run(Object.assign(new Error('boom'), {status: 500}))).status).toBe(502);
    await expect(run(new TypeError('bug'))).rejects.toThrow('bug');
    quiet.mockRestore();
  });

  it('asks for a model when openai is chosen without one', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await createAiSearch({provider: 'openai'})({question: 'q', fields})).status).toBe(500);
    quiet.mockRestore();
  });
});

describe('createAiSearchHandler', () => {
  it('answers POST JSON and refuses the rest', async () => {
    const handle = createAiSearchHandler({complete: async () => 'age(>=30)'});
    const post = (body: string) => handle(new Request('http://x/ai', {method: 'POST', body}));
    expect(await (await post(JSON.stringify({question: 'q', fields}))).json()).toEqual({query: 'age(>=30)'});
    expect((await post('{')).status).toBe(400);
    expect((await handle(new Request('http://x/ai'))).status).toBe(405);
  });
});

const cond = (path: string[], op: string, value: string | number | boolean = '', values: string[] = []) =>
  ({path, op, value, values}) as Parameters<typeof conditionsToQuery>[0]['any'][number]['all'][number];

describe('conditionsToQuery', () => {
  it('writes paths as nested scopes and groups alternatives', () => {
    expect(conditionsToQuery({any: [{all: [cond(['location'], 'eq', 'Busan'), cond(['age'], 'gte', 30)]}]}))
      .toBe('location(==Busan) && age(>=30)');
    expect(conditionsToQuery({any: [{all: [cond(['role', 'engineering', 'years'], 'gte', 2)]}]}))
      .toBe('role(engineering(years(>=2)))');
    expect(conditionsToQuery({any: [
      {all: [cond(['dept'], 'in', '', ['HR', 'Design']), cond(['active'], 'eq', true)]},
      {all: [cond([], 'contains', 'frontend')]},
    ]})).toBe('(dept(in[HR,Design]) && active(==true)) || frontend');
  });

  it('keeps values from breaking the grammar', () => {
    expect(conditionsToQuery({any: [{all: [cond(['name'], 'contains', 'a (b) && c')]}]})).toBe('name(a b c)');
    expect(conditionsToQuery({any: [{all: [cond(['email'], 'regex', '(foo|bar)@x')]}]})).toBe('email(~(foo|bar)@x)');
    expect(conditionsToQuery({any: [{all: [cond(['x'], 'eq', ''), cond(['y'], 'in')]}]})).toBe('');
  });
});

describe('unknownPaths', () => {
  const tree = [{key: 'role', type: 'object' as const, samples: [], keys: [{key: 'engineering', type: 'object' as const, samples: []}]}];
  it('checks each key case-insensitively, down to the described depth', () => {
    expect(unknownPaths({any: [{all: [cond(['Role', 'engineering', 'years'], 'gte', 2)]}]}, tree)).toEqual([]);
    expect(unknownPaths({any: [{all: [cond(['roles'], 'eq', 'x'), cond(['role', 'design'], 'eq', 'x')]}]}, tree))
      .toEqual(['roles', 'role.design']);
  });
});

describe('createAiSearch with JSON answers', () => {
  const json = (any: unknown) => JSON.stringify({any});

  it('passes the schema, converts conditions and retries once on an unknown field', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(json([{all: [cond(['years'], 'gte', 30)]}]))
      .mockResolvedValueOnce(json([{all: [cond(['age'], 'gte', 30)]}]));
    const result = await createAiSearch({complete})({question: 'over 30', fields});
    expect(result).toEqual({status: 200, body: {query: 'age(>=30)'}});
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]![0].schema).toHaveProperty('$defs.condition');
    expect(complete.mock.calls[1]![0].question).toContain('These paths name no field: years');
  });

  it('gives up with 422 after a second unusable answer', async () => {
    const complete = vi.fn().mockResolvedValue(json([{all: [cond(['nope'], 'eq', 1)]}]));
    expect((await createAiSearch({complete})({question: 'q', fields})).status).toBe(422);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('sanitizeFields — profile', () => {
  it('keeps date type, complete lists and ranges', () => {
    const [f] = sanitizeFields([{key: 'joined', type: 'date', samples: ['2024-01-01'], complete: true, min: '2020-01-01', max: '2026-10-01', extra: 1}])!;
    expect(f).toEqual({key: 'joined', type: 'date', samples: ['2024-01-01'], complete: true, min: '2020-01-01', max: '2026-10-01'});
  });
});
