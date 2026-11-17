/**
 * `@everygrid/grid/ai-server` — the server half of AI search. Runs on Node / Bun / Deno / edge
 * runtimes, never in the browser: the API key lives here, in the server's environment.
 *
 *   export const POST = createAiSearchHandler();                       // ANTHROPIC_API_KEY set
 *   export const POST = createAiSearchHandler({provider: 'openai', model: 'gpt-…'});  // OPENAI_API_KEY
 *   export const POST = createAiSearchHandler({complete: myModelCall});   // any other model
 *
 *   Everygrid.setAiSearch({endpoint: '/api/ai-search'});               // in the browser
 *
 * The browser sends the question and the grid's field list; the prompt is built here from that
 * (size-capped) list, so a public endpoint can't be used to send a model arbitrary instructions.
 * The provider SDK is an optional peer: install `@anthropic-ai/sdk` or `openai`, whichever you use.
 */
import {type AiSearchField, buildAiSearchPrompt, cleanAiQuery} from './core/aiSearch';

export type {AiSearchField} from './core/aiSearch';

export type AiSearchProvider = 'anthropic' | 'openai';

/** One model call: the system prompt and the reader's question in, the model's reply text out. */
export type AiSearchComplete = (call: {system: string; question: string; signal?: AbortSignal}) => Promise<string>;

export interface AiSearchServerOptions {
  /**
   * Which API to call. Default: `anthropic` when `ANTHROPIC_API_KEY` is set, else `openai` when
   * `OPENAI_API_KEY` is. Ignored when `complete` is given.
   */
  provider?: AiSearchProvider;
  /** Defaults to the provider's environment variable (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). */
  apiKey?: string;
  /** Anthropic default `claude-opus-5-5`. Required for `openai`. */
  model?: string;
  /** Calls the model yourself — another provider, a gateway, a configured client. */
  complete?: AiSearchComplete;
  /** Longest question accepted, in characters. Default 500. */
  maxQuestionLength?: number;
}

export interface AiSearchResult {
  status: number;
  body: {query: string} | {error: string};
}

/** Throw from a `complete` function when the model declined to answer; the reply is a 422. */
export class AiSearchDeclinedError extends Error {
  constructor() { super('The request was declined'); this.name = 'AiSearchDeclinedError'; }
}

class AiSearchSetupError extends Error {}

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
// Models that take `effort` and the server-side refusal fallback; on others both are left off.
const ANTHROPIC_TUNED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2'];

const MAX_FIELDS = 200;
const MAX_SAMPLES = 10;
const MAX_TEXT = 100;
const MAX_DEPTH = 3;
const TYPES = new Set<AiSearchField['type']>(['string', 'number', 'boolean', 'object', 'array', 'mixed']);

/** The field list as sent, cut down to what the prompt uses: known properties only, bounded sizes. */
export function sanitizeFields(raw: unknown): AiSearchField[] | null {
  let budget = MAX_FIELDS;
  const walk = (list: unknown, depth: number): AiSearchField[] | null => {
    if (!Array.isArray(list)) { return null; }
    const out: AiSearchField[] = [];
    for (const f of list) {
      if (budget-- <= 0) { break; }
      if (!f || typeof f !== 'object') { return null; }
      const {key, label, type, samples, keys} = f as Record<string, unknown>;
      if (typeof key !== 'string' || !key || !TYPES.has(type as AiSearchField['type'])) { return null; }
      const field: AiSearchField = {
        key: key.slice(0, MAX_TEXT),
        type: type as AiSearchField['type'],
        samples: (Array.isArray(samples) ? samples : [])
          .filter((s): s is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof s))
          .slice(0, MAX_SAMPLES)
          .map(s => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : s)),
      };
      if (typeof label === 'string' && label) { field.label = label.slice(0, MAX_TEXT); }
      if (keys !== undefined && depth < MAX_DEPTH) {
        const sub = walk(keys, depth + 1);
        if (!sub) { return null; }
        if (sub.length > 0) { field.keys = sub; }
      }
      out.push(field);
    }
    return out;
  };
  return walk(raw, 0);
}

const env = (name: string): string | undefined =>
  (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.[name];

// The SDK is loaded on first use, so a server that installed only one of them still starts.
async function load<T>(name: string, importer: () => Promise<T>): Promise<T> {
  try { return await importer(); } catch (e) {
    throw new AiSearchSetupError(`AI search: install "${name}" to use this provider (${e instanceof Error ? e.message : e})`);
  }
}

function anthropicComplete(apiKey: string | undefined, model = ANTHROPIC_DEFAULT_MODEL): AiSearchComplete {
  const client = load('@anthropic-ai/sdk', () => import('@anthropic-ai/sdk'))
    .then(({default: Anthropic}) => new Anthropic(apiKey ? {apiKey} : {}));
  const tuned = ANTHROPIC_TUNED_MODELS.includes(model);
  return async ({system, question, signal}) => {
    const response = await (await client).beta.messages.create({
      model,
      max_tokens: 2048,
      ...(tuned ? {output_config: {effort: 'low' as const}, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const} : {}),
      system,
      messages: [{role: 'user', content: question}],
    }, {signal});
    if (response.stop_reason === 'refusal') { throw new AiSearchDeclinedError(); }
    return response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n');
  };
}

function openaiComplete(apiKey: string | undefined, model: string | undefined): AiSearchComplete {
  if (!model) { throw new AiSearchSetupError('AI search: the openai provider needs a `model`'); }
  const client = load('openai', () => import('openai')).then(({default: OpenAI}) => new OpenAI(apiKey ? {apiKey} : {}));
  return async ({system, question, signal}) => {
    const response = await (await client).chat.completions.create({
      model,
      messages: [{role: 'system', content: system}, {role: 'user', content: question}],
    }, {signal});
    const message = response.choices[0]?.message;
    if (message?.refusal) { throw new AiSearchDeclinedError(); }
    return message?.content ?? '';
  };
}

function resolveComplete(options: AiSearchServerOptions): AiSearchComplete {
  if (options.complete) { return options.complete; }
  const provider = options.provider
    ?? (env('ANTHROPIC_API_KEY') ? 'anthropic' : env('OPENAI_API_KEY') ? 'openai' : undefined);
  if (provider === 'anthropic') { return anthropicComplete(options.apiKey, options.model); }
  if (provider === 'openai') { return openaiComplete(options.apiKey, options.model); }
  throw new AiSearchSetupError('AI search: set ANTHROPIC_API_KEY or OPENAI_API_KEY, or pass `provider` / `complete`');
}

/**
 * Validates a request body (`{question, locale, fields}`), asks the model and returns the status
 * and JSON body to reply with. For servers that are not Fetch-API shaped (Express, Lambda, …).
 * Build it once with `createAiSearch(options)` to reuse the client across requests.
 */
export function createAiSearch(options: AiSearchServerOptions = {}): (body: unknown, signal?: AbortSignal) => Promise<AiSearchResult> {
  let complete: AiSearchComplete | null = null;
  const max = options.maxQuestionLength ?? 500;
  return async (body, signal) => {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question || question.length > max) { return {status: 400, body: {error: `question must be 1–${max} characters`}}; }
    const locale = input.locale === 'ko' ? 'ko' : 'en';
    const fields = sanitizeFields(input.fields);
    if (!fields || fields.length === 0) { return {status: 400, body: {error: 'fields must be a non-empty field list'}}; }

    try {
      complete ??= resolveComplete(options);
      const text = await complete({system: buildAiSearchPrompt(fields, locale), question, signal});
      return {status: 200, body: {query: cleanAiQuery(text)}};
    } catch (error) {
      if (error instanceof AiSearchDeclinedError) { return {status: 422, body: {error: error.message}}; }
      if (error instanceof AiSearchSetupError) {
        console.error(error.message);
        return {status: 500, body: {error: 'The AI service is not configured'}};
      }
      // Both SDKs' API errors carry the HTTP status.
      const status = (error as {status?: unknown} | null)?.status;
      if (typeof status !== 'number') { throw error; }
      if (status === 429) { return {status: 429, body: {error: 'Busy — try again in a moment'}}; }
      console.error(`AI search: model API error ${status}:`, error instanceof Error ? error.message : error);
      if (status === 401 || status === 403) { return {status: 502, body: {error: 'The AI service is not configured'}}; }
      return {status: 502, body: {error: 'The AI service failed'}};
    }
  };
}

/** A Fetch-API handler (`Request` → `Response`) for POST requests: Next.js routes, Hono, Bun, Deno, Workers. */
export function createAiSearchHandler(options: AiSearchServerOptions = {}): (request: Request) => Promise<Response> {
  const run = createAiSearch(options);
  return async request => {
    if (request.method !== 'POST') { return Response.json({error: 'POST only'}, {status: 405}); }
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({error: 'Body must be JSON'}, {status: 400}); }
    const result = await run(body, request.signal);
    return Response.json(result.body, {status: result.status});
  };
}
