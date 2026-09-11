import React from 'react';
import {createResizeHandler} from '../core/ResizeUtils';
import {type GridColumn, type IEverygrid} from '../core/types';
import {I18n} from '../i18n/I18n';
import {SortDownIcon} from '../icons/SortDownIcon.tsx';
import {SortUpIcon} from '../icons/SortUpIcon.tsx';
import {PinFilledIcon} from '../icons/PinFilledIcon.tsx';
import {EditIcon} from '../icons/EditIcon.tsx';
import {TableCellComponent} from './TableCellComponent';

interface PinnedTableComponentProps<T extends Record<string, unknown>> {
  instance: IEverygrid<T>;
  columns: GridColumn[];
  displayItems: (T | undefined)[];
  container: HTMLElement;
  containerId: string;
  editableFields: string[];
  gridTitle?: string;
  startIndex?: number;
  filterText?: string;
  isIndexing?: boolean;
  isExporting?: boolean;
  /** Must match the main table's spacers exactly — that identity is what keeps the two
   *  tables' rows aligned without any JS height syncing. */
  virtual?: {topPad: number; bottomPad: number; rowHeight: number};
  /** Same rows as the main table's — the two must stay row-for-row aligned. */
  insertedItems?: T[];
}

export const PinnedTableComponent = React.memo(<T extends Record<string, unknown>>({
                                                                                     instance,
                                                                                     columns,
                                                                                     displayItems,
                                                                                     container,
                                                                                     containerId,
                                                                                     editableFields,
                                                                                     startIndex = 0,
                                                                                     insertedItems = [],
                                                                                     isExporting = false,
                                                                                     filterText = '',
                                                                                     isIndexing = false,
                                                                                     virtual,
                                                                                   }: PinnedTableComponentProps<T>) => {
  const pinnedFields = instance.pinnedColumns;
  const pinnedColumns = columns.filter((col) => pinnedFields.has(col.field));

  const handlePin = (col: GridColumn) => {
    if (instance.pinnedColumns.has(col.field)) {
      instance.pinnedColumns.delete(col.field);
    } else {
      instance.pinnedColumns.add(col.field);
    }
    instance.renderGrid(container);
  };

  const handleSort = (col: GridColumn) => {
    if (isIndexing || isExporting) return;
    const sortInfo = instance.sortConfig.get(containerId);
    const isCurrentSortField = sortInfo?.field === col.field;
    const currentDirection = isCurrentSortField ? sortInfo?.direction : 'asc';
    const nextDirection = currentDirection === 'asc' ? 'desc' : 'asc';

    instance.sortConfig.set(containerId, {field: col.field, direction: nextDirection});
    const paginationConfig = instance.getPagination(containerId);
    if (paginationConfig?.serverSide && instance.options.serverFetcher) {
      instance.currentPage.set(containerId, 1);
      instance.fetchServerPage(containerId).catch(console.error);
    } else if (instance._streamRows.has(containerId)) {
      instance.currentPage.set(containerId, 1);
      instance.renderGrid(container);
    } else {
      instance.applyWasmFilter(containerId).catch(console.error);
    }
  };

  const handleResizeStart = createResizeHandler(instance, containerId, container);

  const currentWidths = instance.getCurrentWidths(containerId);
  // The table switches to table-fixed once any column has a width; unsized columns then collapse
  // to nothing. In that mode, fall back to a sane default so a newly pinned column stays visible.
  const isFixedLayout = currentWidths.size > 0 || pinnedColumns.some(c => c.width);
  const DEFAULT_PINNED_WIDTH = 150;

  const getColumnStyle = (col: GridColumn) => {
    const width = currentWidths.get(col.field) || col.width || (isFixedLayout ? DEFAULT_PINNED_WIDTH : undefined);
    if (width) {
      return {
        width: `${width}px`,
        minWidth: `${width}px`,
      };
    }
    return {};
  };

  return (
    <div className='z-40 everygrid-pinned-table-container flex flex-col'>
      <table
        className={`min-w-0 min-w-none w-auto everygrid-table ${(currentWidths && currentWidths.size > 0) || pinnedColumns.some(c => c.width) ? 'table-fixed' : 'table-auto'}`}>
        <thead>
        <tr>
          {pinnedColumns.map((col) => (
            <th key={col.field} style={getColumnStyle(col)}
                className='text-left'>
              <div className='everygrid-header-content px-2 py-2'>
                <span className='truncate'>{col.headerName || col.field}</span>
                <div className='flex items-center gap-1 shrink-0'>
                  <button className='everygrid-icon-btn is-active' disabled={isIndexing || isExporting} onClick={(e) => {
                    e.stopPropagation();
                    handlePin(col);
                  }}><PinFilledIcon/></button>
                  <div className='flex items-center gap-1 shrink-0'>
                    {editableFields.includes(col.field) && (
                      <button
                        className={`everygrid-icon-btn ${instance.activeEditFields.get(containerId)?.has(col.field) ? 'is-active' : ''}`}
                        disabled={isIndexing || isExporting}
                        onClick={(e) => {
                          e.stopPropagation();
                          const activeEdits = instance.activeEditFields.get(containerId) || new Set();
                          if (activeEdits.has(col.field)) {
                            activeEdits.delete(col.field);
                          } else {
                            activeEdits.add(col.field);
                          }
                          instance.activeEditFields.set(containerId, activeEdits);
                          instance.renderGrid(container);
                        }}
                      >
                        <EditIcon/>
                      </button>
                    )}
                    {(() => {
                      const isJsonCol = displayItems.some(item => {
                        const v = item?.[col.field];
                        return (typeof v === 'object' && v !== null) ||
                          (typeof v === 'string' && v.trimStart().startsWith('{'));
                      });
                      if (isJsonCol) return null;
                      return (
                        <button
                          className={`everygrid-icon-btn ${instance.sortConfig.get(containerId)?.field === col.field ? 'is-active' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSort(col);
                          }}
                          title={instance.sortConfig.get(containerId)?.field === col.field && instance.sortConfig.get(containerId)?.direction === 'asc' ? I18n.t('grid.sortAsc') : I18n.t('grid.sortDesc')}
                          disabled={isIndexing || isExporting}
                        >
                          {instance.sortConfig.get(containerId)?.field === col.field && instance.sortConfig.get(containerId)?.direction === 'desc' ?
                            <SortDownIcon/> : <SortUpIcon/>}
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </div>
              {!(isIndexing || isExporting) && (
                <div className='everygrid-resizer' onMouseDown={(e) => handleResizeStart(e, col.field)} onTouchStart={(e) => handleResizeStart(e, col.field)}/>
              )}
            </th>
          ))}
        </tr>
        </thead>
        <tbody>
        {insertedItems.map((item, i) => (
          <tr key={`ins-${i}`}
              style={virtual ? {height: `${virtual.rowHeight}px`} : undefined}
              className='everygrid-row-inserted'>
            {pinnedColumns.map((col) => col.type === 'data_checkbox'
              ? <td key={`ins-${i}-${col.field}`} className='w-10'/>
              : (
                <TableCellComponent
                  key={`ins-${i}-${col.field}`}
                  grid={instance}
                  col={col}
                  item={item}
                  rowIndex={-1 - i}
                  containerId={containerId}
                  container={container}
                  editableFields={editableFields}
                  filterText={filterText}
                />
              ))}
          </tr>
        ))}
        {virtual && virtual.topPad > 0 && (
          <tr className='everygrid-spacer-row' style={{height: `${virtual.topPad}px`}} aria-hidden='true'>
            <td colSpan={pinnedColumns.length}/>
          </tr>
        )}
        {displayItems.map((rowData, index) => {
          const rowIndex = startIndex + index;
          if (rowData === undefined) {
            return (
              <tr key={rowIndex} className='everygrid-row-placeholder' style={{height: `${virtual?.rowHeight}px`}}>
                <td colSpan={pinnedColumns.length}><span/></td>
              </tr>
            );
          }
          const isActiveRow = instance.activePopupRowKey != null && instance.activePopupRowKey === JSON.stringify(rowData);
          return (
            <tr key={rowIndex}
                style={virtual ? {height: `${virtual.rowHeight}px`} : undefined}
                className={`${rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'} ${isActiveRow ? 'is-popup-active' : ''}`}>
              {pinnedColumns.map((col) => (
                <TableCellComponent
                  key={`${rowIndex}-${col.field}`}
                  grid={instance}
                  col={col}
                  item={rowData}
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
        {virtual && virtual.bottomPad > 0 && (
          <tr className='everygrid-spacer-row' style={{height: `${virtual.bottomPad}px`}} aria-hidden='true'>
            <td colSpan={pinnedColumns.length}/>
          </tr>
        )}
        </tbody>
      </table>
    </div>
  );
}) as <T extends Record<string, unknown>>(props: PinnedTableComponentProps<T>) => React.ReactElement;
