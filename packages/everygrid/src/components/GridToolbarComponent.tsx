import {I18n} from '../i18n/I18n';
import type {KeyboardEvent, ReactElement} from 'react';
import type {KeyTree} from '../core/types';
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ReloadIcon} from '../icons/ReloadIcon';
import {ColumnWidthIcon} from '../icons/ColumnWidthIcon';
import {ColumnsIcon} from '../icons/ColumnsIcon';
import {ExcelIcon} from '../icons/ExcelIcon';
import {DownloadIcon} from '../icons/DownloadIcon';
import {SortResetIcon} from '../icons/SortResetIcon';

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
  wasmReady?: boolean;
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
                                       isReloading = false,
                                       onReset,
                                       onResetSort,
                                       hasChanges,
                                       hiddenFields,
                                       sortInfo,
                                       filterText = '',
                                       onFilter,
                                       searchKeys = {},
                                       wasmReady = false,
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
  // Key autocomplete: suggestions for the field key being typed at a "key position".
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestIndex, setSuggestIndex] = useState(0);
  // Caret + focus, for highlighting the bracket pair adjacent to the caret.
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // Screen position for the suggestion dropdown (portalled to <body>), measured after layout.
  const [dropRect, setDropRect] = useState<{top: number; left: number; width: number} | null>(null);

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
  const keyContext = (value: string, caret: number): {token: string; start: number} | null => {
    const before = value.slice(0, caret);
    const token = (before.match(/[\w]*$/) ?? [''])[0];
    const prev = before.slice(0, before.length - token.length).replace(/\s+$/, '').slice(-1);
    if (prev !== '' && !'(&|.'.includes(prev)) return null;
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

  const refreshSuggestions = (value: string, caret: number) => {
    const ctx = keyContext(value, caret);
    if (!ctx) { setSuggestions([]); return; }
    const node = navigate(searchKeys, scopePath(value.slice(0, ctx.start)));
    // A leaf field (no sub-keys) means we're at a value position → no suggestions.
    if (!node || Object.keys(node).length === 0) { setSuggestions([]); return; }
    const tl = ctx.token.toLowerCase();
    setSuggestions(Object.keys(node).filter(k => k.toLowerCase().includes(tl)).slice(0, 8));
    setSuggestIndex(0);
  };

  // Search runs on Enter (Shift+Enter inserts a newline) — typing just updates the local value.
  const handleFilterChange = (value: string, caret: number) => {
    setInputValue(value);
    refreshSuggestions(value, caret);
  };

  // Replace the token being typed with `key(` (caret placed inside the parens).
  const applySuggestion = (key: string) => {
    const el = filterRef.current;
    const caret = el?.selectionStart ?? inputValue.length;
    const ctx = keyContext(inputValue, caret);
    const start = ctx ? ctx.start : caret;
    const next = inputValue.slice(0, start) + key + '(' + ')' + inputValue.slice(caret);
    const pos = start + key.length + 1;
    setInputValue(next);
    setCaret(pos);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(pos, pos); });
    // Immediately offer the inserted field's sub-keys (empty for a leaf → dropdown closes).
    refreshSuggestions(next, pos);
  };

  const handleFilterKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestIndex(i => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestIndex(i => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applySuggestion(suggestions[suggestIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSuggestions([]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onFilter?.(inputValue);
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

  // Auto-grow the search textarea to fit its content (single row when empty).
  useLayoutEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [inputValue]);

  // Position the suggestion dropdown under the textarea (measured after layout, so no ref reads
  // during render — the portal uses this state).
  useLayoutEffect(() => {
    if (suggestions.length === 0 || !filterRef.current) return;
    const r = filterRef.current.getBoundingClientRect();
    setDropRect({top: r.bottom + 4, left: r.left, width: r.width});
    // Fixed positioning doesn't follow the page, so instead of chasing it, just dismiss on any
    // scroll (capture: true, to catch scrolling containers too) or resize. Typing brings it back.
    const dismiss = () => setSuggestions([]);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
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
            className="text-center text-[8px] font-semibold leading-none tracking-tight">{label}</span>
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
  const filterInput = (statusText || (wasmReady && onFilter)) ? (
      <div className="relative flex-1 min-w-0 max-w-2xl">
        <div className="relative overflow-hidden rounded border border-slate-200 bg-white focus-within:border-indigo-400">
          {statusText ? (
            <div className="relative flex items-center gap-2 px-2 py-1.5 text-xs">
              {progress >= 0
                ? <div aria-hidden className="absolute inset-y-0 left-0 bg-indigo-100 transition-[width] duration-200" style={{width: `${progress}%`}}/>
                : <div aria-hidden className="absolute inset-0 bg-indigo-50 animate-pulse"/>}
              <div className="relative w-3.5 h-3.5 border-2 border-slate-300 border-t-indigo-500 rounded-full animate-spin shrink-0"/>
              <span className="relative truncate text-slate-600">{statusText}</span>
              {onCancelExport && (
                <button type="button" onClick={onCancelExport}
                        className="relative ml-auto shrink-0 text-[11px] font-medium text-slate-400 hover:text-red-500">
                  {I18n.t('popup.cancel')}
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Colour overlay behind the transparent textarea — same metrics so text lines up. */}
              <div aria-hidden
                   className="absolute inset-0 pl-7 pr-6 py-1.5 text-xs leading-snug whitespace-pre-wrap break-words text-slate-700 overflow-hidden pointer-events-none">
                {renderHighlighted(inputValue, new Set(focused ? (matchingPair(inputValue, caret) ?? []) : []))}{'\n'}
              </div>
              <textarea
                  ref={filterRef}
                  rows={1}
                  value={inputValue}
                  onChange={e => handleFilterChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                  onKeyDown={handleFilterKeyDown}
                  onSelect={e => setCaret(e.currentTarget.selectionStart ?? 0)}
                  onFocus={e => { setFocused(true); setCaret(e.target.selectionStart ?? 0); refreshSuggestions(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
                  onBlur={() => { setFocused(false); setTimeout(() => setSuggestions([]), 120); }}
                  placeholder={I18n.t('toolbar.filterPlaceholder')}
                  className="relative block w-full pl-7 pr-6 py-1.5 text-xs leading-snug bg-transparent text-transparent caret-slate-700 placeholder:text-slate-400 resize-none overflow-hidden focus:outline-none"
              />
              <svg className="absolute left-2 top-2 text-slate-400 pointer-events-none" width="12" height="12"
                   viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              {inputValue && (
                  <button
                      className="absolute right-1.5 top-1.5 text-slate-400 hover:text-slate-600 text-xs"
                      onClick={handleFilterClear}
                  >✕</button>
              )}
            </>
          )}
        </div>
        {/* Portal to <body> with position:fixed so the dropdown floats above the grids instead of
            being trapped behind them by an ancestor's stacking context / overflow. */}
        {!statusText && suggestions.length > 0 && dropRect && createPortal(
          <div
              style={{position: 'fixed', top: dropRect.top, left: dropRect.left, minWidth: dropRect.width, zIndex: 1000}}
              className="flex flex-wrap gap-1 rounded-md border border-slate-200 bg-white p-1.5 shadow-lg max-w-[90vw]">
            {suggestions.map((k, i) => (
              <button
                  key={k}
                  type="button"
                  // onMouseDown (not onClick): fires before the textarea's blur, so focus/caret stay put.
                  onMouseDown={e => { e.preventDefault(); applySuggestion(k); }}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium ${i === suggestIndex ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
              >{k}</button>
            ))}
          </div>,
          document.body,
        )}
      </div>
  ) : null;

  // Grid-editing icons don't apply in Excel preview mode or while indexing (data not ready yet) —
  // disable them, but keep the toolbar itself visible so it doesn't collapse during the skeleton.
  const gridActionsDisabled = isExcelViewMode || isIndexing;

  // All toolbar actions as one outlined, connected segmented group. Preview is highlighted when
  // active; the download/export segment is always shown (disabled while an export is running).
  const iconGroup = (
      <div
          className="inline-flex items-stretch overflow-hidden rounded-md border border-slate-200 divide-x divide-slate-200">
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
      </div>
  );

  // Icon group + the export scope selector (revealed by the download segment). One wrapper ref
  // covers both, so the outside-click handler treats a click on the toggle as "inside".
  const scopeButton = (label: string, scope: 'filtered' | 'all', count?: number) => (
      <button
          type="button"
          className="flex flex-col items-center justify-center gap-0.5 px-3 py-1 text-indigo-700 hover:bg-indigo-50"
          onClick={() => { onDownloadExcel(scope); setExportMenuOpen(false); }}
      >
        <span className="text-[11px] font-semibold leading-none">{label}</span>
        {count != null && (
            <span className="text-[9px] font-medium leading-none text-indigo-400">({count.toLocaleString()})</span>
        )}
      </button>
  );
  const iconGroupWithExport = (
      <div className="inline-flex items-stretch gap-2" ref={exportMenuRef}>
        {iconGroup}
        {exportMenuOpen && (
            <div className="inline-flex items-stretch self-center overflow-hidden rounded-md border border-indigo-200 divide-x divide-indigo-200">
              {scopeButton(I18n.t('toolbar.exportFiltered'), 'filtered', filteredCount)}
              {scopeButton(I18n.t('toolbar.exportAll'), 'all', allCount)}
            </div>
        )}
      </div>
  );

  if (isMobile) {
    return (
        <div className="everygrid-toolbar" ref={toolbarRef}>
          {filterInput}
          <div className="relative ml-auto" ref={menuRef}>
            <button
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-semibold text-slate-700 rounded"
                onClick={() => setMenuOpen(prev => !prev)}
                aria-label={I18n.t('toolbar.moreActions')}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.5">
                <line x1="3" y1="6" x2="21" y2="6"/>
                <line x1="3" y1="12" x2="21" y2="12"/>
                <line x1="3" y1="18" x2="21" y2="18"/>
              </svg>
            </button>
            {menuOpen && (
                <div className="everygrid-mobile-menu">
                  {onReloadData && createMenuButton(reloadBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onReloadData)}
                  {createMenuButton(`${downloadExcelBtnText} · ${I18n.t('toolbar.exportFiltered')}`, 'bg-white text-slate-700 hover:bg-slate-50', () => onDownloadExcel('filtered'))}
                  {createMenuButton(`${downloadExcelBtnText} · ${I18n.t('toolbar.exportAll')}`, 'bg-white text-slate-700 hover:bg-slate-50', () => onDownloadExcel('all'))}
                  {createMenuButton(resetWidthBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onResetWidths)}
                  {createMenuButton(selectColsBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onShowColumnSelector)}
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
      <div className="everygrid-toolbar" ref={toolbarRef}>
        {filterInput}
        {iconGroupWithExport}
        {hiddenColsBtnText && createButton(hiddenColsBtnText, 'bg-red-50 text-red-600 border border-red-100 rounded hover:bg-red-100 transition-colors', onShowHiddenColumnSelector)}
        {resetBtnText && createButton(resetBtnText, 'bg-orange-100 text-orange-700', onReset)}
        {gridTitle && (
            <span className="ml-auto text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              {gridTitle}
            </span>
        )}
      </div>
  );
};
