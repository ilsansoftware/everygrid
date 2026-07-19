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

export interface GridTableProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  columns: GridColumn[];
  displayItems: T[];
  container: HTMLElement;
  containerId: string;
  editableFields: string[];
  currentWidths: Map<string, number>;
  gridTitle?: string;
  startIndex?: number;
  filterText?: string;
  isIndexing?: boolean;
  isExporting?: boolean;
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
                                                                                 }: GridTableProps<T>) => {
  const isAllSelected = useMemo(() => {
    return displayItems.length > 0 && displayItems.every(item => grid.getSelectedRows(containerId)?.has(item));
  }, [displayItems, grid, containerId]);

  const isAllChecked = useMemo(() => {
    if (!grid.checkedValues) return false;
    const checkedSet = grid.checkedValues.get(containerId);
    if (!checkedSet || checkedSet.size === 0 || displayItems.length === 0) return false;
    const checkboxCol = columns.find(c => c.type === 'data_checkbox');
    if (!checkboxCol) return false;
    const mappingField = checkboxCol.mapping ?? checkboxCol.field;
    return displayItems.every(item => checkedSet.has(item[mappingField]));
  }, [displayItems, grid, containerId, columns]);

  const handleCheckAll = (checked: boolean) => {
    if (!grid.checkedValues) return;
    const checkboxCol = columns.find(c => c.type === 'data_checkbox');
    if (!checkboxCol) return;
    const mappingField = checkboxCol.mapping ?? checkboxCol.field;
    const set = grid.checkedValues.get(containerId) ?? new Set();
    if (checked) {
      displayItems.forEach(item => set.add(item[mappingField]));
    } else {
      displayItems.forEach(item => set.delete(item[mappingField]));
    }
    grid.checkedValues.set(containerId, set);
    grid.renderGrid(container);
  };

  const handleSelectAll = (checked: boolean) => {
    const selected = new Set(grid.getSelectedRows(containerId));
    if (checked) {
      displayItems.forEach(item => selected.add(item));
    } else {
      displayItems.forEach(item => selected.delete(item));
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

  const gridColumns = columns
    .filter((col) => !grid.pinnedColumns.has(col.field));

  const getColumnStyle = (col: GridColumn) => {
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
    <div className="everygrid-table-container overscroll-x-none flex-1 min-w-0 flex flex-col">
      <table
        className={`everygrid-table ${(currentWidths && currentWidths.size > 0) || gridColumns.some(c => c.width) ? 'table-fixed w-max min-w-full' : ''}`}>
        <thead>
        <tr>
          {gridColumns.map((col) => (
            <th key={col.field} data-field={col.field} style={getColumnStyle(col)}
                className={`${col.type === 'row_checkbox' || col.type === 'data_checkbox' ? 'w-10' : ''} text-left`}>
              <div
                className="everygrid-header-content px-2 py-2"
              >
                {col.type === 'row_checkbox' ? (
                  <div className="flex justify-center w-full">
                    <input type="checkbox" className="cursor-pointer" checked={isAllSelected}
                           onChange={(e) => handleSelectAll(e.target.checked)}/>
                  </div>
                ) : col.type === 'data_checkbox' ? (
                  <div className="flex justify-center w-full">
                    <input type="checkbox" className="cursor-pointer" checked={isAllChecked}
                           onChange={(e) => handleCheckAll(e.target.checked)}/>
                  </div>
                ) : (
                  <>
                    <span className="truncate">{col.headerName || col.field}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        className={`everygrid-icon-btn ${grid.pinnedColumns.has(col.field) ? 'is-active' : ''}`}
                        disabled={isExporting}
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePin(col.field);
                        }}>
                        <PinEmptyIcon/>
                      </button>
                      {(col.field !== I18n.t('grid.index') && grid.isColumnNumeric(col.field)) && (
                        <button
                          className={`everygrid-icon-btn ${grid.commaSeparatedFields.has(col.field) ? 'is-active' : ''}`}
                          disabled={isExporting}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleColumn(col.field);
                          }}><CommaIcon/></button>
                      )}
                      {editableFields.includes(col.field) && (
                        <button
                          className={`everygrid-icon-btn ${grid.activeEditFields.get(containerId)?.has(col.field) ? 'is-active' : ''}`}
                          disabled={isExporting}
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
                      <button
                        className="everygrid-icon-btn"
                        disabled={isExporting}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleHide(col.field);
                        }}>
                        <HideIcon/>
                      </button>
                      {(() => {
                        const isJsonCol = displayItems.some(item => {
                          const v = item[col.field];
                          return (typeof v === 'object' && v !== null) ||
                            (typeof v === 'string' && v.trimStart().startsWith('{'));
                        });
                        if (isJsonCol) {
                          return null;
                        }
                        return (
                          <button
                            className={`everygrid-icon-btn ${grid.sortConfig.get(containerId)?.field === col.field ? 'is-active' : ''} ${isIndexing ? 'hidden' : ''}`}
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
                    <div className="everygrid-resizer" onMouseDown={(e) => handleResizeStart(e, col.field)} onTouchStart={(e) => handleResizeStart(e, col.field)}/>
                  </>
                )}
              </div>
            </th>
          ))}
        </tr>
        </thead>
        <tbody>
        {displayItems.map((item, index) => {
          const rowIndex = startIndex + index;
          const isActiveRow = grid.activePopupRowKey != null && grid.activePopupRowKey === JSON.stringify(item);
          return (
            <tr key={rowIndex}
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
                />
              ))}
            </tr>
          );
        })}
        </tbody>
      </table>
    </div>
  );
}) as <T extends Record<string, unknown>>(props: GridTableProps<T>) => React.ReactElement;
