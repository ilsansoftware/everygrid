/**
 * AI search: a reader describes the rows they want in words, an LLM turns that into the grid's own
 * query language, and the query runs through the normal search path (WASM engine, highlight, …).
 *
 * Everygrid never calls a model itself — an API key cannot live in browser code. The host registers
 * a handler with `Everygrid.setAiSearch(handler)`; the handler sends `request.prompt` (system) and
 * `request.question` (user) to its own server and resolves with the query the model wrote. Only the
 * column structure and a few sample values per column go into the prompt, never the dataset.
 */

/** A column as the model sees it. `keys` lists the sub-keys of an object / array-of-object column. */
export interface AiSearchField {
  key: string;
  /** Localized display name (columnI18n), when it differs from the key. */
  label?: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'mixed';
  /** A few distinct values from the loaded rows, so the model can match the data's own spelling. */
  samples: (string | number | boolean)[];
  keys?: AiSearchField[];
}

export interface AiSearchRequest {
  /** What the reader typed. Send it as the user message. */
  question: string;
  /** The target id of the grid being searched. */
  gridId: string;
  /** The grid's UI locale. */
  locale: 'ko' | 'en';
  fields: AiSearchField[];
  /** Ready-made system prompt: the query syntax, the fields above and the output rules. */
  prompt: string;
  /** Aborted when the reader cancels or closes the dialog — pass it on to `fetch`. */
  signal: AbortSignal;
}

/** Resolves with the query to run. Surrounding code fences or quotes are stripped. */
export type AiSearchHandler = (request: AiSearchRequest) => Promise<string>;

/** Shortcut for a server built with `@everygrid/grid/ai-server`: POST `{question, locale, fields}` → `{query}`. */
export interface AiSearchEndpoint {
  endpoint: string;
  /** Extra request headers, e.g. a CSRF token. */
  headers?: Record<string, string>;
}

/** The handler that talks to an `ai-server` endpoint. Error replies surface their `error` text. */
export function endpointHandler({endpoint, headers}: AiSearchEndpoint): AiSearchHandler {
  return async ({question, locale, fields, signal}) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {'content-type': 'application/json', ...headers},
      body: JSON.stringify({question, locale, fields}),
      signal,
    });
    const body = await res.json().catch(() => ({})) as {query?: unknown; error?: unknown};
    if (!res.ok) { throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${res.status}`); }
    return typeof body.query === 'string' ? body.query : '';
  };
}

let handler: AiSearchHandler | null = null;

export function setAiSearchHandler(fn: AiSearchHandler | null): void { handler = fn; }
export function getAiSearchHandler(): AiSearchHandler | null { return handler; }

const RECENT_MAX = 5;
const recentKey = (gridId: string) => `everygrid:aiSearch:recent:${gridId}`;

/** Questions asked on a grid, newest first. Browser storage can be missing or blocked — then none. */
export function loadRecentQuestions(gridId: string): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(recentKey(gridId)) ?? '[]');
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Moves `question` to the front (`keep`) or drops it, and stores the list. Returns the new list. */
export function updateRecentQuestions(gridId: string, question: string, keep: boolean): string[] {
  const list = loadRecentQuestions(gridId).filter(q => q !== question);
  if (keep) { list.unshift(question); }
  const next = list.slice(0, RECENT_MAX);
  try { localStorage.setItem(recentKey(gridId), JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

type Scalar = string | number | boolean;

const MAX_SAMPLES_SCANNED = 200;
const MAX_SAMPLE_LENGTH = 40;
const MAX_DEPTH = 3;

const kindOf = (v: unknown): AiSearchField['type'] | null =>
  v === null || v === undefined ? null
    : Array.isArray(v) ? 'array'
      : typeof v === 'object' ? 'object'
        : typeof v === 'number' ? 'number'
          : typeof v === 'boolean' ? 'boolean'
            : 'string';

/**
 * Describes the columns of `rows` (the first 200 are scanned): type, up to `sampleCount` distinct
 * values, and sub-keys for nested data. `labelOf` maps a top-level key to its display name.
 */
export function describeFields(rows: unknown[], sampleCount: number, labelOf?: (key: string) => string): AiSearchField[] {
  const build = (values: unknown[], depth: number): AiSearchField[] => {
    const byKey = new Map<string, unknown[]>();
    for (const v of values) {
      const items = Array.isArray(v) ? v : [v];
      for (const item of items) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { continue; }
        for (const [k, child] of Object.entries(item as Record<string, unknown>)) {
          let list = byKey.get(k);
          if (!list) { list = []; byKey.set(k, list); }
          list.push(child);
        }
      }
    }
    return [...byKey].map(([key, list]) => {
      const kinds = new Set(list.map(kindOf).filter(k => k !== null));
      const type: AiSearchField['type'] = kinds.size === 1 ? [...kinds][0]! : kinds.size === 0 ? 'string' : 'mixed';
      const samples: Scalar[] = [];
      if (sampleCount > 0) {
        const seen = new Set<string>();
        for (const v of list.flat()) {
          if (samples.length >= sampleCount) { break; }
          if (v === null || v === undefined || typeof v === 'object') { continue; }
          const s = typeof v === 'string' && v.length > MAX_SAMPLE_LENGTH ? v.slice(0, MAX_SAMPLE_LENGTH) + '…' : v as Scalar;
          const id = `${typeof s}:${String(s)}`;
          if (s === '' || seen.has(id)) { continue; }
          seen.add(id);
          samples.push(s);
        }
      }
      const field: AiSearchField = {key, type, samples};
      if (depth === 0 && labelOf) {
        const label = labelOf(key);
        if (label && label !== key) { field.label = label; }
      }
      if ((type === 'object' || type === 'array' || type === 'mixed') && depth < MAX_DEPTH) {
        const keys = build(list, depth + 1);
        if (keys.length > 0) { field.keys = keys; }
      }
      return field;
    });
  };
  return build(rows.slice(0, MAX_SAMPLES_SCANNED), 0);
}

const describe = (fields: AiSearchField[], indent: string): string =>
  fields.map(f => {
    const label = f.label ? ` "${f.label}"` : '';
    const samples = f.samples.length > 0 ? ` — e.g. ${f.samples.map(s => JSON.stringify(s)).join(', ')}` : '';
    const head = `${indent}- ${f.key}${label} (${f.type})${samples}`;
    return f.keys ? `${head}\n${describe(f.keys, indent + '  ')}` : head;
  }).join('\n');

/** The system prompt sent with every AI search: query syntax, the grid's fields, output rules. */
export function buildAiSearchPrompt(fields: AiSearchField[], locale: 'ko' | 'en', today = new Date()): string {
  return `You convert a request for rows of a data grid into the grid's search query.

Query syntax (keys and text match case-insensitively; combine with && and ||, group with parentheses):
- text — free text, matches any field at any depth: frontend
- field(expr) — scope into a field, nest for depth: role(engineering(subRole(front)))
- a(x).b(y) — sibling keys ANDed on the same object or array element: subRole(front).years(>=2)
- field(>n) field(>=n) field(<n) field(<=n) field(==v) field(!=v): age(>=30), dept(!=HR)
- the same comparisons work on ISO dates as text: joinedDate(>=2024-01-01)
- field(in[a,b]) — membership: dept(in[HR,Design])
- field(~re) — regular expression: email(~@example\\.com$)
- field(==true) / field(==false) for booleans
A field scope over an array matches when any element satisfies it.

Fields of this grid (key, display name, type, sample values):
${describe(fields, '')}

Rules:
- Reply with the query only: one line, no explanation, no code fence, no quotes around it.
- Use the field keys exactly as listed, never the display names.
- Reach nested keys by nesting parentheses, never a dotted path: role(engineering(years(>=2))), not role.engineering.years(>=2).
- Write values the way the data spells them (see the samples), in the data's language: when the reader's
  words differ, translate them to match the samples (부산 → Busan if the samples are English). Numbers
  without units or separators.
- Prefer exact comparisons on a field over free text whenever a field fits.
- Today is ${today.toISOString().slice(0, 10)}. The reader writes in ${locale === 'ko' ? 'Korean' : 'English'}.
- If the request cannot be expressed, reply with the closest free-text query.`;
}

/** The query in a model's reply: the first non-empty line, without code fences or wrapping quotes. */
export function cleanAiQuery(raw: string): string {
  const unfenced = raw.replace(/```[a-z]*\n?/gi, '').trim();
  const line = unfenced.split('\n').map(l => l.trim()).find(l => l !== '') ?? '';
  const m = /^(["'`])(.*)\1$/.exec(line);
  return (m ? m[2] : line).trim();
}
