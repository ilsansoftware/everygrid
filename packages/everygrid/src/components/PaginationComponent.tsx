import {I18n} from '../i18n/I18n';
import type {IEverygrid} from '../core/types';
import {useEffect, useRef, useState} from 'react';

export interface PaginationProps<T extends Record<string, unknown>> {
  grid: IEverygrid<T>;
  container: HTMLElement;
  currentPage: number;
  totalPages: number;
  totalItems: number;
  totalCount: number;
  pageSize: number;
  /** Greys the controls out without removing them — used while a reload is in flight. */
  disabled?: boolean;
}

export const PaginationComponent = <T extends Record<string, unknown>>({
                                                                         grid,
                                                                         container,
                                                                         currentPage,
                                                                         totalPages,
                                                                         totalItems,
                                                                         totalCount,
                                                                         pageSize,
                                                                         disabled = false,
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
    grid.setCurrentPage(containerId, page, container);
  };

  const startIdx = totalItems > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const endIdx = Math.min(currentPage * pageSize, totalItems);

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

  const renderBtn = (text: string, title: string, page: number, atEdge: boolean, active: boolean = false) => (
    <button
      className={`everygrid-pagination-btn ${atEdge || disabled ? 'disabled' : ''} ${active ? 'active' : ''}`}
      title={title}
      disabled={atEdge || disabled}
      onClick={() => handlePageChange(page)}
      dangerouslySetInnerHTML={{__html: text}}
    />
  );

  const isFiltered = grid.filterText.length > 0 && totalItems !== totalCount;
  const fmt = (n: number) => n.toLocaleString();

  return (
    <div className="everygrid-pagination" ref={paginationRef}>
      {!isMobile && (
        <div className="everygrid-pagination-info">
          {isFiltered
            ? I18n.t('pagination.showingFiltered', {
                start: fmt(startIdx),
                end: fmt(endIdx),
                filtered: fmt(totalItems),
                total: fmt(totalCount)
              })
            : I18n.t('pagination.showing', {
                start: fmt(startIdx),
                end: fmt(endIdx),
                total: fmt(totalItems)
              })
          }
        </div>
      )}
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
      {isMobile && (
        <div className="everygrid-pagination-info everygrid-pagination-info-mobile">
          {isFiltered
            ? I18n.t('pagination.showingFiltered', {
                start: fmt(startIdx),
                end: fmt(endIdx),
                filtered: fmt(totalItems),
                total: fmt(totalCount)
              })
            : I18n.t('pagination.showing', {
                start: fmt(startIdx),
                end: fmt(endIdx),
                total: fmt(totalItems)
              })
          }
        </div>
      )}
    </div>
  );
};
