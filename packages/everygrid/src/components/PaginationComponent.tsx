import {I18n} from '../i18n/I18n';
import type {IEverygrid} from '../core/types';
import {useEffect, useRef, useState} from 'react';
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
  const [isMobile, setIsMobile] = useState(false);
  const paginationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = paginationRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setIsMobile(entry.contentRect.width < 720);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handlePageChange = (page: number) => {
    if (onPageChange) onPageChange(page);
    else grid.setCurrentPage(containerId, page, container);
  };

  const maxVisible = isMobile ? 5 : 10;
  const mobileRadius = 2;
  const currentBlock = Math.floor((currentPage - 1) / maxVisible);
  const startPage = isMobile
    ? Math.max(1, currentPage - mobileRadius)
    : currentBlock * maxVisible + 1;
  const endPage = isMobile
    ? Math.min(totalPages, currentPage + mobileRadius)
    : Math.min(totalPages, startPage + maxVisible - 1);

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
    <div className={`everygrid-pagination ${rowCount ? 'has-row-count' : ''}`} ref={paginationRef}>
      {rowCount && !isMobile && <RowCountComponent {...rowCount}/>}
      {totalPages > 1 && (
        <div className={`everygrid-pagination-controls${isMobile ? ' everygrid-pagination-controls-mobile' : ''}`}>
          {renderBtn('&laquo;', I18n.t('pagination.first'), 1, currentPage === 1)}
          {renderBtn('&lsaquo;', I18n.t('pagination.prev'), Math.max(1, currentPage - 1), currentPage === 1)}
          {isMobile && (
            <span className="everygrid-pagination-mobile-info">{currentPage} / {totalPages}</span>
          )}
          {!isMobile && pages.map((i) => (
            <button
              key={i}
              className={`everygrid-pagination-btn ${i === currentPage ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
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
      {/* Narrow bars put the count under the controls instead of beside them. */}
      {rowCount && isMobile && (
        <RowCountComponent {...rowCount} className="everygrid-pagination-info-mobile"/>
      )}
    </div>
  );
};
