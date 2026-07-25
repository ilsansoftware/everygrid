import {I18n} from '../i18n/I18n';
import type {IEverygrid} from '../core/types';
import {RowCountComponent, type RowCountProps} from './RowCountComponent';

export interface PaginationProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  container: HTMLElement;
  currentPage: number;
  totalPages: number;
  /** Greys the controls out without removing them — used while a reload is in flight. */
  disabled?: boolean;
  /**
   * Set to render the row count inside the bar — the layout from before the count moved to the
   * strip under the toolbar. Selected per grid with `pagination.rowCount: 'inline'`.
   */
  rowCount?: Omit<RowCountProps, 'className'>;
  /**
   * Overrides where a page click goes. The Excel preview pages through the same result on its own
   * axis, so it drives its own state rather than moving the grid underneath.
   */
  onPageChange?: (page: number) => void;
}

/** Numbered pages shown at once before paging jumps to the next block. */
const MAX_VISIBLE = 10;

export const PaginationComponent = <T extends Record<string, unknown>>({
                                                                         grid,
                                                                         container,
                                                                         currentPage,
                                                                         totalPages,
                                                                         disabled = false,
                                                                         rowCount,
                                                                         onPageChange,
                                                                       }: PaginationProps<T>) => {
  const containerId = container.id;

  const handlePageChange = (page: number) => {
    if (onPageChange) onPageChange(page);
    else grid.setCurrentPage(containerId, page, container);
  };

  const currentBlock = Math.floor((currentPage - 1) / MAX_VISIBLE);
  const startPage = currentBlock * MAX_VISIBLE + 1;
  const endPage = Math.min(totalPages, startPage + MAX_VISIBLE - 1);
  const pages = [];
  for (let i = startPage; i <= endPage; i++) {
    pages.push(i);
  }

  // A single page has no controls worth drawing; with an inline row count there is still the
  // count itself, so the bar stays.
  if (totalPages <= 1 && !rowCount) return null;

  const renderBtn = (text: string, title: string, page: number, atEdge: boolean, active: boolean = false) => (
    <button
      className={`everygrid-pagination-btn ${atEdge || disabled ? 'disabled' : ''} ${active ? 'active' : ''}`}
      title={title}
      disabled={atEdge || disabled}
      onClick={() => handlePageChange(page)}
      dangerouslySetInnerHTML={{__html: text}}
    />
  );

  return (
    // `@container`: the bar is a container-query context, so its own width — not the viewport's —
    // decides the compact layout. A grid dropped into a narrow column goes compact even on a wide
    // screen, and (unlike the ResizeObserver this replaced) the switch is pure CSS with no render
    // to wait on. The row count stays at the left on both layouts (flex handles that).
    <div className={`everygrid-pagination @container ${rowCount ? 'has-row-count' : ''}`}>
      {rowCount && <RowCountComponent {...rowCount}/>}
      {totalPages > 1 && (
        <div className='everygrid-pagination-controls'>
          {renderBtn('&laquo;', I18n.t('pagination.first'), 1, currentPage === 1)}
          {renderBtn('&lsaquo;', I18n.t('pagination.prev'), Math.max(1, currentPage - 1), currentPage === 1)}
          {/* Numbered pages hide below 720px of bar width, leaving just the four arrows: the
              current page and total are already stated by the row count beside them, so repeating
              "3 / 12" here would only crowd the buttons on a phone. */}
          {pages.map((i) => (
            <button
              key={i}
              // hidden! (important), not plain hidden: `.everygrid-pagination-btn` sets display:flex
              // outside any @layer, and an unlayered rule beats a layered utility — so the container
              // query needs `!important` to win. Important always beats normal within author styles,
              // regardless of layers.
              className={`everygrid-pagination-btn @max-[720px]:hidden! ${i === currentPage ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
              disabled={disabled}
              onClick={() => handlePageChange(i)}
            >
              {i}
            </button>
          ))}
          {renderBtn('&rsaquo;', I18n.t('pagination.next'), Math.min(totalPages, currentPage + 1), currentPage === totalPages)}
          {renderBtn('&raquo;', I18n.t('pagination.last'), totalPages, currentPage === totalPages)}
        </div>
      )}
    </div>
  );
};
