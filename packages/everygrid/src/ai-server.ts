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
 * The model answers with conditions as JSON, held to a schema (`AI_SEARCH_SCHEMA`); they are checked
 * against the field list — one retry if a key is unknown — and written out as the grid's query.
 * The provider SDK is an optional peer: install `@anthropic-ai/sdk` or `openai`, whichever you use.
 */
import {type AiSearchField, buildAiSearchPrompt, cleanAiQuery} from './core/aiSearch';

export type {AiSearchField} from './core/aiSearch';

export type AiSearchProvider = 'anthropic' | 'openai';

/**
 * One model call: the system prompt and the reader's question in, the model's reply text out. Hold
 * the model to `schema` (JSON output) when the API can; a reply that is not JSON is taken as a
 * query string as-is.
 */
export type AiSearchComplete = (call: {
  system: string;
  question: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<string>;

export type AiSearchOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'regex';

/** One test on one field; `path` empty means free text over every field. */
export interface AiSearchCondition {
  path: string[];
  op: AiSearchOp;
  value: string | number | boolean;
  values: string[];
}

/** What the model answers: alternatives (OR), each a list of conditions that all hold (AND). */
export interface AiSearchConditions {
  any: {all: AiSearchCondition[]}[];
}

const OPS: AiSearchOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'regex'];

/** JSON Schema of `AiSearchConditions`, in the subset both Claude and OpenAI enforce (strict). */
export const AI_SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    any: {
      type: 'array',
      description: 'Alternatives (OR). Each holds conditions that must all match (AND).',
      items: {
        type: 'object',
        properties: {all: {type: 'array', items: {$ref: '#/$defs/condition'}}},
        required: ['all'],
        additionalProperties: false,
      },
    },
  },
  required: ['any'],
  additionalProperties: false,
  $defs: {
    condition: {
      type: 'object',
      properties: {
        path: {type: 'array', items: {type: 'string'}, description: 'Field keys, outermost first. [] = free text over every field.'},
        op: {type: 'string', enum: OPS},
        value: {anyOf: [{type: 'string'}, {type: 'number'}, {type: 'boolean'}], description: 'The operand; "" for in.'},
        values: {type: 'array', items: {type: 'string'}, description: 'The list for in; [] otherwise.'},
      },
      required: ['path', 'op', 'value', 'values'],
      additionalProperties: false,
    },
  },
};

const LEAF: Partial<Record<AiSearchOp, string>> = {eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<='};

// The query grammar has no quoting: parentheses and && / || in a value would end the expression.
const plain = (v: unknown) => String(v).replace(/&&|\|\|/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) { depth += ch === '(' ? 1 : ch === ')' ? -1 : 0; if (depth < 0) { return false; } }
  return depth === 0;
};

/** Writes conditions in the grid's query language: `a(b(>=2)) && c(x) || (d(==1) && e)`. */
export function conditionsToQuery(conditions: AiSearchConditions): string {
  const write = (c: AiSearchCondition): string => {
    let leaf: string;
    if (c.op === 'in') {
      const items = c.values.map(v => plain(v).replace(/[,[\]]/g, ' ').trim()).filter(Boolean);
      if (items.length === 0) { return ''; }
      leaf = `in[${items.join(',')}]`;
    } else if (c.op === 'regex') {
      const re = String(c.value).replace(/&&|\|\|/g, '|').trim();
      leaf = re && (balanced(re) ? `~${re}` : `~${plain(re)}`);
    } else {
      const v = plain(c.value);
      leaf = v && (c.op === 'contains' || !LEAF[c.op] ? v : `${LEAF[c.op]}${v}`);
    }
    if (!leaf) { return ''; }
    const keys = c.path.map(k => plain(k)).filter(Boolean);
    return keys.reduceRight((inner, key) => `${key}(${inner})`, leaf);
  };
  const groups = conditions.any.map(g => g.all.map(write).filter(Boolean)).filter(g => g.length > 0);
  return groups.map(g => (g.length > 1 && groups.length > 1 ? `(${g.join(' && ')})` : g.join(' && '))).join(' || ');
}

/** The condition paths that name no field of the list (case-insensitive, as the engine matches). */
export function unknownPaths(conditions: AiSearchConditions, fields: AiSearchField[]): string[] {
  const bad: string[] = [];
  for (const c of conditions.any.flatMap(g => g.all)) {
    let level: AiSearchField[] | undefined = fields;
    for (const key of c.path) {
      // Past the described depth (no sub-keys listed) any key is plausible.
      if (!level) { break; }
      const f: AiSearchField | undefined = level.find(x => x.key.toLowerCase() === key.toLowerCase());
      if (!f) { bad.push(c.path.join('.')); break; }
      level = f.keys;
    }
  }
  return bad;
}

function parseConditions(raw: unknown): AiSearchConditions | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as AiSearchConditions).any)) { return null; }
  const any: AiSearchConditions['any'] = [];
  for (const g of (raw as {any: unknown[]}).any) {
    const all = (g as {all?: unknown} | null)?.all;
    if (!Array.isArray(all)) { return null; }
    const conds: AiSearchCondition[] = [];
    for (const c of all as Record<string, unknown>[]) {
      if (!c || !Array.isArray(c.path) || !OPS.includes(c.op as AiSearchOp)) { return null; }
      conds.push({
        path: c.path.map(String),
        op: c.op as AiSearchOp,
        value: ['string', 'number', 'boolean'].includes(typeof c.value) ? c.value as string | number | boolean : '',
        values: Array.isArray(c.values) ? c.values.map(String) : [],
      });
    }
    any.push({all: conds});
  }
  return {any};
}

/** A model reply → `{query}`, or `{problem}` to put to the model once more. */
function readReply(text: string, fields: AiSearchField[]): {query: string} | {problem: string} {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return {query: cleanAiQuery(text)}; }   // a plain query string
  const conditions = parseConditions(json);
  if (!conditions) { return {problem: 'The answer did not match the schema.'}; }
  const unknown = unknownPaths(conditions, fields);
  if (unknown.length > 0) {
    return {problem: `These paths name no field: ${unknown.join(', ')}. Use only the keys listed.`};
  }
  return {query: conditionsToQuery(conditions)};
}

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
const TYPES = new Set<AiSearchField['type']>(['string', 'number', 'boolean', 'date', 'object', 'array', 'mixed']);

/** The field list as sent, cut down to what the prompt uses: known properties only, bounded sizes. */
export function sanitizeFields(raw: unknown): AiSearchField[] | null {
  let budget = MAX_FIELDS;
  const walk = (list: unknown, depth: number): AiSearchField[] | null => {
    if (!Array.isArray(list)) { return null; }
    const out: AiSearchField[] = [];
    for (const f of list) {
      if (budget-- <= 0) { break; }
      if (!f || typeof f !== 'object') { return null; }
      const {key, label, type, samples, keys, complete, min, max} = f as Record<string, unknown>;
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
      if (complete === true) { field.complete = true; }
      for (const [name, v] of [['min', min], ['max', max]] as const) {
        if (typeof v === 'number' && Number.isFinite(v)) { field[name] = v; }
        else if (typeof v === 'string') { field[name] = v.slice(0, MAX_TEXT); }
      }
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
  return async ({system, question, schema, signal}) => {
    const response = await (await client).beta.messages.create({
      model,
      max_tokens: 2048,
      output_config: {format: {type: 'json_schema', schema}, ...(tuned ? {effort: 'low' as const} : {})},
      ...(tuned ? {betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const} : {}),
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
  return async ({system, question, schema, signal}) => {
    const response = await (await client).chat.completions.create({
      model,
      messages: [{role: 'system', content: system}, {role: 'user', content: question}],
      response_format: {type: 'json_schema', json_schema: {name: 'everygrid_conditions', strict: true, schema}},
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
      const system = buildAiSearchPrompt(fields, locale, new Date(), 'json');
      const ask = (q: string) => complete!({system, question: q, schema: AI_SEARCH_SCHEMA, signal});
      let reply = readReply(await ask(question), fields);
      if ('problem' in reply) {
        // One more go, told what was wrong; a second miss is reported rather than run as a bad query.
        reply = readReply(await ask(`${question}\n\n(Your previous answer was not usable. ${reply.problem})`), fields);
        if ('problem' in reply) { return {status: 422, body: {error: 'The AI could not express this as a search'}}; }
      }
      return {status: 200, body: {query: reply.query}};
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
