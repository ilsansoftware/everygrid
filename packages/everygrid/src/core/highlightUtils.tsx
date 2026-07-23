import React from 'react';

// A highlightable literal, optionally scoped to a column (from `col(...)` syntax).
interface HTerm { term: string; col?: string }
// A column-scoped comparison (`>`,`<`,`>=`,`<=`); the operand is kept raw (lowercased at test time).
interface Pred { col: string; op: string; operand: string }
// A column-scoped regex literal (`~pattern`), highlighted where it matches.
interface HRegex { pattern: string; col?: string }

// Comparison operators, longest-first so `<=` wins over `<`, `==` over `=`, `!=` over `=`.
const CMP_OPS = ['!=', '<=', '>=', '==', '<', '>', '='];
// Operator flip for the value-first form (`30<=col` means `col >= 30`). `=`/`!=` are symmetric.
const REVERSE: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '==': '==', '!=': '!=' };

// Split on a separator only at paren depth 0 — mirrors the WASM grammar's top-level split so
// `age(<40 && 30<=) && role(qa)` breaks into its real top-level tokens, not on inner `&&`.
const splitTopLevel = (input: string, sep: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i + sep.length <= input.length; i++) {
    const c = input[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; }
    else if (depth === 0 && input.startsWith(sep, i)) {
      out.push(input.slice(last, i));
      // i now sits on the separator's first char; advance past it. `last` must be the first char
      // AFTER the separator — since the loop's i++ lands i there, that's `i + sep.length`.
      i += sep.length - 1;
      last = i + 1;
    }
  }
  out.push(input.slice(last));
  return out;
};

// Split on a `.` right after `)` at depth 0 — the correlated and (`subRole(front).years(=1)`,
// both sides on the SAME array element). Mirrors the WASM `split_dot`.
const splitDot = (input: string): string[] => {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; }
    else if (c === '.' && depth === 0 && i > 0 && input[i - 1] === ')') { out.push(input.slice(last, i)); last = i + 1; }
  }
  out.push(input.slice(last));
  return out;
};

// Split on AND boundaries: `&&`, and a `.` right after `)` (the sibling-key chain
// `subRole(front).years(=1)`), at paren depth 0. Used by the flat term extraction, which only
// needs the leaves and doesn't care which and-flavour separated them.
const splitAnd = (input: string): string[] => {
  const out: string[] = [];
  let depth = 0, last = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; }
    else if (depth === 0 && input.startsWith('&&', i)) { out.push(input.slice(last, i)); i++; last = i + 1; }
    else if (c === '.' && depth === 0 && i > 0 && input[i - 1] === ')') { out.push(input.slice(last, i)); last = i + 1; }
  }
  out.push(input.slice(last));
  return out;
};

// Parse one column leaf into either a `contains`/equality operand or an ordered comparison.
const parseLeaf = (leaf: string): { op?: string; operand: string } => {
  const op = CMP_OPS.find(o => leaf.includes(o));
  if (!op) return { operand: leaf };
  const idx = leaf.indexOf(op);
  const before = leaf.slice(0, idx).trim();
  const after = leaf.slice(idx + op.length).trim();
  if (before === '') return { op, operand: after };              // OP val
  if (after === '') return { op: REVERSE[op], operand: before }; // val OP → flip
  return { op, operand: after };
};

// ---- matching (mirrors the WASM filter grammar, for highlight only) --------------

const NUM_RE = /^-?\d+(\.\d+)?$/;
const isDateLike = (s: string) => /^\d{4}-/.test(s);
const normSep = (s: string) => (s.includes('t') ? s.replace(/t/g, ' ') : s);
const strOrd = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const testOrd = (op: string, cmp: number): boolean => {
  switch (op) {
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    default: return cmp === 0; // = / ==
  }
};

// Prefix-range compare: operand is a period prefix (year/day). `>`/`<=` relative to its end,
// `>=`/`<` to its start, `=` matches the whole period.
const rangeCmp = (field: string, operand: string, op: string): boolean => {
  switch (op) {
    case '>=': return field >= operand;
    case '<': return field < operand;
    case '<=': return field < operand || field.startsWith(operand);
    case '>': return field > operand && !field.startsWith(operand);
    default: return field.startsWith(operand); // = / ==
  }
};

const textCmp = (field: string, operand: string, op: string): boolean =>
  (op === '=' || op === '==') ? field === operand : testOrd(op, strOrd(field, operand));

const dateCmp = (field: string, operand: string, op: string) => rangeCmp(normSep(field), normSep(operand), op);

// Test a single scalar cell value against `op operand`.
const scalarSatisfies = (value: unknown, op: string, operand: string): boolean => {
  if (value === null || value === undefined) return false;
  const trimmed = operand.trim();
  if (NUM_RE.test(trimmed)) {
    const opNum = Number(trimmed);
    const s = String(value);
    if (typeof value === 'number' || (s.trim() !== '' && NUM_RE.test(s.trim()))) {
      const vNum = Number(s);
      return testOrd(op, vNum < opNum ? -1 : vNum > opNum ? 1 : 0);
    }
    const vStr = s.toLowerCase();
    return isDateLike(vStr) && rangeCmp(vStr, String(opNum), op); // year search on a date field
  }
  const operandLower = trimmed.toLowerCase();
  const vStr = String(value).toLowerCase();
  return isDateLike(operandLower) ? (isDateLike(vStr) && dateCmp(vStr, operandLower, op)) : textCmp(vStr, operandLower, op);
};

// True if any leaf inside a nested value satisfies the comparison.
const objSatisfies = (val: unknown, op: string, operand: string): boolean => {
  if (Array.isArray(val)) return val.some(x => objSatisfies(x, op, operand));
  if (val && typeof val === 'object') return Object.values(val).some(x => objSatisfies(x, op, operand));
  return scalarSatisfies(val, op, operand);
};

// ---- query parsing ---------------------------------------------------------------

// Classify one leaf (already known not to be a nested `field(...)`) into a highlight term, an
// `in[...]` member list, a regex, or an ordered comparison. `!=` is skipped (nothing to highlight).
const classifyLeaf = (leaf: string, col: string | undefined, terms: HTerm[], preds: Pred[], regexes: HRegex[]): void => {
  if (leaf.startsWith('~')) { const p = leaf.slice(1).trim(); if (p) regexes.push({ pattern: p, col }); return; }
  const low = leaf.toLowerCase();
  if ((low.startsWith('in[') && leaf.endsWith(']')) || (low.startsWith('in(') && leaf.endsWith(')'))) {
    for (const it of leaf.slice(3, -1).split(',').map(s => s.trim()).filter(Boolean)) terms.push({ term: it.toLowerCase(), col });
    return;
  }
  const { op, operand } = parseLeaf(leaf);
  if (!op) terms.push({ term: leaf.toLowerCase(), col });                 // contains
  else if (op === '!=') { /* exclusion — nothing to highlight */ }
  else if (op === '=' || op === '==') { if (operand) terms.push({ term: operand.toLowerCase(), col }); }
  else if (operand) preds.push({ col: col ?? '', op, operand });         // ordered comparison
};

// Recurse into an inner expression, descending through nested `field(...)` scopes (keeping the
// top-level column for scoping) so terms at ANY depth get collected — matching the WASM grammar.
const extractCol = (inner: string, col: string | undefined, terms: HTerm[], preds: Pred[], regexes: HRegex[]): void => {
  for (const raw of splitTopLevel(inner, '||').flatMap(p => splitAnd(p))) {
    const leaf = raw.trim();
    if (!leaf) continue;
    const open = (leaf.endsWith(')') && !/^in\(/i.test(leaf)) ? leaf.indexOf('(') : -1;
    if (open > 0) extractCol(leaf.slice(open + 1, leaf.length - 1), col, terms, preds, regexes);
    else classifyLeaf(leaf, col, terms, preds, regexes);
  }
};

// Un-parenthesized `path op value` → (col, remainder) so highlight matches the filter's no-paren form.
const splitUnparen = (t: string): { col: string; rest: string } | null => {
  const isPath = (s: string) => s.length > 0 && /^\w+$/.test(s);
  for (const op of ['!=', '<=', '>=', '==', '~', '<', '>', '=']) {
    const idx = t.indexOf(op);
    if (idx <= 0) continue;
    const left = t.slice(0, idx).trim();
    const right = t.slice(idx + op.length).trim();
    if (isPath(left) && right) return { col: left.toLowerCase(), rest: op + right };
  }
  return null;
};

const parseQuery = (query: string): { terms: HTerm[]; preds: Pred[]; regexes: HRegex[] } => {
  const terms: HTerm[] = [];
  const preds: Pred[] = [];
  const regexes: HRegex[] = [];
  for (const raw of splitTopLevel(query, '||').flatMap(p => splitAnd(p))) {
    const t = raw.trim();
    if (!t) continue;
    const open = (t.endsWith(')') && !/^in\(/i.test(t)) ? t.indexOf('(') : -1;
    if (open > 0) { extractCol(t.slice(open + 1, t.length - 1), t.slice(0, open).trim().toLowerCase(), terms, preds, regexes); continue; }
    const up = splitUnparen(t);
    if (up) classifyLeaf(up.rest, up.col, terms, preds, regexes);
    else terms.push({ term: t.toLowerCase() });
  }
  return { terms, preds, regexes };
};

// Terms that apply to a field: global terms + column-scoped terms whose column matches. With no
// field (nested/unknown context) every term applies, best-effort.
const termsForField = (terms: HTerm[], field?: string): string[] => {
  const f = field?.toLowerCase();
  return [...new Set(terms.filter(h => !h.col || f === undefined || h.col === f).map(h => h.term).filter(t => t.length > 0))];
};

const highlightWithTerms = (text: string, terms: string[], regexPatterns: string[] = []): React.JSX.Element | string => {
  if (terms.length === 0 && regexPatterns.length === 0) return text;
  const lower = text.toLowerCase();
  const matches: { start: number; end: number }[] = [];
  for (const term of terms) {
    let cursor = 0;
    while (cursor < lower.length) {
      const pos = lower.indexOf(term, cursor);
      if (pos === -1) break;
      matches.push({ start: pos, end: pos + term.length });
      cursor = pos + term.length;
    }
  }
  for (const pattern of regexPatterns) {
    let re: RegExp;
    try { re = new RegExp(pattern, 'g'); } catch { continue; }
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // avoid zero-width infinite loop
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  if (matches.length === 0) return text;
  matches.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const m of matches) {
    if (merged.length > 0 && m.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, m.end);
    } else {
      merged.push({ ...m });
    }
  }
  const parts: React.JSX.Element[] = [];
  let cursor = 0;
  let key = 0;
  for (const { start, end } of merged) {
    if (start > cursor) parts.push(<span key={key++}>{text.slice(cursor, start)}</span>);
    parts.push(<mark key={key++} className="everygrid-highlight">{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(<span key={key}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
};

export const highlightText = (text: string, query: string, field?: string): React.JSX.Element | string => {
  if (!query) return text;
  const { terms, preds, regexes } = parseQuery(query);
  const f = field?.toLowerCase();
  // A matching ordered comparison highlights the whole cell (the value itself is the match). With a
  // known field, scope to that column; in a nested cell (field unknown) apply best-effort — it only
  // marks when the value actually satisfies the comparison.
  if (preds.some(p => (f === undefined || p.col === f) && scalarSatisfies(text, p.op, p.operand))) {
    return <mark className="everygrid-highlight">{text}</mark>;
  }
  const regexPatterns = [...new Set(regexes.filter(r => !r.col || f === undefined || r.col === f).map(r => r.pattern))];
  return highlightWithTerms(text, termsForField(terms, field), regexPatterns);
};

// ---- correlation-aware element gating (nested-table highlight) --------------------
// A JS mirror of the WASM filter grammar. Its job: find the ARRAY ELEMENTS that actually satisfy a
// field-scope's (correlated) inner condition, so a `.`-chained predicate (`subRole(back).years(=4)`)
// only highlights the element where BOTH held — not every element with years=4.

// Every node carries the source text it was parsed from, so a match can be reported back as the
// sub-query that actually held — see makeElementGate.
type QNode = {src: string} & (
  | {t: 'empty'}
  | {t: 'contains'; v: string}
  | {t: 'cmp'; op: string; operand: string}
  | {t: 'in'; items: string[]}
  | {t: 'regex'; pattern: string}
  | {t: 'field'; name: string; inner: QNode}
  | {t: 'and'; items: QNode[]}
  /** `.` — same-element conjunction. Separate from 'and', which distributes over array elements. */
  | {t: 'dot'; items: QNode[]}
  | {t: 'or'; items: QNode[]});

const parseLeafNode = (tok: string): QNode => {
  const t = tok.trim();
  if (!t) return {t: 'empty', src: t};
  if (t.endsWith(')') && !/^in\(/i.test(t)) {
    const open = t.indexOf('(');
    if (open > 0) return {t: 'field', name: t.slice(0, open).trim(), inner: parseNodeExpr(t.slice(open + 1, -1)), src: t};
  }
  if (t.startsWith('~')) { const p = t.slice(1).trim(); return p ? {t: 'regex', pattern: p, src: t} : {t: 'empty', src: t}; }
  const low = t.toLowerCase();
  if ((low.startsWith('in[') && t.endsWith(']')) || (low.startsWith('in(') && t.endsWith(')'))) {
    const items = t.slice(3, -1).split(',').map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase());
    return items.length ? {t: 'in', items, src: t} : {t: 'empty', src: t};
  }
  const {op, operand} = parseLeaf(t);
  return op ? {t: 'cmp', op, operand, src: t} : {t: 'contains', v: t.toLowerCase(), src: t};
};
const parseDotNode = (input: string): QNode => {
  const items = splitDot(input).map(parseLeafNode).filter(n => n.t !== 'empty');
  return items.length === 0 ? {t: 'empty', src: input.trim()}
    : items.length === 1 ? items[0]
      : {t: 'dot', items, src: input.trim()};
};
const parseAndNode = (input: string): QNode => {
  const items = splitTopLevel(input, '&&').map(parseDotNode).filter(n => n.t !== 'empty');
  return items.length === 0 ? {t: 'empty', src: input.trim()}
    : items.length === 1 ? items[0]
      : {t: 'and', items, src: input.trim()};
};
const parseNodeExpr = (input: string): QNode => {
  const items = splitTopLevel(input, '||').map(parseAndNode).filter(n => n.t !== 'empty');
  return items.length === 0 ? {t: 'empty', src: input.trim()}
    : items.length === 1 ? items[0]
      : {t: 'or', items, src: input.trim()};
};

const ciGetVal = (obj: Record<string, unknown>, name: string): unknown => {
  const k = Object.keys(obj).find(key => key.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : obj[k];
};
const leafContains = (v: unknown, term: string): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.toLowerCase().includes(term);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).toLowerCase().includes(term);
  if (Array.isArray(v)) return v.some(x => leafContains(x, term));
  return Object.entries(v as Record<string, unknown>).some(([k, c]) => k.toLowerCase().includes(term) || leafContains(c, term));
};
const leafRegex = (v: unknown, re: RegExp): boolean => {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return re.test(v);
  if (typeof v === 'number' || typeof v === 'boolean') return re.test(String(v));
  if (Array.isArray(v)) return v.some(x => leafRegex(x, re));
  return Object.values(v as Record<string, unknown>).some(x => leafRegex(x, re));
};

const evalNode = (node: QNode, v: unknown): boolean => {
  switch (node.t) {
    case 'empty': return true;
    case 'contains': return leafContains(v, node.v);
    case 'cmp': return objSatisfies(v, node.op, node.operand);
    case 'in': return node.items.some(it => objSatisfies(v, '==', it));
    case 'regex': { try { return leafRegex(v, new RegExp(node.pattern)); } catch { return false; } }
    case 'and': case 'dot': return node.items.every(n => evalNode(n, v));
    case 'or': return node.items.some(n => evalNode(n, v));
    case 'field': return evalField(node.name, node.inner, v);
  }
};
// Against an ARRAY child, `&&`/`||` distribute (each operand may match its own element) while
// everything else — `.` included — must be satisfied by a single element. Mirrors the WASM
// `ColExpr::matches_array`; keeping the two in step is what stops the highlight from disagreeing
// with the filter.
const matchesArray = (node: QNode, arr: unknown[]): boolean => {
  if (node.t === 'and') return node.items.every(n => matchesArray(n, arr));
  if (node.t === 'or') return node.items.some(n => matchesArray(n, arr));
  return arr.some(e => evalNode(node, e));
};
const evalField = (name: string, inner: QNode, v: unknown): boolean => {
  if (Array.isArray(v)) return v.some(e => evalField(name, inner, e));
  if (v && typeof v === 'object') {
    const child = ciGetVal(v as Record<string, unknown>, name);
    if (child === undefined) return false;
    return Array.isArray(child) ? matchesArray(inner, child) : evalNode(inner, child);
  }
  return false;
};

// The branches that can independently light up an element. `||` obviously splits; `&&` splits too,
// because its sides may be satisfied by different elements (the row already matched as a whole, so
// each element shows the conjunct it contributed). `.` never splits — that is the correlated and,
// and its sides only mean anything together.
const alternatives = (node: QNode): QNode[] =>
  node.t === 'or' || node.t === 'and' ? node.items.flatMap(alternatives) : [node];

// Record, per array element, WHICH alternatives of a field-scope's inner it satisfies — not just
// that it matched. `Engineering(subRole(front).years(3) || subRole(back))` matches the Backend
// element through `subRole(back)` alone, so only that branch may highlight inside it; carrying the
// whole query over would light up any 3 it happens to contain.
const recordMatches = (node: QNode, v: unknown, out: Map<object, Set<string>>): void => {
  if (node.t === 'and' || node.t === 'or' || node.t === 'dot') { node.items.forEach(n => recordMatches(n, v, out)); return; }
  if (node.t !== 'field') return;
  const resolve = (val: unknown) => {
    if (Array.isArray(val)) { val.forEach(resolve); return; }
    if (!val || typeof val !== 'object') return;
    const child = ciGetVal(val as Record<string, unknown>, node.name);
    if (child === undefined) return;
    if (Array.isArray(child)) {
      for (const e of child) {
        if (e && typeof e === 'object') {
          for (const alt of alternatives(node.inner)) {
            if (!evalNode(alt, e)) continue;
            const hit = out.get(e as object) ?? new Set<string>();
            hit.add(alt.src);
            out.set(e as object, hit);
          }
        }
        recordMatches(node.inner, e, out);
      }
    } else {
      recordMatches(node.inner, child, out);
    }
  };
  resolve(v);
};

// Plain (non-field-scoped) contains/regex terms — highlight any element containing them, so a bare
// search term still works alongside correlated conditions.
const collectPlain = (node: QNode, terms: string[], regexes: string[]): void => {
  switch (node.t) {
    case 'contains': terms.push(node.v); break;
    case 'regex': regexes.push(node.pattern); break;
    case 'in': node.items.forEach(i => terms.push(i)); break;
    // Descend nested field scopes so a scalar leaf deep in a chain (`examResults(failed(english))`)
    // still yields its term — object elements stay precise via the matched map; this only adds
    // best-effort highlighting for the scalar array leaves that map can't key.
    case 'field': collectPlain(node.inner, terms, regexes); break;
    case 'and': case 'or': node.items.forEach(n => collectPlain(n, terms, regexes)); break;
    default: break; // dot → correlation; cmp → handled by pred/correlation
  }
};

// Build a gate for nested-table highlighting. Returns, for an element, the part of the query that
// actually holds for it — '' when none does, so the caller highlights nothing. `rootData` should be
// the whole row so top-level column scopes resolve.
export const makeElementGate = (rootData: unknown, query: string): (el: unknown) => string => {
  if (!query) return () => '';
  const root = parseNodeExpr(query);
  const matched = new Map<object, Set<string>>();
  recordMatches(root, rootData, matched);
  const terms: string[] = [];
  const regexes: string[] = [];
  const top: QNode[] = [];
  const flatten = (n: QNode) => { if (n.t === 'and' || n.t === 'or' || n.t === 'dot') n.items.forEach(flatten); else top.push(n); };
  flatten(root);
  for (const tok of top) collectPlain(tok, terms, regexes);
  const compiled = regexes.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean) as RegExp[];
  return (el: unknown) => {
    const parts: string[] = [];
    if (el && typeof el === 'object') {
      const hit = matched.get(el as object);
      if (hit) parts.push(...hit);
    }
    // Plain terms aren't scoped to an element, so they stand on their own wherever they appear.
    for (const t of terms) if (leafContains(el, t)) parts.push(t);
    for (const re of compiled) if (leafRegex(el, re)) parts.push(`~${re.source}`);
    return parts.join(' || ');
  };
};

export const objectContainsFilter = (val: unknown, query: string, field?: string): boolean => {
  if (!query) return false;
  const { terms, preds, regexes } = parseQuery(query);
  const f = field?.toLowerCase();
  if (preds.some(p => (f === undefined || p.col === f) && objSatisfies(val, p.op, p.operand))) return true;
  const scoped = termsForField(terms, field);
  const scopedRes = regexes.filter(r => !r.col || f === undefined || r.col === f).map(r => r.pattern);
  if (scoped.length === 0 && scopedRes.length === 0) return false;
  const compiled = scopedRes.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean) as RegExp[];
  const check = (v: unknown): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return scoped.some(t => v.toLowerCase().includes(t)) || compiled.some(re => re.test(v));
    if (typeof v === 'number' || typeof v === 'boolean') { const s = String(v); return scoped.some(t => s.toLowerCase().includes(t)) || compiled.some(re => re.test(s)); }
    if (Array.isArray(v)) return v.some(check);
    if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, child]) => scoped.some(t => k.toLowerCase().includes(t)) || check(child));
    return false;
  };
  return check(val);
};
