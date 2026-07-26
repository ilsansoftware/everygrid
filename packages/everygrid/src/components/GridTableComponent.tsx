import React, {useMemo} from 'react';
import {createResizeHandler} from '../core/ResizeUtils';
import type {GridColumn, IEverygrid} from '../core/types';
import {I18n} from '../i18n/I18n';
import {TableCellComponent} from './TableCellComponent';
import {PinEmptyIcon} from '../icons/PinEmptyIcon.tsx';
import {EditIcon} from '../icons/EditIcon.tsx';
import {CommaIcon} from '../icons/CommaIcon.tsx';
import {SortDownIcon} from '../icons/SortDownIcon.tsx';
import {HideIcon} from '../icons/HideIcon.tsx';
import {SortUpIcon} from '../icons/SortUpIcon.tsx';
import {MobileColumnsIcon} from '../icons/MobileColumnsIcon.tsx';

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

  const isAllSelected = useMemo(() => {
    return loadedItems.length > 0 && loadedItems.every(item => grid.getSelectedRows(containerId)?.has(item));
  }, [loadedItems, grid, containerId]);

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
    if (!grid.checkedValues) return;
    const checkboxCol = columns.find(c => c.type === 'data_checkbox');
    if (!checkboxCol) return;
    const mappingField = checkboxCol.mapping ?? checkboxCol.field;
    const set = grid.checkedValues.get(containerId) ?? new Set();
    if (checked) {
      loadedItems.forEach(item => set.add(item[mappingField]));
    } else {
      loadedItems.forEach(item => set.delete(item[mappingField]));
    }
    grid.checkedValues.set(containerId, set);
    grid.renderGrid(container);
  };

  const handleSelectAll = (checked: boolean) => {
    const selected = new Set(grid.getSelectedRows(containerId));
    if (checked) {
      loadedItems.forEach(item => selected.add(item));
    } else {
      loadedItems.forEach(item => selected.delete(item));
    }
    grid.setSelectedRows(containerId, selected);
    grid.renderGrid(container);
    if (grid.options.onSelectionChange) {
      grid.options.onSelectionChange(Array.from(selected) as T[]);
    }
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

  // Mobile: the detail button takes a small fixed column; the rest split the remaining viewport
  // width evenly (1:1:1), so sorting/long values can never resize a column or push the grid wider.
  const MOBILE_DETAIL_W = 52;
  const mobileDataCols = isMobile ? gridColumns.filter(c => c.type !== 'row_detail').length || 1 : 1;
  // Fields shown as visible mobile columns — the detail button uses this to flag matches that live
  // only in the hidden (detail-only) fields.
  const visibleFields = useMemo(
    () => isMobile ? gridColumns.filter(c => c.type !== 'row_detail').map(c => c.field) : [],
    [isMobile, gridColumns],
  );

  const getColumnStyle = (col: GridColumn) => {
    if (isMobile) {
      if (col.type === 'row_detail') return {width: `${MOBILE_DETAIL_W}px`};
      const w = `calc((100% - ${MOBILE_DETAIL_W}px) / ${mobileDataCols})`;
      return {width: w, maxWidth: w};
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
        className={`everygrid-table ${isMobile ? 'everygrid-mobile table-fixed w-full' : ((currentWidths && currentWidths.size > 0) || gridColumns.some(c => c.width) ? 'table-fixed w-max min-w-full' : '')}`}>
        <thead>
        <tr>
          {gridColumns.map((col) => (
            <th key={col.field} data-field={col.field} style={getColumnStyle(col)}
                className={`${col.type === 'row_checkbox' || col.type === 'data_checkbox' ? 'w-10' : ''} text-left`}>
              <div
                className='everygrid-header-content px-2 py-2'
              >
                {col.type === 'row_detail' ? (
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
                ) : col.type === 'row_checkbox' ? (
                  <div className='flex justify-center w-full'>
                    {!virtual && (
                      <input type='checkbox' className='cursor-pointer' checked={isAllSelected}
                             disabled={isIndexing || isExporting}
                             onChange={(e) => handleSelectAll(e.target.checked)}/>
                    )}
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
                      {/* Pinning is off on mobile (no horizontal scroll to pin against), so its icon
                          is dropped along with hide to keep the narrow header uncluttered. */}
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
                      {(col.field !== I18n.t('grid.index') && grid.isColumnNumeric(col.field)) && (
                        <button
                          className={`everygrid-icon-btn ${grid.commaSeparatedFields.has(col.field) ? 'is-active' : ''}`}
                          disabled={isIndexing || isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleColumn(col.field);
                          }}><CommaIcon/></button>
                      )}
                      {editableFields.includes(col.field) && (
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
          return (
            <tr key={rowIndex}
                style={virtual ? {height: `${virtual.rowHeight}px`} : undefined}
                className={`${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'} ${isActiveRow ? 'is-popup-active' : ''}`}>
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
