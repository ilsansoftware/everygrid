import React from 'react';

const parseTerms = (query: string): string[] => {
  const terms = query
    .split('||')
    .flatMap(orPart => orPart.split('&&'))
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);
  return [...new Set(terms)];
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

export const highlightText = (text: string, query: string): React.JSX.Element | string => {
  if (!query) return text;
  const terms = parseTerms(query);
  return highlightWithTerms(text, terms);
};

export const objectContainsFilter = (val: unknown, query: string): boolean => {
  if (!query) return false;
  const terms = parseTerms(query);
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
  return terms.some(term => checkTerm(val, term));
};
