import type {GridColumn, IEverygrid} from '../core/types';
import {TableCellComponent} from './TableCellComponent';

interface InsertedRowsProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  columns: GridColumn[];
  items: T[];
  container: HTMLElement;
  containerId: string;
  editableFields: string[];
  filterText: string;
  rowHeight?: number;
  visibleFields?: string[];
  isMobile?: boolean;
}

/**
 * Rows inserted since load, drawn first in a table body — tinted, before any virtual spacer: new
 * rows belong above the data and are not part of the loaded data the window is computed over.
 * The checkbox column stays empty (a new row has no key to be checked by yet). Rendered by the
 * main table and the pinned table alike, so the two stay row-for-row aligned.
 */
export const InsertedRowsComponent = <T extends Record<string, unknown>>({
  grid, columns, items, container, containerId, editableFields, filterText, rowHeight, visibleFields, isMobile,
}: InsertedRowsProps<T>) => (
  <>
    {items.map((item, i) => (
      <tr key={`ins-${i}`}
          style={rowHeight ? {height: `${rowHeight}px`} : undefined}
          className='everygrid-row-inserted'>
        {columns.map((col) => col.type === 'data_checkbox'
          ? <td key={`ins-${i}-${col.field}`} className='w-10'/>
          : (
            <TableCellComponent
              key={`ins-${i}-${col.field}`}
              grid={grid}
              col={col}
              item={item}
              rowIndex={-1 - i}
              containerId={containerId}
              container={container}
              editableFields={editableFields}
              filterText={filterText}
              visibleFields={visibleFields}
              isMobile={isMobile}
            />
          ))}
      </tr>
    ))}
  </>
);
