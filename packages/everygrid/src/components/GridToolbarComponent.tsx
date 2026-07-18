import {I18n} from '../i18n/I18n';
import {useEffect, useRef, useState} from 'react';
import type {KeyboardEvent, ReactElement} from 'react';
import {ReloadIcon} from '../icons/ReloadIcon';
import {ColumnWidthIcon} from '../icons/ColumnWidthIcon';
import {ColumnsIcon} from '../icons/ColumnsIcon';
import {ExcelIcon} from '../icons/ExcelIcon';
import {DownloadIcon} from '../icons/DownloadIcon';
import {SortResetIcon} from '../icons/SortResetIcon';
import {ProgressBadge} from './ProgressBadge';

export interface GridToolbarProps {
  isExcelViewMode: boolean;
  /** While an export runs, filter/sort/reload/reset are locked (they'd corrupt the in-flight file). */
  isExporting?: boolean;
  /** When set (indexing / processing / exporting), a progress pill replaces the search box. */
  statusText?: string;
  /** True when any column has a custom width — highlights the width-reset segment. */
  hasCustomWidths?: boolean;
  onToggleExcelView: () => void;
  onResetWidths: () => void;
  onShowColumnSelector: () => void;
  onShowHiddenColumnSelector: () => void;
  onDownloadExcel: () => void;
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
  wasmReady?: boolean;
  gridTitle?: string;
  isIndexing?: boolean;
}

export const GridToolbarComponent = ({
                                       isExcelViewMode,
                                       isExporting = false,
                                       statusText,
                                       hasCustomWidths = false,
                                       onToggleExcelView,
                                       onResetWidths,
                                       onShowColumnSelector,
                                       onShowHiddenColumnSelector,
                                       onDownloadExcel,
                                       onReloadData,
                                       isReloading = false,
                                       onReset,
                                       onResetSort,
                                       hasChanges,
                                       hiddenFields,
                                       sortInfo,
                                       filterText = '',
                                       onFilter,
                                       wasmReady = false,
                                       gridTitle,
                                       isIndexing = false,
                                     }: GridToolbarProps) => {
  const [inputValue, setInputValue] = useState(filterText);
  const [isMobile, setIsMobile] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Search runs only on Enter — typing just updates the local input value.
  const handleFilterChange = (value: string) => {
    setInputValue(value);
  };

  const handleFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onFilter?.(inputValue);
    }
  };

  const handleFilterClear = () => {
    setInputValue('');
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
      onClick={() => { onClick(); setMenuOpen(false); }}
    >
      {text}
    </button>
  );

  // One segment of the toolbar's icon group (all segments share one outlined, connected container).
  // icon (w-5 h-5, currentColor) + caption below; supports active / disabled / spinning states.
  const segmentButton = (
    Icon: (props: {className?: string}) => ReactElement,
    label: string,
    title: string,
    onClick: () => void,
    opts?: {active?: boolean; disabled?: boolean; spinning?: boolean},
  ) => (
    <button
      className={`flex flex-col items-center justify-center gap-0.5 px-2.5 py-0.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${opts?.active ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50 hover:text-indigo-600'}`}
      onClick={onClick}
      disabled={opts?.disabled}
      title={title}
      aria-label={title}
    >
      <Icon className={`w-5 h-5${opts?.spinning ? ' animate-spin' : ''}`} />
      <span className="text-center text-[8px] font-semibold leading-none tracking-tight">{label}</span>
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

  // While indexing / processing / exporting, a progress pill takes the search box's place.
  // Otherwise the search box (filtering locked during export).
  const filterInput = statusText ? (
    <ProgressBadge text={statusText} />
  ) : (wasmReady && onFilter) ? (
    <div className="relative flex items-center flex-1 min-w-0 max-w-96">
      <input
        type="text"
        value={inputValue}
        onChange={e => handleFilterChange(e.target.value)}
        onKeyDown={handleFilterKeyDown}
        placeholder={I18n.t('toolbar.filterPlaceholder')}
        disabled={isExporting}
        className="pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded bg-white text-slate-700 focus:outline-none focus:border-indigo-400 w-full disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <svg className="absolute left-2 text-slate-400 pointer-events-none" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      {inputValue && (
        <button
          className="absolute right-1.5 text-slate-400 hover:text-slate-600 text-xs"
          onClick={handleFilterClear}
        >✕</button>
      )}
    </div>
  ) : null;

  // In Excel preview mode, grid-editing icons (reload/reset/columns) don't apply — disable them.
  const gridActionsDisabled = isExcelViewMode;

  // All toolbar actions as one outlined, connected segmented group. Preview is highlighted when
  // active; the download segment appears (within the same outline) only in preview mode.
  const iconGroup = (
    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-slate-200 divide-x divide-slate-200">
      {onReloadData && segmentButton(ReloadIcon, 'reload', reloadBtnText, onReloadData, {disabled: isReloading || gridActionsDisabled || isExporting, spinning: isReloading})}
      {segmentButton(ColumnWidthIcon, 'reset', resetWidthBtnText, () => { if (hasCustomWidths) onResetWidths(); }, {active: hasCustomWidths, disabled: gridActionsDisabled || isExporting})}
      {segmentButton(SortResetIcon, 'reset', I18n.t('toolbar.resetSort'), () => { if (sortInfo?.direction) onResetSort(); }, {active: !!(sortInfo && sortInfo.direction), disabled: isExporting})}
      {segmentButton(ColumnsIcon, 'columns', selectColsBtnText, onShowColumnSelector, {disabled: gridActionsDisabled})}
      {segmentButton(ExcelIcon, 'preview', excelBtnText, onToggleExcelView, {active: isExcelViewMode, disabled: isExporting})}
      {isExcelViewMode && segmentButton(DownloadIcon, 'download', downloadExcelBtnText, onDownloadExcel)}
    </div>
  );

  // While indexing a stream grid, hide toolbar buttons and pagination, keep only the title (and indexing progress).
  if (isIndexing) {
    return (
      <div className="everygrid-toolbar" ref={toolbarRef}>
        {filterInput}
        {gridTitle && (
          <span className="ml-auto text-[11px] font-bold text-slate-500 uppercase tracking-wider">{gridTitle}</span>
        )}
      </div>
    );
  }

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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
          {menuOpen && (
            <div className="everygrid-mobile-menu">
              {onReloadData && createMenuButton(reloadBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onReloadData)}
              {createMenuButton(downloadExcelBtnText, 'bg-white text-slate-700 hover:bg-slate-50', onDownloadExcel)}
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
      {iconGroup}
      {hiddenColsBtnText && createButton(hiddenColsBtnText, 'bg-red-50 text-red-600 border border-red-100 rounded hover:bg-red-100 transition-colors', onShowHiddenColumnSelector)}
      {resetBtnText && createButton(resetBtnText, 'bg-orange-100 text-orange-700', onReset)}
      {gridTitle && (
        <span className="ml-auto text-[11px] font-bold text-slate-500 uppercase tracking-wider">{gridTitle}</span>
      )}
    </div>
  );
};
