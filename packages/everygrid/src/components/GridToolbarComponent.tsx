import {I18n} from '../i18n/I18n';
import type {CSSProperties, KeyboardEvent, ReactElement} from 'react';
import type {KeyTree} from '../core/types';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ReloadIcon} from '../icons/ReloadIcon';
import {ColumnWidthIcon} from '../icons/ColumnWidthIcon';
import {ColumnsIcon} from '../icons/ColumnsIcon';
import {ExcelIcon} from '../icons/ExcelIcon';
import {DownloadIcon} from '../icons/DownloadIcon';
import {SearchIcon} from '../icons/SearchIcon';
import {SortResetIcon} from '../icons/SortResetIcon';
import {InsertRowIcon} from '../icons/InsertRowIcon';
import {ChangesIcon} from '../icons/ChangesIcon';

/** Hard cap on the search box: it grows to this many rows, and edits past it are rejected. */
const MAX_FILTER_ROWS = 10;

// The box shows coloured text through a transparent textarea sitting over a highlight overlay, so
// the two elements have to break lines in exactly the same places. Soft wrapping cannot be relied on
// for that — when only one of them takes a wrap, the glyphs (overlay) end up on a different line
// from the caret (textarea) and the auto-grow below measures a height the text does not have. So the
// box never soft wraps at all: EVERY wrap point is turned into a real `\n`, which is the one thing
// every engine honours identically. The textarea then grows, and the caret follows the text.
//
// WHERE to break is decided on a hidden mirror of the query, which carries two invisible characters
// the visible text never gets: a zero-width space after each `(` (line breaking offers no
// opportunity there, and the column unit is where the break belongs) and a word joiner after `-`/`?`
// (which do offer one inside a value — that is what split `2026-` / `07`). Greedy line breaking on
// the mirror therefore lands on column boundaries, and those become the newlines.
const ZWSP = '​';
const WJ = '⁠';
const PADDED = /[(\-?]/g;
const decorate = (s: string) => s.replace(PADDED, ch => ch + (ch === '(' ? ZWSP : WJ));
const isPad = (ch: string | undefined) => ch === ZWSP || ch === WJ;
// An inserted break is a newline FOLLOWED by a word joiner. The marker is what tells it apart from a
// newline the user typed with Shift+Enter: those are content and are never touched or sent anywhere
// stripped, while these are layout, re-computed on every edit and resize and taken back out before
// the query reaches the engine. It trails the newline rather than leading it because a full line
// ends with a space that hangs past the edge, and anything after that space — even something
// zero-width — is pushed onto a line of its own, costing the box a blank row.
const AUTO = /\n⁠/g;
const stripAuto = (s: string) => s.replace(AUTO, '');
const withBreaks = (base: string, at: number[]) => {
  let out = '', prev = 0;
  for (const i of at) { out += base.slice(prev, i) + '\n' + WJ; prev = i; }
  return out + base.slice(prev);
};
/** Caret between the two coordinate systems: the value the textarea holds, and the query itself. */
const caretToBase = (value: string, pos: number) => {
  // Never inside a marker: a caret between the newline and its joiner belongs after both.
  const p = value[pos - 1] === '\n' && value[pos] === WJ ? pos + 1 : pos;
  return p - 2 * (value.slice(0, p).match(AUTO)?.length ?? 0);
};
const caretFromBase = (pos: number, at: number[]) => pos + 2 * at.filter(i => i <= pos).length;

/** Indices in `text` where the mirror wraps it. Filled and measured in place, so several passes can
 *  run inside one layout effect.
 *
 *  Each character gets its own inline box and is located by ITS box, not by a Range: WebKit reports
 *  a character range that touches a line boundary against the wrong line (the character after a
 *  newline comes back on the line above), which put every break one character late on iOS. An inline
 *  box belongs to exactly one line box, and Blink and WebKit agree on which. */
const lineStarts = (mirror: HTMLElement, text: string, breakWord: boolean): number[] => {
  mirror.style.overflowWrap = breakWord ? 'break-word' : 'normal';
  const padded = decorate(text);
  const frag = document.createDocumentFragment();
  const boxes: {el: HTMLElement; at: number}[] = [];
  for (let m = 0, i = 0; m < padded.length;) {
    // Whole code points, so a surrogate pair is never split across two boxes and re-shaped.
    const cp = padded.codePointAt(m) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    const el = document.createElement('span');
    el.textContent = padded.slice(m, m + len);
    frag.appendChild(el);
    // Padding is not part of `text`, and never counts as the start of a line.
    if (!isPad(padded[m])) { boxes.push({el, at: i}); i += len; }
    m += len;
  }
  mirror.textContent = '';
  mirror.appendChild(frag);
  const at: number[] = [];
  let top: number | null = null;
  for (const box of boxes) {
    const t = Math.round(box.el.getBoundingClientRect().top);
    if (top === null) top = t;
    // A line some newline already started needs no break of ours.
    else if (t > top) { top = t; if (box.at > 0 && text[box.at - 1] !== '\n') at.push(box.at); }
  }
  return at;
};

/** Where the query should break, in `base` indices. Two passes, because one is not enough:
 *  - pass 1 forbids breaking inside a word, so the breaks land on column boundaries and spaces —
 *    a token too long for the line just overflows the (invisible) mirror rather than being split,
 *    which is what keeps `&& active_subscriptions()` from leaving `a` stranded on the line above;
 *  - pass 2 re-measures the result WITH mid-word breaking allowed, so a token that genuinely cannot
 *    fit a line is split — but now it is split from the start of its own line. */
const breakPoints = (mirror: HTMLElement, base: string): number[] => {
  const first = lineStarts(mirror, base, false);
  // Stage the pass-1 breaks as plain newlines, keeping a map back to `base` coordinates.
  let staged = '', prev = 0;
  const toBase: number[] = [];
  for (const i of first) {
    for (let k = prev; k < i; k++) toBase.push(k);
    toBase.push(i); // the newline itself maps to where it was inserted
    staged += base.slice(prev, i) + '\n';
    prev = i;
  }
  for (let k = prev; k <= base.length; k++) toBase.push(k);
  staged += base.slice(prev);
  const second = lineStarts(mirror, staged, true).map(i => toBase[i]);
  return [...new Set([...first, ...second])].sort((a, b) => a - b);
};

export interface GridToolbarProps {
  isExcelViewMode: boolean;
  /** While an export runs, filter/sort/reload/reset are locked (they'd corrupt the in-flight file). */
  isExporting?: boolean;
  /** When set (indexing / processing / exporting), loading progress shows inside the search box. */
  statusText?: string;
  /** Numeric progress 0–100 for the loading bar; -1 = indeterminate. */
  progress?: number;
  /** When set, the progress pill shows a Cancel action (abortable worker export only). */
  onCancelExport?: () => void;
  /** True when any column has a custom width — highlights the width-reset segment. */
  hasCustomWidths?: boolean;
  onToggleExcelView: () => void;
  onResetWidths: () => void;
  onShowColumnSelector: () => void;
  onShowHiddenColumnSelector: () => void;
  onDownloadExcel: (scope: 'filtered' | 'all') => void;
  /** Row counts shown under each export-scope option. */
  filteredCount?: number;
  allCount?: number;
  /** Omitted when the grid has no re-fetchable source, which hides the reload button. */
 /** Set when the grid's rowActions allow inserting; the toolbar then ends with a "+ row" button. */
  onInsertRow?: () => void;
  /** Opens the read-only list of every change since load; enabled while there are changes. */
  onShowChanges?: () => void;
  onReloadData?: () => void;
  isReloading?: boolean;
  onReset: () => void;
  onResetSort: () => void;
  hasChanges: boolean;
  hiddenFields: Set<string>;
  sortInfo: { field: string; direction: 'asc' | 'desc' | null } | undefined;
  filterText?: string;
  onFilter?: (text: string) => void;
  /** Searchable-key tree for the search-box autocomplete (sub-keys per scope). */
  searchKeys?: KeyTree;
  /** Localized display name for a suggestion key — shown as `key(label)`; the inserted query keeps
   *  the real key. Returns the key unchanged when no label is configured. */
  labelOf?: (key: string) => string;
  gridTitle?: string;
  isIndexing?: boolean;
}

export const GridToolbarComponent = ({
                                       isExcelViewMode,
                                       isExporting = false,
                                       statusText,
                                       progress = -1,
                                       onCancelExport,
                                       hasCustomWidths = false,
                                       onToggleExcelView,
                                       onResetWidths,
                                       onShowColumnSelector,
                                       onShowHiddenColumnSelector,
                                       onDownloadExcel,
                                       filteredCount,
                                       allCount,
                                       onReloadData,
                                       onInsertRow,
                                       onShowChanges,
                                       isReloading = false,
                                       onReset,
                                       onResetSort,
                                       hasChanges,
                                       hiddenFields,
                                       sortInfo,
                                       filterText = '',
                                       onFilter,
                                       searchKeys = {},
                                       labelOf,
                                       gridTitle,
                                       isIndexing = false,
                                     }: GridToolbarProps) => {
  const [inputValue, setInputValue] = useState(filterText);
  const [isMobile, setIsMobile] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // Track the previous prop value to detect changes during rendering
  const [prevFilterText, setPrevFilterText] = useState(filterText);

  // Sync state synchronously during rendering to avoid cascading renders
  if (filterText !== prevFilterText) {
    setPrevFilterText(filterText);
    setInputValue(filterText);
  }

  // Observe toolbar container width to switch to mobile mode
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setIsMobile(entry.contentRect.width < 720);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  // Close the export scope selector on an outside click (exportMenuRef wraps the icon group
  // and the selector, so clicking the download toggle itself stays inside and just toggles).
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [exportMenuOpen]);

  const filterRef = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Hidden copy of the query, padded, that the line breaks are measured on (see the header).
  const mirrorRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // Last value that fit within the row cap, and the height it had — what an over-long edit reverts to.
  const acceptedRef = useRef('');
  const lastHeightRef = useRef(0);
  // Set when the component rewrites the value itself (a reflow, a suggestion): assigning `.value`
  // parks the caret at the end, so the intended offset has to be put back after the render. Left
  // null for ordinary typing, whose caret must not be touched — re-seating it mid-composition
  // breaks Hangul input.
  const pendingCaretRef = useRef<number | null>(null);
  // Box width: a resize re-flows the breaks, so it belongs in the reflow effect's deps.
  const [boxW, setBoxW] = useState(0);
  // IME composition: the reflow holds off until the composition commits (see the effect).
  const composingRef = useRef(false);
  const [composeTick, setComposeTick] = useState(0);
  // Key autocomplete: suggestions for the field key being typed at a "key position".
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(0);
  // Whether the keyboard is "inside" the dropdown. ↓ enters it, ↑ leaves it. Off while typing, so
  // ← → still move the text caret until you have deliberately stepped into the suggestions.
  const [suggestEntered, setSuggestEntered] = useState(false);
  // Caret + focus, for highlighting the bracket pair adjacent to the caret.
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Screen position for the suggestion dropdown (portalled to <body>), measured after layout.
  // Full positioning style for the suggestion dropdown. Desktop floats it under the box; mobile pins
  // it just above the keyboard (bottom of the visual viewport) so it never gets pushed off-screen.
  const [dropStyle, setDropStyle] = useState<CSSProperties | null>(null);

  // Indices of the bracket pair adjacent to `pos` (checks the char before, then at, the caret).
  const matchingPair = (text: string, pos: number): [number, number] | null => {
    const at = (i: number): [number, number] | null => {
      if (text[i] === '(') {
        let d = 0;
        for (let j = i; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')' && --d === 0) return [i, j]; }
      } else if (text[i] === ')') {
        let d = 0;
        for (let j = i; j >= 0; j--) { if (text[j] === ')') d++; else if (text[j] === '(' && --d === 0) return [j, i]; }
      }
      return null;
    };
    return at(pos - 1) ?? at(pos);
  };

  // The identifier word ending at the caret (may be empty right after `(`/`.`), and whether it sits
  // where a field key is expected (start, or right after `(`, `&`, `|`, `.`). Not a key position →
  // it's a value inside `(...)`.
  const keyContext = (value: string, caret: number, lenient = false): {token: string; start: number} | null => {
    const before = value.slice(0, caret);
    const token = (before.match(/[\w]*$/) ?? [''])[0];
    // The zero-width marker of an inserted break counts as whitespace here — a key typed at the
    // start of a wrapped line still sits "right after `(`".
    const prev = before.slice(0, before.length - token.length).replace(/[\s⁠]+$/, '').slice(-1);
    // After a closed `)` a sibling key can still start, but only the explicit ↓ opens it there
    // (`lenient`) — passive typing stays quiet since there's no operator yet.
    if (prev !== '' && !'(&|.'.includes(prev) && !(lenient && prev === ')')) return null;
    return {token, start: before.length - token.length};
  };

  // Field-scope path enclosing the caret: each `name(` pushes name, each `)` pops.
  const scopePath = (text: string): string[] => {
    const stack: string[] = [];
    let word = '';
    for (const ch of text) {
      if (/[\w]/.test(ch)) { word += ch; continue; }
      if (ch === '(') stack.push(word);
      else if (ch === ')') stack.pop();
      word = '';
    }
    return stack.filter(Boolean);
  };

  // Walk the key tree down the scope path (case-insensitive). null = unknown path → no suggestions.
  const navigate = (tree: KeyTree, path: string[]): KeyTree | null => {
    let node: KeyTree = tree;
    for (const seg of path) {
      const k = Object.keys(node).find(key => key.toLowerCase() === seg.toLowerCase());
      if (k === undefined) return null;
      node = node[k];
    }
    return node;
  };

  const refreshSuggestions = (value: string, caret: number, lenient = false) => {
    const ctx = keyContext(value, caret, lenient);
    // Even off a key position (mid-value), keep && / || available so the dropdown never empties out
    // from under the user while they're still in the box.
    if (!ctx) { setSuggestions(['&&', '||']); setSuggestEntered(false); return; }
    const node = navigate(searchKeys, scopePath(value.slice(0, ctx.start)));
    const tl = ctx.token.toLowerCase();
    // Sub-keys for the scope — none for a flat/leaf field or an unknown path. && / || are always
    // offered at the front so a sibling condition can be chained anywhere (picking one inserts it at
    // the caret, i.e. inside the current parens — see applySuggestion).
    const keys = node ? Object.keys(node).filter(k => k.toLowerCase().includes(tl)).slice(0, 8) : [];
    setSuggestions(['&&', '||', ...keys]);
    setSuggestIndex(0);
    // Every new list starts "outside" it — the caret is back in the text, so ↓ must be pressed to
    // step in again. This is what makes ↓ re-enter the dropdown at each level.
    setSuggestEntered(false);
  };

  // Search runs on Enter (Shift+Enter inserts a newline) — typing just updates the local value.
  const handleFilterChange = (value: string, caret: number) => {
    setInputValue(value);
    refreshSuggestions(value, caret);
  };

  // Apply a suggestion tag. An operator (`&&`/`||`) is inserted with spaces at the caret and the key
  // list re-opens; a field key replaces the token being typed with `key()` (caret inside the parens).
  const applySuggestion = (item: string) => {
    const el = filterRef.current;
    const caret = el?.selectionStart ?? inputValue.length;
    if (item === '&&' || item === '||') {
      // Inserted at the caret, so an operator picked from inside a field's parens stays in that scope:
      // `name(john|)` + && → `name(john && )`. It used to jump out past the closing `)`, which made a
      // condition nested inside a field impossible to build from the dropdown.
      const head = inputValue.slice(0, caret).replace(/\s+$/, '');
      const tail = inputValue.slice(caret).replace(/^\s+/, '');
      // No leading space at the start of a scope (empty box, or right after `(`) — `name( && )` reads wrong.
      const lead = head === '' || head.endsWith('(') ? '' : ' ';
      const next = head + lead + item + ' ' + tail;
      const pos = head.length + lead.length + item.length + 1; // after "<op> "
      setInputValue(next);
      setCaret(pos);
      // The caret goes in through pendingCaretRef so a reflow triggered by the same edit can carry
      // it across the newlines it inserts.
      pendingCaretRef.current = pos;
      requestAnimationFrame(() => el?.focus());
      refreshSuggestions(next, pos, true);
      return;
    }
    const ctx = keyContext(inputValue, caret, true);
    const start = ctx ? ctx.start : caret;
    const next = inputValue.slice(0, start) + item + '(' + ')' + inputValue.slice(caret);
    const pos = start + item.length + 1;
    setInputValue(next);
    setCaret(pos);
    pendingCaretRef.current = pos;
    requestAnimationFrame(() => el?.focus());
    // Immediately offer the inserted field's sub-keys (empty for a leaf → dropdown closes).
    refreshSuggestions(next, pos);
  };

  const handleFilterKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // An inserted break is layout, not content: deleting it alone would just have the reflow put it
    // straight back. Take the neighbouring real character instead, so one keypress makes one visible
    // change; the reflow then decides whether the break is still needed.
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.altKey && !e.metaKey) {
      const el = e.currentTarget, v = el.value;
      const s = el.selectionStart ?? 0;
      const back = e.key === 'Backspace' && v[s - 1] === WJ && v[s - 2] === '\n';
      const fwd = e.key === 'Delete' && v[s] === '\n' && v[s + 1] === WJ;
      if (s === el.selectionEnd && (back || fwd)) {
        e.preventDefault();
        const base = stripAuto(inputValue);
        const at = caretToBase(inputValue, s);
        const cut = back ? at - 1 : at;
        if (cut < 0 || cut >= base.length) return;
        const next = base.slice(0, cut) + base.slice(cut + 1);
        pendingCaretRef.current = cut;
        setCaret(cut);
        handleFilterChange(next, cut);
        return;
      }
    }
    if (suggestions.length > 0) {
      // ↓ step INTO the dropdown (from the text field). Already inside → move to the next item.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!suggestEntered) { setSuggestEntered(true); setSuggestIndex(0); }
        else setSuggestIndex(i => (i + 1) % suggestions.length);
        return;
      }
      // ↑ step back OUT to the text field; press it again (now outside) to close the dropdown.
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (suggestEntered) setSuggestEntered(false);
        else setSuggestions([]);
        return;
      }
      if (suggestEntered) {
        // ← → move the selection — only while inside, so the text caret still works when outside.
        if (e.key === 'ArrowRight') { e.preventDefault(); setSuggestIndex(i => (i + 1) % suggestions.length); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); setSuggestIndex(i => (i - 1 + suggestions.length) % suggestions.length); return; }
        // Enter applies the highlighted field. The inserted field's sub-keys become the new list,
        // which starts outside again — so ↓ re-enters it.
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applySuggestion(suggestions[suggestIndex]); return; }
      }
      if (e.key === 'Escape') { e.preventDefault(); setSuggestions([]); setSuggestEntered(false); return; }
    } else if (e.key === 'ArrowDown') {
      // Dropdown was dismissed (↑-out or Esc): ↓ re-opens the key suggestions at the current
      // caret and steps straight into them. No-op if the caret isn't at a key position.
      e.preventDefault();
      const el = filterRef.current;
      const caret = el?.selectionStart ?? inputValue.length;
      refreshSuggestions(inputValue, caret, true);
      setSuggestEntered(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onFilter?.(stripAuto(inputValue));
    }
  };

  // Colour each parenthesis by its nesting depth (rainbow brackets) for the overlay behind the
  // transparent textarea. Non-bracket text keeps the normal colour.
  const BRACKET_COLORS = ['#e11d48', '#d97706', '#059669', '#2563eb', '#7c3aed'];
  const renderHighlighted = (text: string, matchSet: Set<number>): ReactElement[] => {
    const parts: ReactElement[] = [];
    let depth = 0;
    let buf = '';
    const flush = () => { if (buf) { parts.push(<span key={parts.length}>{buf}</span>); buf = ''; } };
    const bracket = (ch: string, i: number, d: number) => {
      const matched = matchSet.has(i);
      parts.push(
        <span key={parts.length} style={{
          color: BRACKET_COLORS[d % BRACKET_COLORS.length],
          ...(matched ? {backgroundColor: '#fde68a', fontWeight: 700, borderRadius: '2px'} : {}),
        }}>{ch}</span>,
      );
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') { flush(); bracket(ch, i, depth); depth++; }
      else if (ch === ')') { flush(); depth = Math.max(0, depth - 1); bracket(ch, i, depth); }
      else buf += ch;
    }
    flush();
    return parts;
  };

  // Auto-grow the search textarea to fit its content (single row when empty), up to a row cap.
  // The toolbar grows with it, so a multi-line query pushes the grid down rather than covering it.
  useLayoutEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    // Row metrics derived rather than hard-coded, so they track the CSS.
    const line = parseFloat(cs.lineHeight) || 16;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Same row cap on mobile as on web: the box grows the toolbar rather than floating over the grid,
    // so a long query pushes the table down instead of burying it.
    const maxHeight = line * MAX_FILTER_ROWS + padY;
    el.style.height = 'auto';
    // Hard cap: rather than scrolling the overflow out of sight, reject the edit that crossed the
    // limit and put the previous text back. Measuring is the only way to count WRAPPED rows, so the
    // check has to run after the value is applied — the revert lands in the same frame.
    if (el.scrollHeight > maxHeight) {
      const prev = acceptedRef.current;
      const pos = Math.max(0, Math.min((el.selectionStart ?? prev.length) - (inputValue.length - prev.length), prev.length));
      el.style.height = `${lastHeightRef.current}px`;
      setInputValue(prev);
      pendingCaretRef.current = null;
      requestAnimationFrame(() => el.setSelectionRange(pos, pos));
      return;
    }
    // Only set when the component rewrote the value; ordinary typing keeps the caret the browser gave it.
    if (pendingCaretRef.current != null) {
      el.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current);
      pendingCaretRef.current = null;
    }
    acceptedRef.current = inputValue;
    const grown = el.scrollHeight;
    el.style.height = `${grown}px`;
    lastHeightRef.current = grown;
  }, [inputValue, isMobile]);

  // Turn the mirror's wrap points into real newlines (see the header). Runs after the auto-grow
  // effect, so the value it commits is the one the next pass measures the height on.
  useLayoutEffect(() => {
    const mirror = mirrorRef.current, el = filterRef.current;
    // Rewriting the value mid-composition kills Hangul input, so a reflow waits for the IME to
    // commit — compositionend re-runs this effect.
    if (!mirror || !el || composingRef.current) return;
    const base = stripAuto(inputValue);
    const at = breakPoints(mirror, base);
    const next = withBreaks(base, at);
    if (next === inputValue) return;
    // A caret already waiting to be applied belongs to this value, so it is what gets carried over.
    const from = pendingCaretRef.current ?? el.selectionStart ?? inputValue.length;
    pendingCaretRef.current = caretFromBase(caretToBase(inputValue, from), at);
    setInputValue(next);
  }, [inputValue, isMobile, boxW, composeTick]);

  // The break positions depend on the box width, so a resize has to re-run the reflow above.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Position the suggestion dropdown under the textarea (measured after layout, so no ref reads
  // during render — the portal uses this state).
  useLayoutEffect(() => {
    if (suggestions.length === 0) return;
    // Desktop only: the dropdown is portalled and floats under the box, so it needs measured
    // coordinates. On mobile it renders inline (grouped with the box in the flow), so there's nothing
    // to measure — and measuring against a keyboard-resized viewport is exactly what made it drift.
    if (isMobile) return;
    const place = () => {
      const box = boxRef.current;
      if (!box) return;
      // Drop straight down from the search box at its exact width, so the input and the suggestion
      // list read as one connected control — same on web and mobile (the box sits at the top of the
      // toolbar, clear of the keyboard). Portalled to <body> to escape the grid's overflow/stacking.
      const r = box.getBoundingClientRect();
      // position:fixed escapes the grid's overflow, but it also escapes the host page's clipping and
      // stacking: scrolling the search box under the host's sticky chrome (a nav bar, a heading) left
      // the list sliding OVER it. So hit-test the box's own bottom edge — if the topmost element there
      // isn't part of the box, something is covering the anchor and the list must hide with it.
      const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 2);
      const covered = r.bottom < 0 || r.top > window.innerHeight || !(hit && box.contains(hit));
      setDropStyle({position: 'fixed', top: r.bottom, left: r.left, width: r.width, zIndex: 1000, visibility: covered ? 'hidden' : 'visible'});
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [suggestions, isMobile]);


  // The dropdown stays up while the user works the search box; it closes only when a pointer press
  // lands outside both the box and the dropdown itself. (Blur alone no longer closes it.)
  useEffect(() => {
    if (suggestions.length === 0) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      return !(boxRef.current?.contains(t) || dropRef.current?.contains(t));
    };
    const dismiss = () => {
      setSuggestions([]);
      setSuggestEntered(false);
    };
    const onDown = (e: PointerEvent) => {
      // Touch is handled on click instead: a scroll gesture also starts with a pointerdown outside the
      // box, so dismissing here made the list vanish the moment the user dragged the page. A drag never
      // produces a click, so click fires for real taps only.
      if (e.pointerType === 'touch') return;
      if (outside(e)) dismiss();
    };
    const onClick = (e: MouseEvent) => {
      if (outside(e)) dismiss();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [suggestions]);

  const handleFilterClear = () => {
    setInputValue('');
    setSuggestions([]);
    onFilter?.('');
  };

  const createButton = (text: string, extraClasses: string, onClick: () => void) => (
      <button
          className={`px-3 py-1.5 text-xs font-semibold ${extraClasses}`}
          onClick={onClick}
      >
        {text}
      </button>
  );

  const createMenuButton = (text: string, extraClasses: string, onClick: () => void) => (
      <button
          className={`w-full text-left px-4 py-2 text-xs font-semibold whitespace-nowrap ${extraClasses}`}
          onClick={() => {
            onClick();
            setMenuOpen(false);
          }}
      >
        {text}
      </button>
  );

  // One segment of the toolbar's icon group (all segments share one outlined, connected container).
  // icon (w-5 h-5, currentColor) + caption below; supports active / disabled / spinning states.
  const segmentButton = (
      Icon: (props: { className?: string }) => ReactElement,
      label: string,
      title: string,
      onClick: () => void,
      opts?: { active?: boolean; disabled?: boolean; spinning?: boolean },
  ) => (
      <button
          className={`flex flex-col items-center justify-center gap-0.5 px-2.5 py-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${opts?.active ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50 hover:text-indigo-600'}`}
          onClick={onClick}
          disabled={opts?.disabled}
          title={title}
          aria-label={title}
      >
        <Icon className={`w-5 h-5${opts?.spinning ? ' animate-spin' : ''}`}/>
        <span
            className='text-center text-[8px] font-semibold leading-none tracking-tight'>{label}</span>
      </button>
  );

  // Excel View Toggle Button
  const excelBtnText = isExcelViewMode ? I18n.t('toolbar.showGrid') : I18n.t('toolbar.showExcelPreview');

  // Download Excel Button
  const downloadExcelBtnText = I18n.t('toolbar.downloadExcel');

  // Reset Widths Button
  const resetWidthBtnText = I18n.t('toolbar.resetWidths');
  const reloadBtnText = isReloading ? I18n.t('toolbar.reloadingData') : I18n.t('toolbar.reloadData');

  // Select Columns Button (show/hide any column)
  const selectColsBtnText = I18n.t('toolbar.selectColumns');

  // Hidden Columns Management Button
  const hiddenColsBtnText = hiddenFields.size > 0
      ? I18n.t('grid.hiddenColumns').replace('{count}', String(hiddenFields.size))
      : null;

  // Reset All Changes Button
  const resetBtnText = hasChanges ? I18n.t('toolbar.resetAll') : null;

  // Reset Sort Button
  const resetSortBtnText = (sortInfo && sortInfo.direction) ? I18n.t('toolbar.resetSort') : null;

  // The search box is always the same box; while indexing / processing / exporting it shows loading
  // progress INSIDE it (a fill bar + spinner + text + cancel) instead of the input.
  // Render as soon as filtering is configured — not gated on wasmReady. A virtual grid now paints
  // its rows before the engine finishes indexing (getRowsInRange bridges from JS), so gating the box
  // on wasmReady made it pop in a beat after the rows. Typing before the engine is ready is safe:
  // setFilter stores the text and applyWasmFilter re-runs once the engine can serve it.
  const filterInput = (statusText || onFilter) ? (
      <div className='relative flex-1 min-w-0 max-w-2xl'>
        {/* A grown box pushes the toolbar taller rather than floating over the grid. It used to
            lift out of the flow so a multi-line query wouldn't reflow anything, but the toolbar
            is the top of the grid's frame now — an overlay reads as the search box falling into
            the table instead of the frame growing to hold it. */}
        <div ref={boxRef}
             className={`relative overflow-hidden border border-slate-200 bg-white focus-within:border-indigo-400 ${!statusText && suggestions.length > 0 ? 'rounded-t rounded-b-none' : 'rounded'}`}>
          {statusText ? (
            <div className='relative flex items-center gap-2 px-2 py-1.5 text-xs'>
              {progress >= 0
                ? <div aria-hidden className='absolute inset-y-0 left-0 bg-indigo-100 transition-[width] duration-200' style={{width: `${progress}%`}}/>
                : <div aria-hidden className='absolute inset-0 bg-indigo-50 animate-pulse'/>}
              <div className='relative w-3.5 h-3.5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin shrink-0'/>
              <span className='relative truncate text-slate-600'>{statusText}</span>
              {onCancelExport && (
                <button type='button' onClick={onCancelExport}
                        className='relative ml-auto shrink-0 text-[11px] font-medium text-slate-400 hover:text-red-500'>
                  {I18n.t('popup.cancel')}
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Hidden, padded copy of the query: the only thing it exists for is that its own line
                  breaking picks the points the real text then gets `\n`s at. Same width and metrics
                  as the overlay; its text is written imperatively so the reflow can measure more than
                  one candidate layout within a single pass. */}
              <div ref={mirrorRef} aria-hidden
                   className={`invisible absolute left-0 top-0 w-full pl-7 py-1.5 ${isMobile ? 'text-base pr-9' : 'text-xs pr-7'} leading-snug whitespace-pre-wrap break-keep pointer-events-none`}/>
              {/* Colour overlay behind the transparent textarea — same metrics so text lines up. */}
              <div aria-hidden
                   className={`absolute inset-0 pl-7 py-1.5 ${isMobile ? 'text-base pr-9' : 'text-xs pr-7'} leading-snug whitespace-pre-wrap break-words break-keep text-slate-700 overflow-hidden pointer-events-none`}>
                {renderHighlighted(inputValue, new Set(focused ? (matchingPair(inputValue, caret) ?? []) : []))}{'\n'}
              </div>
              <textarea
                  ref={filterRef}
                  rows={1}
                  value={inputValue}
                  onChange={e => handleFilterChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                  onKeyDown={handleFilterKeyDown}
                  onCompositionStart={() => { composingRef.current = true; }}
                  onCompositionEnd={() => { composingRef.current = false; setComposeTick(t => t + 1); }}
                  onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onFocus={e => {
                    setFocused(true);
                    setCaret(e.target.selectionStart ?? 0);
                    refreshSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  }}
                  // Losing focus no longer closes the list — it stays until a pointerdown lands
                  // outside the box + dropdown (see the effect above), so moving the caret or the
                  // pointer within the search control keeps it open.
                  onBlur={() => setFocused(false)}
                  placeholder={I18n.t('toolbar.filterPlaceholder')}
                  // 16px on mobile (text-base) stops iOS from auto-zooming the page on focus; the
                  // overlay above matches so the highlighted text stays aligned.
                  className={`relative block w-full pl-7 py-1.5 ${isMobile ? 'text-base pr-9' : 'text-xs pr-7'} leading-snug break-words break-keep bg-transparent text-transparent caret-slate-700 placeholder:text-slate-400 resize-none overflow-hidden focus:outline-none`}
              />
              <SearchIcon className='absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none'/>
              {inputValue && (
                  <button
                      type='button'
                      aria-label={I18n.t('toolbar.clearSearch')}
                      className={`absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors leading-none ${isMobile ? 'w-7 h-7 text-lg' : 'w-5 h-5 text-sm'}`}
                      onClick={handleFilterClear}
                  >✕</button>
              )}
            </>
          )}
        </div>
        {/* Desktop: portalled to <body> (position:fixed) to escape the grid's overflow/stacking,
            placed flush under the box at its exact width so the two read as one control. Mobile:
            rendered INLINE right under the box (same flow), so the keyboard can't drift the two apart
            — they grow the toolbar together as one grouped control. */}
        {!statusText && suggestions.length > 0 && (() => {
          const list = (
            <div
                ref={dropRef}
                style={isMobile ? undefined : (dropStyle ?? undefined)}
                className={`flex flex-wrap gap-1 rounded-b border border-t-0 border-slate-200 bg-white p-2 ${isMobile ? '' : 'shadow-lg'}`}>
              {suggestions.map((k, i) => {
                const isOp = k === '&&' || k === '||';
                const selected = suggestEntered && i === suggestIndex;
                // Operators read as connectors, not fields — set apart by chip colour only.
                const tone = selected
                  ? 'bg-indigo-100 text-indigo-700'
                  : isOp
                    ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200';
                const label = isOp ? null : labelOf?.(k);
                return (
                  <button
                      key={k}
                      type='button'
                      // onMouseDown (not onClick): fires before the textarea's blur, so focus/caret stay put.
                      onMouseDown={e => { e.preventDefault(); applySuggestion(k); }}
                      className={`shrink-0 rounded font-medium ${tone} ${isMobile ? 'px-3 py-1.5 text-xs' : 'px-2 py-0.5 text-[11px]'}`}
                  >{k}{label && label !== k ? <span className='ml-1 opacity-60'>({label})</span> : null}</button>
                );
              })}
              {/* Arrow-key hint only applies on desktop (touch just taps a chip); it also forces a wrap
                  that would break the mobile single-row strip. */}
              {!isMobile && (
                <div className='basis-full mt-0.5 px-1 text-[10px] text-slate-400 select-none'>{I18n.t('toolbar.suggestNav')}</div>
              )}
            </div>
          );
          if (isMobile) return list;
          return dropStyle ? createPortal(list, document.body) : null;
        })()}
      </div>
  ) : null;

  // Grid-editing icons don't apply in Excel preview mode or while indexing (data not ready yet) —
  // disable them, but keep the toolbar itself visible so it doesn't collapse during the skeleton.
  const gridActionsDisabled = isExcelViewMode || isIndexing;

  // All toolbar actions as one outlined, connected segmented group. Preview is highlighted when
  // active; the download/export segment is always shown (disabled while an export is running).
  const iconGroup = (
      <div
          className='inline-flex items-stretch overflow-hidden rounded-md border border-slate-200 divide-x divide-slate-200'>
        {onReloadData && segmentButton(ReloadIcon, 'reload', reloadBtnText, onReloadData, {
          disabled: isReloading || gridActionsDisabled || isExporting,
          spinning: isReloading
        })}
        {segmentButton(ColumnWidthIcon, 'reset', resetWidthBtnText, () => {
          if (hasCustomWidths) onResetWidths();
        }, {active: hasCustomWidths, disabled: gridActionsDisabled || isExporting})}
        {segmentButton(SortResetIcon, 'reset', I18n.t('toolbar.resetSort'), () => {
          if (sortInfo?.direction) onResetSort();
        }, {active: !!(sortInfo && sortInfo.direction), disabled: gridActionsDisabled || isExporting})}
        {segmentButton(ColumnsIcon, 'columns', selectColsBtnText, onShowColumnSelector, {disabled: gridActionsDisabled || isExporting})}
        {segmentButton(ExcelIcon, 'preview', excelBtnText, onToggleExcelView, {
          active: isExcelViewMode,
          disabled: isIndexing,
        })}
        {/* No active filter (filtered == all) → nothing to choose, download straight away. */}
        {segmentButton(DownloadIcon, 'export', downloadExcelBtnText,
          () => { if (filteredCount === allCount) onDownloadExcel('all'); else setExportMenuOpen(prev => !prev); },
          {active: exportMenuOpen, disabled: isExporting || isIndexing})}
        {onInsertRow && segmentButton(InsertRowIcon, 'row', I18n.t('grid.insertRow'), onInsertRow, {
          disabled: gridActionsDisabled || isExporting,
        })}
        {onShowChanges && segmentButton(ChangesIcon, 'changes', I18n.t('toolbar.changes'), onShowChanges, {
          disabled: !hasChanges || gridActionsDisabled || isExporting,
        })}
      </div>
  );

  // Icon group + the export scope selector (revealed by the download segment). One wrapper ref
  // covers both, so the outside-click handler treats a click on the toggle as "inside".
  // A zero-row scope has nothing to write — offer it greyed out rather than producing an empty file.
  const scopeButton = (label: string, scope: 'filtered' | 'all', count?: number) => (
      <button
          type='button'
          disabled={count === 0}
          className='flex flex-col items-center justify-center gap-0.5 px-3 py-1 text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent'
          onClick={() => { onDownloadExcel(scope); setExportMenuOpen(false); }}
      >
        <span className='text-[11px] font-semibold leading-none'>{label}</span>
        {count != null && (
            <span className='text-[9px] font-medium leading-none text-indigo-400'>({count.toLocaleString()})</span>
        )}
      </button>
  );
  const iconGroupWithExport = (
      <div className='inline-flex items-stretch gap-2' ref={exportMenuRef}>
        {iconGroup}
        {exportMenuOpen && (
            <div className='inline-flex items-stretch self-center overflow-hidden rounded-md border border-indigo-200 divide-x divide-indigo-200'>
              {scopeButton(I18n.t('toolbar.exportFiltered'), 'filtered', filteredCount)}
              {scopeButton(I18n.t('toolbar.exportAll'), 'all', allCount)}
            </div>
        )}
      </div>
  );

  if (isMobile) {
    return (
        <div className='everygrid-toolbar' ref={toolbarRef}>
          {filterInput}
          {/* self-start keeps the menu button pinned to the top — i.e. beside the search BOX — so it
              doesn't drift to the vertical centre when the inline suggestions grow the input group. */}
          <div className='relative ml-auto self-start' ref={menuRef}>
            <button
                className='flex items-center justify-center p-2 text-slate-700 rounded hover:bg-slate-100'
                onClick={() => setMenuOpen(prev => !prev)}
                aria-label={I18n.t('toolbar.moreActions')}
            >
              <svg width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor'
                   strokeWidth='2.5'>
                <line x1='3' y1='6' x2='21' y2='6'/>
                <line x1='3' y1='12' x2='21' y2='12'/>
                <line x1='3' y1='18' x2='21' y2='18'/>
              </svg>
            </button>
            {menuOpen && (
                <div className='everygrid-mobile-menu'>
                  {onReloadData && createMenuButton(reloadBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onReloadData)}
                  {filteredCount !== allCount && (filteredCount ?? 0) > 0 && createMenuButton(`${downloadExcelBtnText} · ${I18n.t('toolbar.exportFiltered')}`, 'bg-white text-slate-700 hover:bg-slate-50', () => onDownloadExcel('filtered'))}
                  {(allCount ?? 0) > 0 && createMenuButton(`${downloadExcelBtnText} · ${I18n.t('toolbar.exportAll')}`, 'bg-white text-slate-700 hover:bg-slate-50', () => onDownloadExcel('all'))}
                  {hiddenColsBtnText && createMenuButton(hiddenColsBtnText, 'text-red-600 hover:bg-red-50', onShowHiddenColumnSelector)}
                  {resetBtnText && createMenuButton(resetBtnText, 'text-orange-700 hover:bg-orange-50', onReset)}
                  {resetSortBtnText && createMenuButton(resetSortBtnText, 'text-indigo-700 hover:bg-indigo-50', onResetSort)}
                </div>
            )}
          </div>
          {/*{gridTitle && (*/}
          {/*  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{gridTitle}</span>*/}
          {/*)}*/}
        </div>
    );
  }

  return (
      <div className='everygrid-toolbar' ref={toolbarRef}>
        {filterInput}
        {iconGroupWithExport}
        {hiddenColsBtnText && createButton(hiddenColsBtnText, 'bg-red-50 text-red-600 border border-red-100 rounded hover:bg-red-100 transition-colors', onShowHiddenColumnSelector)}
        {resetBtnText && createButton(resetBtnText, 'bg-orange-100 text-orange-700', onReset)}
        {gridTitle && (
            <span className='ml-auto text-[11px] font-bold text-slate-500 uppercase tracking-wider'>
              {gridTitle}
            </span>
        )}
      </div>
  );
};
