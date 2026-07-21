import {I18n} from '../i18n/I18n';

export interface RowCountProps {
  /** 1-based index of the first row on screen, or 0 when there are none. */
  start: number;
  /** 1-based index of the last row on screen. */
  end: number;
  /** Rows remaining after the filter. */
  total: number;
  /** Rows before the filter, for the "x of y" form. */
  rawTotal: number;
  /** Extra class, so the pagination bar can style its own copy differently. */
  className?: string;
}

/**
 * The "Showing 1–5 of 10" line. It lives between the toolbar and the table rather than inside the
 * pagination, because it describes the data whether or not the grid is paged — a virtual or
 * single-page grid has just as much use for it, and there is no pagination there to carry it.
 */
export const RowCountComponent = ({start, end, total, rawTotal, className = ''}: RowCountProps) => {
  const fmt = (n: number) => n.toLocaleString();
  const isFiltered = total !== rawTotal;
  return (
    <div className={`everygrid-row-count ${className}`}>
      {isFiltered
        ? I18n.t('pagination.showingFiltered', {
            start: fmt(start), end: fmt(end), filtered: fmt(total), total: fmt(rawTotal),
          })
        : I18n.t('pagination.showing', {
            start: fmt(start), end: fmt(end), total: fmt(total),
          })
      }
    </div>
  );
};
