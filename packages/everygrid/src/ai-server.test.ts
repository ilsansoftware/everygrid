import {describe, expect, it, vi} from 'vitest';
import {AiSearchDeclinedError, createAiSearch, createAiSearchHandler, sanitizeFields} from './ai-server';

const fields = [{key: 'age', type: 'number', samples: [31]}];

describe('sanitizeFields', () => {
  it('keeps known properties, caps sizes and rejects malformed entries', () => {
    const long = 'x'.repeat(300);
    const [f] = sanitizeFields([{key: 'name', type: 'string', samples: [long, {}, 1], label: 'Name', extra: 'drop me'}])!;
    expect(f).toEqual({key: 'name', type: 'string', samples: ['x'.repeat(100), 1], label: 'Name'});
    expect(sanitizeFields([{key: 'a', type: 'date', samples: []}])).toBeNull();
    expect(sanitizeFields('nope')).toBeNull();
    expect(sanitizeFields(Array.from({length: 300}, (_, i) => ({key: `k${i}`, type: 'string', samples: []})))!).toHaveLength(200);
  });
});

describe('createAiSearch', () => {
  it('builds the prompt server-side and cleans the reply', async () => {
    const complete = vi.fn(async (_call: {system: string; question: string}) => '```\nage(>=30)\n```');
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
