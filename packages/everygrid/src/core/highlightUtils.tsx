import React from 'react';

// A highlightable literal, optionally scoped to a column (from `col(...)` syntax).
interface HTerm { term: string; col?: string }
// A column-scoped comparison (`>`,`<`,`>=`,`<=`); the operand is kept raw (lowercased at test time).
interface Pred { col: string; op: string; operand: string }

// Comparison operators, longest-first so `<=` wins over `<`, `==` over `=`.
const CMP_OPS = ['<=', '>=', '==', '<', '>', '='];
// Operator flip for the value-first form (`30<=col` means `col >= 30`).
const REVERSE: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '==': '==' };

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
      i += sep.length - 1;
      last = i + sep.length;
    }
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

const extractCol = (inner: string, col: string, terms: HTerm[], preds: Pred[]): void => {
  for (const raw of splitTopLevel(inner, '||').flatMap(p => splitTopLevel(p, '&&'))) {
    const leaf = raw.trim();
    if (!leaf) continue;
    const { op, operand } = parseLeaf(leaf);
    if (!op) terms.push({ term: leaf.toLowerCase(), col });                 // contains
    else if (op === '=' || op === '==') { if (operand) terms.push({ term: operand.toLowerCase(), col }); }
    else if (operand) preds.push({ col, op, operand });                     // ordered comparison
  }
};

const parseQuery = (query: string): { terms: HTerm[]; preds: Pred[] } => {
  const terms: HTerm[] = [];
  const preds: Pred[] = [];
  for (const raw of splitTopLevel(query, '||').flatMap(p => splitTopLevel(p, '&&'))) {
    const t = raw.trim();
    if (!t) continue;
    const open = t.endsWith(')') ? t.indexOf('(') : -1;
    if (open > 0) extractCol(t.slice(open + 1, t.length - 1), t.slice(0, open).trim().toLowerCase(), terms, preds);
    else terms.push({ term: t.toLowerCase() });
  }
  return { terms, preds };
};

// Terms that apply to a field: global terms + column-scoped terms whose column matches. With no
// field (nested/unknown context) every term applies, best-effort.
const termsForField = (terms: HTerm[], field?: string): string[] => {
  const f = field?.toLowerCase();
  return [...new Set(terms.filter(h => !h.col || f === undefined || h.col === f).map(h => h.term).filter(t => t.length > 0))];
};

const highlightWithTerms = (text: string, terms: string[]): React.JSX.Element | string => {
  if (terms.length === 0) return text;
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
  const { terms, preds } = parseQuery(query);
  // A matching ordered comparison highlights the whole cell (the value itself is the match).
  if (field) {
    const f = field.toLowerCase();
    if (preds.some(p => p.col === f && scalarSatisfies(text, p.op, p.operand))) {
      return <mark className="everygrid-highlight">{text}</mark>;
    }
  }
  return highlightWithTerms(text, termsForField(terms, field));
};

export const objectContainsFilter = (val: unknown, query: string, field?: string): boolean => {
  if (!query) return false;
  const { terms, preds } = parseQuery(query);
  const f = field?.toLowerCase();
  if (f !== undefined && preds.some(p => p.col === f && objSatisfies(val, p.op, p.operand))) return true;
  const scoped = termsForField(terms, field);
  if (scoped.length === 0) return false;
  const checkTerm = (v: unknown, term: string): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.toLowerCase().includes(term);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v).toLowerCase().includes(term);
    if (Array.isArray(v)) return v.some(item => checkTerm(item, term));
    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      return Object.entries(obj).some(([k, child]) => k.toLowerCase().includes(term) || checkTerm(child, term));
    }
    return false;
  };
  return scoped.some(term => checkTerm(val, term));
};
