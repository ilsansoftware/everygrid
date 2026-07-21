import React, {useEffect, useRef} from 'react';
import {ExcelView} from '../core/ExcelView';

export interface ExcelViewProps {
  data: unknown[];
  limit?: number;
  isExcel?: boolean;
}

export const ExcelViewComponent = ({data, limit, isExcel = false}: ExcelViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // The table is rebuilt wholesale on every data change. Emptying the node collapses the
    // scroller's height, which makes the browser clamp scrollTop to 0 — so an appended chunk would
    // throw the reader back to the top. Capture the offset and put it back after the rebuild.
    const scroller = el.parentElement;
    const prevTop = scroller?.scrollTop ?? 0;
    el.innerHTML = '';
    el.appendChild(ExcelView.createExcelTable(data, limit, isExcel));
    if (scroller && prevTop) scroller.scrollTop = prevTop;
  }, [data, limit, isExcel]);

  return <div ref={containerRef} className='everygrid-excel-wrapper'/>;
};

/** Rows per preview page when the grid has no pagination of its own to follow. */
export const EXCEL_PAGE_SIZE = 50;

export const ExcelViewWrapperComponent = <T extends Record<string, unknown>>({
                                                                               data,
                                                                               toolbar,
                                                                               footer,
                                                                               onBodyScroll,
                                                                             }: {
  data: T[],
  toolbar: React.ReactNode,
  /** Pagination for the preview — it pages through the whole result rather than truncating it. */
  footer?: React.ReactNode,
  /** Set for grids that scroll rather than page: fires as the preview body nears its end. */
  onBodyScroll?: React.UIEventHandler<HTMLDivElement>,
}) => {
  return (
    // h-full + min-h-0 all the way down: the host sizes the grid (a virtual grid's container has a
    // fixed height), and without the constraint reaching the table container the table grew to its
    // natural height, overflowed the wrapper's `overflow-hidden` and was silently cut off.
    <div className='everygrid-wrapper h-full flex flex-col min-h-0'>
      {toolbar}
      {/* isolate, for the same reason the normal view's body has it: this table carries the
          `everygrid-table` class, so its header cells are `sticky top-0` at the in-body band's
          z-index. Without a stacking context of its own that number reaches page level, where it
          outranks the toolbar sitting above it. Isolated, the header only orders against the rows. */}
      <div className='everygrid-table-container everygrid-excel-body overscroll-x-none isolate flex-1 min-h-0'
           onScroll={onBodyScroll}>
        <ExcelViewComponent data={data} isExcel={true}/>
      </div>
      {footer}
    </div>
  );
};
