import React, {useMemo} from 'react';
import {createResizeHandler} from '../core/ResizeUtils';
import type {GridColumn, IEverygrid} from '../core/types';
import {I18n} from '../i18n/I18n';
import {TableCellComponent} from './TableCellComponent';
import {PinEmptyIcon} from '../icons/PinEmptyIcon.tsx';
import {EditIcon} from '../icons/EditIcon.tsx';
import {PlusIcon} from '../icons/PlusIcon.tsx';
import {CommaIcon} from '../icons/CommaIcon.tsx';
import {SortDownIcon} from '../icons/SortDownIcon.tsx';
import {HideIcon} from '../icons/HideIcon.tsx';
import {SortUpIcon} from '../icons/SortUpIcon.tsx';
import {MobileColumnsIcon} from '../icons/MobileColumnsIcon.tsx';

// Measure rendered text width for sizing mobile columns to their header label. One reused canvas —
// measureText is allocation-free and needs no layout, so it's cheap to call per column per render.
let _measureCanvas: HTMLCanvasElement | null = null;
const measureTextWidth = (text: string, font: string): number => {
  if (typeof document === 'undefined') return 0;
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
};

export interface GridTableProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  columns: GridColumn[];
  /** In virtual mode a row whose block hasn't arrived yet is `undefined` — render a placeholder. */
  displayItems: (T | undefined)[];
  container: HTMLElement;
  containerId: string;
  editableFields: string[];
  currentWidths: Map<string, number>;
  gridTitle?: string;
  startIndex?: number;
  filterText?: string;
  isIndexing?: boolean;
  isExporting?: boolean;
  /** Narrow layout: columns fit the viewport (no horizontal scroll), resizing/pinning are off. */
  isMobile?: boolean;
  /** Set when the target scrolls virtually: spacer heights standing in for the unrendered rows. */
  virtual?: {topPad: number; bottomPad: number; rowHeight: number};
}

export const GridTableComponent = React.memo(<T extends Record<string, unknown>>({
                                                                                   grid,
                                                                                   columns,
                                                                                   displayItems,
                                                                                   container,
                                                                                   containerId,
                                                                                   editableFields,
                                                                                   currentWidths,
                                                                                   startIndex = 0,
                                                                                   filterText = '',
                                                                                   isIndexing = false,
                                                                                   isExporting = false,
                                                                                   isMobile = false,
                                                                                   virtual,
                                                                                 }: GridTableProps<T>) => {
  // "Select/check all" means "every row rendered right now". Under virtual scrolling that set is
  // whatever happens to be in the viewport, which is not a selection anyone asked for — so the
  // header checkboxes are dropped there rather than given a surprising meaning.
  const loadedItems = useMemo(() => displayItems.filter((i): i is T => i !== undefined), [displayItems]);

  const isAllChecked = useMemo(() => {
    if (!grid.checkedValues) return false;
    const checkedSet = grid.checkedValues.get(containerId);
    if (!checkedSet || checkedSet.size === 0 || loadedItems.length === 0) return false;
    const checkboxCol = columns.find(c => c.type === 'data_checkbox');
    if (!checkboxCol) return false;
    const mappingField = checkboxCol.mapping ?? checkboxCol.field;
    return loadedItems.every(item => checkedSet.has(item[mappingField]));
  }, [loadedItems, grid, containerId, columns]);

  const handleCheckAll = (checked: boolean) => {
    const checkboxCol = columns.find(c => c.type === 'data_checkbox');
    if (!checkboxCol) return;
    const mappingField = checkboxCol.mapping ?? checkboxCol.field;
    grid.setChecked(containerId, loadedItems.map(item => item[mappingField]), checked);
  };

  const handleToggleColumn = (field: string) => {
    // Logic for toggle comma separator
    if (grid.commaSeparatedFields.has(field)) {
      grid.commaSeparatedFields.delete(field);
    } else {
      grid.commaSeparatedFields.add(field);
    }
    grid.renderGrid(container);
  };

  const handlePin = (field: string) => {
    if (grid.pinnedColumns.has(field)) {
      grid.pinnedColumns.delete(field);
    } else {
      // Once any column has a custom width, the pinned table renders with table-fixed, where a
      // column with no explicit width collapses to nothing. Capture this column's current
      // rendered width before it moves so it keeps its size in the pinned table.
      const widths = grid.getCurrentWidths(containerId);
      if (widths.size > 0 && !widths.get(field)) {
        const th = container.querySelector(`th[data-field="${CSS.escape(field)}"]`) as HTMLElement | null;
        if (th) grid.updateColumnWidth(containerId, field, th.offsetWidth);
      }
      grid.pinnedColumns.add(field);
    }
    grid.renderGrid(container);
  };

  const handleSort = (field: string) => {
    if (isIndexing || isExporting) return;
    const sortInfo = grid.sortConfig.get(containerId);
    let direction: 'asc' | 'desc' | null = 'asc';
    if (sortInfo?.field === field) {
      if (sortInfo.direction === 'asc') direction = 'desc';
      else if (sortInfo.direction === 'desc') direction = 'asc';
    }
    grid.sortConfig.set(containerId, {field, direction});
    const paginationConfig = grid.getPagination(containerId);
    if (paginationConfig?.serverSide && grid.options.serverFetcher) {
      grid.currentPage.set(containerId, 1);
      grid.fetchServerPage(containerId).catch(console.error);
    } else if (grid._streamRows.has(containerId)) {
      grid.currentPage.set(containerId, 1);
      grid.renderGrid(container);
    } else {
      grid.applyWasmFilter(containerId).catch(console.error);
    }
  };

  const handleHide = (field: string) => {
    const hiddenFields = grid.hiddenFieldsMap.get(containerId) || new Set();
    hiddenFields.add(field);
    grid.hiddenFieldsMap.set(containerId, hiddenFields);
    grid.renderGrid(container);
  };

  const handleResizeStart = createResizeHandler(grid, containerId, container, true);

  // Pinning is a desktop affordance; on mobile every picked column must stay visible.
  const gridColumns = isMobile
    ? columns
    : columns.filter((col) => !grid.pinnedColumns.has(col.field));

  // Mobile: each data column is a fixed 1/3 of the viewport width (1:1:1, detail column excluded),
  // and the row scrolls horizontally within that band. The detail button is pinned to the right
  // (sticky) so it stays reachable while the columns scroll. Fixed widths keep sort/long values from
  // ever resizing a column.
  const MOBILE_DETAIL_W = 52;
  const mobileDataCols = isMobile ? gridColumns.filter(c => c.type !== 'row_detail').length || 1 : 1;
  // Base 1:1:1 width: three data columns PLUS the pinned detail column fill the viewport (the detail
  // width is subtracted before dividing, so the 3rd column isn't hidden behind it). Measured from the
  // container (the ResizeObserver in EverygridComponent re-renders on width change, so it stays
  // current). Selecting more than three columns overflows and scrolls; with fewer, the divisor drops
  // so they still fill the width.
  const mobileColsPerView = Math.min(3, mobileDataCols);
  const mobileBaseColW = isMobile
    ? Math.max(96, Math.floor((Math.round(container.getBoundingClientRect().width) - MOBILE_DETAIL_W) / mobileColsPerView))
    : 0;
  // A column grows past the base only when its header LABEL needs more room, so the column name is
  // never truncated to "blah…". Short-named columns keep the 1:1:1 base; wide ones grow and scroll.
  // (Data cells still truncate — only the header name is guaranteed to fit.) Extra accounts for the
  // th px-1 (8) + header px-3 (24) + gap (4) + sort-icon area (~16), plus slack so an off-by-a-pixel
  // measurement can't clip the last glyph.
  const MOBILE_HEADER_EXTRA = 60;
  const headerFont = isMobile
    ? `600 14px ${(typeof getComputedStyle !== 'undefined' ? getComputedStyle(container).fontFamily : '') || 'sans-serif'}`
    : '';
  const mobileDataColWidths = isMobile
    ? gridColumns
      .filter(c => c.type !== 'row_detail')
      .map(c => {
        const label = c.headerName || c.field;
        // Canvas measure; if it comes back empty (no 2d context) estimate from length so a long
        // label still widens its column instead of silently truncating.
        const measured = measureTextWidth(label, headerFont);
        const textW = measured > 0 ? measured : label.length * 8.5;
        const w = Math.max(mobileBaseColW, Math.ceil(textW) + MOBILE_HEADER_EXTRA);
        return {field: c.field, w};
      })
    : [];
  const mobileWidthByField = new Map(mobileDataColWidths.map(({field, w}) => [field, w]));
  const mobileTableWidth = mobileDataColWidths.reduce((sum, {w}) => sum + w, 0) + MOBILE_DETAIL_W;
  // Fields shown as visible mobile columns — the detail button uses this to flag matches that live
  // only in the hidden (detail-only) fields.
  const visibleFields = useMemo(
    () => isMobile ? gridColumns.filter(c => c.type !== 'row_detail').map(c => c.field) : [],
    [isMobile, gridColumns],
  );

  const getColumnStyle = (col: GridColumn) => {
    if (isMobile) {
      if (col.type === 'row_detail' || col.type === 'row_actions') return {width: `${MOBILE_DETAIL_W}px`, minWidth: `${MOBILE_DETAIL_W}px`};
      const w = `${mobileWidthByField.get(col.field) ?? mobileBaseColW}px`;
      return {width: w, minWidth: w, maxWidth: w};
    }
    const width = currentWidths.get(col.field) || col.width;
    if (width) {
      return {
        width: `${width}px`,
        minWidth: `${width}px`,
      };
    }
    return {};
  };

  return (
    <div className={`everygrid-table-container overscroll-x-none flex-1 min-w-0 flex flex-col ${isMobile ? 'everygrid-mobile-x' : ''}`}>
      <table
        className={`everygrid-table ${isMobile ? 'everygrid-mobile table-fixed' : ((currentWidths && currentWidths.size > 0) || gridColumns.some(c => c.width) ? 'table-fixed w-max min-w-full' : '')}`}
        style={isMobile ? {width: `${mobileTableWidth}px`} : undefined}>
        <thead>
        <tr>
          {gridColumns.map((col) => (
            <th key={col.field} data-field={col.field} style={getColumnStyle(col)}
                className={`${col.type === 'row_detail' ? 'everygrid-detail-cell ' : ''}${col.type === 'row_actions' ? 'everygrid-actions-cell ' : ''}${col.type === 'data_checkbox' ? 'w-10' : ''} text-left`}>
              <div
                className='everygrid-header-content px-2 py-2'
              >
                {col.type === 'row_actions' ? (
                  <div className='flex w-full justify-center'>
                    {grid.getRowActions(containerId).insertRow && (
                      <button
                        type='button'
                        className='everygrid-action-btn'
                        aria-label={I18n.t('grid.insertRow')}
                        title={I18n.t('grid.insertRow')}
                        disabled={isIndexing || isExporting}
                        onClick={(e) => {
                          e.stopPropagation();
                          grid.insertRow(containerId);
                        }}>
                        <PlusIcon className='w-4 h-4'/>
                      </button>
                    )}
                  </div>
                ) : col.type === 'row_detail' ? (
                  <div className='flex w-full justify-center'>
                    <button
                      type='button'
                      className='flex items-center justify-center text-current transition-colors'
                      aria-label={I18n.t('toolbar.mobileColumns')}
                      title={I18n.t('toolbar.mobileColumns')}
                      onClick={(e) => {
                        e.stopPropagation();
                        grid.showMobileColumnSelector(grid.getDataFields(containerId), container);
                      }}>
                      <MobileColumnsIcon className='w-5 h-5'/>
                    </button>
                  </div>
                ) : col.type === 'data_checkbox' ? (
                  <div className='flex justify-center w-full'>
                    {!virtual && (
                      <input type='checkbox' className='cursor-pointer' checked={isAllChecked}
                             disabled={isIndexing || isExporting}
                             onChange={(e) => handleCheckAll(e.target.checked)}/>
                    )}
                  </div>
                ) : (
                  <>
                    <span className='truncate'>{col.headerName || col.field}</span>
                    <div className='flex items-center gap-1 shrink-0'>
                      {/* Mobile keeps the narrow header to just the label + sort: pinning, hide, and
                          the column-modify icons (thousands-comma, inline-edit) are all dropped. */}
                      {!isMobile && (
                        <button
                          className={`everygrid-icon-btn ${grid.pinnedColumns.has(col.field) ? 'is-active' : ''}`}
                          disabled={isIndexing || isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handlePin(col.field);
                          }}>
                          <PinEmptyIcon/>
                        </button>
                      )}
                      {!isMobile && (col.field !== I18n.t('grid.index') && grid.isColumnNumeric(col.field)) && (
                        <button
                          className={`everygrid-icon-btn ${grid.commaSeparatedFields.has(col.field) ? 'is-active' : ''}`}
                          disabled={isIndexing || isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleColumn(col.field);
                          }}><CommaIcon/></button>
                      )}
                      {!isMobile && editableFields.includes(col.field) && (
                        <button
                          className={`everygrid-icon-btn ${grid.activeEditFields.get(containerId)?.has(col.field) ? 'is-active' : ''}`}
                          disabled={isIndexing || isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            const activeEdits = grid.activeEditFields.get(containerId) || new Set();
                            if (activeEdits.has(col.field)) {
                              activeEdits.delete(col.field);
                            } else {
                              activeEdits.add(col.field);
                            }
                            grid.activeEditFields.set(containerId, activeEdits);
                            grid.renderGrid(container);
                          }}
                        >
                          <EditIcon/>
                        </button>
                      )}
                      {!isMobile && (
                        <button
                          className='everygrid-icon-btn'
                          disabled={isIndexing || isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleHide(col.field);
                          }}>
                          <HideIcon/>
                        </button>
                      )}
                      {(() => {
                        const isJsonCol = loadedItems.some(item => {
                          const v = item[col.field];
                          return (typeof v === 'object' && v !== null) ||
                            (typeof v === 'string' && v.trimStart().startsWith('{'));
                        });
                        if (isJsonCol) {
                          return null;
                        }
                        return (
                          <button
                            // Disabled, not hidden: headers keep their shape while the grid is
                            // busy instead of the icons popping in and out.
                            className={`everygrid-icon-btn ${grid.sortConfig.get(containerId)?.field === col.field ? 'is-active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isExporting) return;
                              handleSort(col.field);
                            }}
                            title={grid.sortConfig.get(containerId)?.field === col.field && grid.sortConfig.get(containerId)?.direction === 'asc' ? I18n.t('grid.sortAsc') : I18n.t('grid.sortDesc')}
                            disabled={isIndexing || isExporting}
                          >
                            {grid.sortConfig.get(containerId)?.field === col.field && grid.sortConfig.get(containerId)?.direction === 'desc' ?
                              <SortDownIcon/> : <SortUpIcon/>}
                          </button>
                        );
                      })()}
                    </div>
                    {/* Resizing while the data underneath is being replaced would measure the
                        old columns, so it goes inert with everything else. */}
                    {!isMobile && !(isIndexing || isExporting) && (
                      <div className='everygrid-resizer' onMouseDown={(e) => handleResizeStart(e, col.field)} onTouchStart={(e) => handleResizeStart(e, col.field)}/>
                    )}
                  </>
                )}
              </div>
            </th>
          ))}
        </tr>
        </thead>
        <tbody>
        {/* Spacer rows stand in for the rows above/below the window. Kept inside the tbody as
            real <tr>s so table-fixed layout, column widths and the sticky header all keep
            working — a transform/absolute body would break every one of them. */}
        {virtual && virtual.topPad > 0 && (
          <tr className='everygrid-spacer-row' style={{height: `${virtual.topPad}px`}} aria-hidden='true'>
            <td colSpan={gridColumns.length}/>
          </tr>
        )}
        {displayItems.map((item, index) => {
          const rowIndex = startIndex + index;
          if (item === undefined) {
            // Block still in flight: hold the row's space so the scrollbar doesn't jump.
            return (
              <tr key={rowIndex} className='everygrid-row-placeholder' style={{height: `${virtual?.rowHeight}px`}}>
                <td colSpan={gridColumns.length}><span/></td>
              </tr>
            );
          }
          const isActiveRow = grid.activePopupRowKey != null && grid.activePopupRowKey === JSON.stringify(item);
          const rowState = grid.isRowDeleted(item) ? ' everygrid-row-deleted' : grid.isRowInserted(item) ? ' everygrid-row-inserted' : '';
          return (
            <tr key={rowIndex}
                style={virtual ? {height: `${virtual.rowHeight}px`} : undefined}
                className={`${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'} ${isActiveRow ? 'is-popup-active' : ''}${rowState}`}>
              {gridColumns.map((col) => (
                <TableCellComponent
                  key={`${rowIndex}-${col.field}`}
                  grid={grid}
                  col={col}
                  item={item}
                  rowIndex={rowIndex}
                  containerId={containerId}
                  container={container}
                  editableFields={editableFields}
                  filterText={filterText}
                  visibleFields={visibleFields}
                  isMobile={isMobile}
                />
              ))}
            </tr>
          );
        })}
        {virtual && virtual.bottomPad > 0 && (
          <tr className='everygrid-spacer-row' style={{height: `${virtual.bottomPad}px`}} aria-hidden='true'>
            <td colSpan={gridColumns.length}/>
          </tr>
        )}
        </tbody>
      </table>
    </div>
  );
}) as <T extends Record<string, unknown>>(props: GridTableProps<T>) => React.ReactElement;
