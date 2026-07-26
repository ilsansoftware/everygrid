import React from 'react';
import {type IEverygrid} from './types';

export const createResizeHandler = <T extends Record<string, unknown>>(
  grid: IEverygrid<T>,
  containerId: string,
  container: HTMLElement,
  requireTableContainer: boolean = false,
) => {
  const startResize = (startX: number, th: HTMLElement, field: string) => {
    const startWidth = th.offsetWidth;
    const table = th.closest('table');
    if (!table) return;

    // For the main table, keep it from shrinking below its scroll container so narrowing a column
    // never makes the whole grid smaller (the freed space is absorbed within the table instead).
    let tableContainer: HTMLElement | null = null;
    if (requireTableContainer) {
      tableContainer = th.closest('.everygrid-table-container') as HTMLElement | null;
      if (!tableContainer) return;
    }

    const allThs = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
    allThs.forEach(headerTh => {
      if (!headerTh.style.width) {
        headerTh.style.width = `${headerTh.offsetWidth}px`;
      }
    });

    table.classList.add('is-resizing');
    table.style.tableLayout = 'fixed';
    const startTableWidth = table.offsetWidth;
    table.style.width = `${startTableWidth}px`;
    table.style.minWidth = '0px';

    const onMove = (currentX: number) => {
      const deltaX = currentX - startX;
      const newWidth = Math.max(30, startWidth + deltaX);
      // Track the table width by the column's actual change so a sole column (e.g. a single
      // pinned column) can shrink — a fixed table width would otherwise force it to fill it.
      const applied = newWidth - startWidth;
      grid.updateColumnWidth(containerId, field, newWidth);
      th.style.width = `${newWidth}px`;
      th.style.minWidth = `${newWidth}px`;
      // Main table: never below the container width (grid keeps its size); pinned table: free to shrink.
      const nextWidth = tableContainer
        ? Math.max(startTableWidth + applied, tableContainer.clientWidth)
        : startTableWidth + applied;
      table.style.width = `${nextWidth}px`;
    };

    const cleanup = () => {
      table.classList.remove('is-resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mouseleave', onMouseLeave);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.body.style.cursor = '';
    };

    const onMouseMove = (moveEvent: MouseEvent) => onMove(moveEvent.pageX);
    const onMouseUp = () => {
      cleanup();
      grid.renderGrid(container);
    };
    const onMouseLeave = () => {
      cleanup();
      grid.renderGrid(container);
    };
    const onTouchMove = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length > 0) onMove(moveEvent.touches[0].pageX);
    };
    const onTouchEnd = () => {
      cleanup();
      grid.renderGrid(container);
    };

    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('touchmove', onTouchMove, {passive: false});
    document.addEventListener('touchend', onTouchEnd);
  };

  return (e: React.MouseEvent | React.TouchEvent, field: string) => {
    // No e.preventDefault() here — it warns on passive touch listeners.

    // Safely read pageX whether this is a touch or a mouse event.
    const startX = 'touches' in e && e.touches.length > 0
      ? e.touches[0].pageX : (e as unknown as MouseEvent).pageX;

    const th = (e.target as HTMLElement).closest('th');
    if (!th) return;
    startResize(startX, th, field);
  };
};
