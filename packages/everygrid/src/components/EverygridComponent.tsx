import type {IEverygrid} from '../core/types';
import {useEffect, useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {EmptyGridPlaceholder} from './EmptyGridPlaceholderComponent.tsx';
import {GridToolbarComponent} from './GridToolbarComponent';
import {GridTableComponent} from './GridTableComponent';
import {PaginationComponent} from './PaginationComponent';
import {ExcelViewWrapperComponent} from './ExcelViewComponent';
import {PinnedTableComponent} from './PinnedTableComponent';
import {I18n} from '../i18n/I18n';

export const EverygridComponent = <T extends Record<string, unknown>>({
                                                                        grid,
                                                                        container,
                                                                      }: {
  grid: IEverygrid<T>;
  container: HTMLElement;
}) => {
  const [, setTick] = useState(0);

  useEffect(() => {
    return grid.subscribe(() => {
      setTick(t => t + 1);
    });
  }, [grid]);

  const containerId = container.id;
  const items = (grid.options.data || []) as T[];
  const streamTotal = grid.getFilteredTotal(containerId);
  // streamTotalRaw: unfiltered total for toolbar/pagination visibility.
  // Priority: JS stream rows > streaming count > WASM raw total > items length
  const streamTotalRaw = grid._streamRows.get(containerId)?.length
    ?? grid._streamTotal.get(containerId)
    ?? grid._wasmRawTotal?.get(containerId)
    ?? items.length;
  // Only show processing overlay during filter/sort (not during initial streaming load)
  // _streamRows present = still in JS streaming phase, no overlay needed
  const isProcessing = (grid._processing.get(containerId) ?? false) && !grid._streamRows.has(containerId);
  const exportState = grid.exportState.get(containerId);
  const isExporting = !!exportState;
  // isIndexing: only for streaming grids while the data is being loaded/indexed into WASM.
  const indexingStage = grid._indexingStage?.get(containerId);
  const isStreamingGrid = grid._wasStreaming?.has(containerId) ?? false;
  // A query-ready page exists once applyWasmFilter has populated the page cache.
  const hasReadyPage = grid._wasmPageCache?.has(containerId) ?? false;
  // Stay in the indexing state for the WHOLE window — from stream start until the engine
  // has produced its first query-ready page. Gating on the stage flag alone was too coarse:
  // during the stream→WASM handoff the page cache can populate while the stage is still
  // 'indexing', and the stage flips to 'ready' ~400ms before the bar hides, so the grid
  // would flash into view mid-handoff and then hide again. Requiring both a 'ready' stage
  // AND a ready page makes the hidden→visible transition atomic and consistent.
  const isIndexing = isStreamingGrid && (indexingStage === 'indexing' || !hasReadyPage);
  const indexingProgress = grid._indexingProgress?.get(containerId) ?? 0;

  // Progress-pill text shown in the toolbar's search slot (undefined = show the search box).
  const statusText = (isExporting && exportState)
    ? (exportState.total > 0
        ? I18n.t('grid.exporting', {done: exportState.done, total: exportState.total})
        : I18n.t('grid.exportPreparing'))
    : isProcessing
      ? I18n.t('grid.processing')
      : isIndexing
        ? (indexingProgress < 0
            ? I18n.t('toolbar.indexingRows', {count: (grid._streamTotal?.get(containerId) ?? 0).toLocaleString()})
            : I18n.t('toolbar.indexingPercent', {percent: indexingProgress}))
        : undefined;

  // Cancel is only meaningful for the abortable worker export (total > 0); the small
  // synchronous DOM path (total === 0) blocks the main thread and can't be aborted.
  const onCancelExport = (isExporting && exportState && exportState.total > 0)
    ? () => grid.cancelExport(containerId)
    : undefined;

  const displayItems = grid.getDisplayItems(containerId, items);
  const columns = grid.getColumns(containerId, items);
  const dataFields = grid.getDataFields(containerId);
  const currentWidths = grid.getCurrentWidths(containerId);
  const editableFields = grid.getEditableFields(containerId);
  const pagination = grid.getPagination(containerId);
  const colorConfig = grid.options.colors?.find(conf => conf.id === containerId);
  const gridTitle = grid.getGridTitle(containerId);


  useLayoutEffect(() => {
    grid.syncRowHeights(container);
  });

  useEffect(() => {
    if (colorConfig) {
      if (colorConfig.font?.header) container.style.setProperty('--everygrid-header-color', colorConfig.font.header);
      if (colorConfig.bg?.header) container.style.setProperty('--everygrid-header-bg', colorConfig.bg.header);
      if (colorConfig.font?.body) container.style.setProperty('--everygrid-body-color', colorConfig.font.body);
      if (colorConfig.bg?.body) container.style.setProperty('--everygrid-body-bg', colorConfig.bg.body);
    }
  }, [colorConfig, container, grid]);


  // Excel View Mode
  if (grid.isExcelViewMode) {
    const toolbar = (
      <div className="everygrid-toolbar-container px-2 shrink-0">
        <GridToolbarComponent
          isExcelViewMode={grid.isExcelViewMode}
          isExporting={isExporting}
          statusText={statusText}
          onCancelExport={onCancelExport}
          onToggleExcelView={() => grid.toggleExcelViewMode(container)}
          onResetWidths={() => grid.resetColumnWidths(container)}
          onShowColumnSelector={() => grid.showColumnSelector(dataFields, container)}
          onShowHiddenColumnSelector={() => grid.showHiddenColumnSelector(container)}
          onDownloadExcel={(scope) => { void grid.exportExcel(containerId, scope); }}
          filteredCount={streamTotal}
          allCount={streamTotalRaw}
          // Only grids created from a URL/fetcher can re-fetch; the rest get no button.
          onReloadData={grid._dataSource?.has(containerId) ? () => { void grid.reloadData(containerId); } : undefined}
          isReloading={grid._reloading?.get(containerId) ?? false}
          onReset={() => grid.reset(container)}
          onResetSort={() => grid.resetSort(container)}
          hasChanges={grid.checkHasChanges()}
          hiddenFields={grid.hiddenFieldsMap.get(containerId) || new Set()}
          sortInfo={grid.sortConfig.get(containerId)}
          filterText={grid.filterText}
          onFilter={(text) => grid.setFilter(text, container)}
          wasmReady={grid.wasmReady}
        />
      </div>
    );
    return (
      <div className="everygrid-wrapper relative bg-white overflow-hidden flex flex-col border-b border-slate-200 pb-2">
        <div className="flex-1 min-h-0">
          <ExcelViewWrapperComponent data={displayItems} toolbar={toolbar}/>
        </div>
      </div>
    );
  }

  // Normal View
  return (
    <div className="everygrid-wrapper relative bg-white overflow-hidden flex flex-col border-b border-slate-200 pb-2">
      <div className="flex-1 flex flex-col min-h-0 pt-0">
        {/* `|| isIndexing`: the toolbar hosts the progress bar, so it has to be up for the
            whole indexing window — including before a single row exists. Gating on row counts
            alone hid it until the first chunk landed, which on reload (page cache and totals
            cleared on the click) left the grid showing nothing but its title for ~1s. */}
        {items && (items.length > 0 || streamTotalRaw > 0 || isIndexing) ? (
          <div className="everygrid-toolbar-container px-2 shrink-0">
            <GridToolbarComponent
              gridTitle={gridTitle}
              isExporting={isExporting}
              statusText={statusText}
              onCancelExport={onCancelExport}
              hasCustomWidths={currentWidths.size > 0}
              isExcelViewMode={grid.isExcelViewMode}
              onToggleExcelView={() => grid.toggleExcelViewMode(container)}
              onResetWidths={() => grid.resetColumnWidths(container)}
              onShowColumnSelector={() => grid.showColumnSelector(dataFields, container)}
              onShowHiddenColumnSelector={() => grid.showHiddenColumnSelector(container)}
              onDownloadExcel={(scope) => { void grid.exportExcel(containerId, scope); }}
              filteredCount={streamTotal}
              allCount={streamTotalRaw}
              // Only grids created from a URL/fetcher can re-fetch; the rest get no button.
              onReloadData={grid._dataSource?.has(containerId) ? () => { void grid.reloadData(containerId); } : undefined}
              isReloading={grid._reloading?.get(containerId) ?? false}
              onReset={() => grid.reset(container)}
              onResetSort={() => grid.resetSort(container)}
              hasChanges={grid.checkHasChanges()}
              hiddenFields={grid.hiddenFieldsMap.get(containerId) || new Set()}
              sortInfo={grid.sortConfig.get(containerId)}
              filterText={grid.filterText}
              onFilter={(text) => grid.setFilter(text, container)}
              wasmReady={grid.wasmReady}
              isIndexing={isIndexing}
            />
          </div>
        ) : gridTitle ? (
          <div className="px-3 py-1 text-[11px] font-bold text-slate-500 uppercase tracking-wider shrink-0 bg-white">
            {gridTitle}
          </div>
        ) : (
          <div className="shrink-0">
            <EmptyGridPlaceholder targetId={containerId}/>
          </div>
        )}

        {!isIndexing && pagination && pagination.active !== false && (pagination.position === 'top' || pagination.position === 'all') && (
          <div className="everygrid-pagination-top shrink-0">
            <PaginationComponent
              grid={grid}
              container={container}
              currentPage={grid.getCurrentPage(containerId)}
              totalPages={grid.getTotalPages(containerId)}
              totalItems={grid.getFilteredTotal(containerId)}
              totalCount={streamTotalRaw || items.length}
              pageSize={pagination.pageSize || 10}
            />
          </div>
        )}

        {/* While indexing, fill the body with a skeleton placeholder (real rows aren't ready yet).
            The toolbar keeps the progress pill; this area holds the layout space. */}
        {isIndexing ? (
          <div className="relative w-full flex-1 min-h-0 overflow-hidden">
            <EmptyGridPlaceholder targetId={containerId} indexing/>
          </div>
        ) : (
          <div
            className={`relative w-full flex-1 min-h-0 flex flex-col overflow-hidden ${grid.pinnedColumns.size > 0 ? 'has-pinned' : ''}`}
          >
            <div
              className="flex w-full h-full"
            >
              {grid.pinnedColumns.size > 0 && (
                <PinnedTableComponent
                  instance={grid}
                  columns={columns}
                  displayItems={displayItems}
                  container={container}
                  containerId={containerId}
                  editableFields={editableFields}
                  filterText={grid.filterText}
                  isIndexing={isIndexing}
                  isExporting={isExporting}
                />
              )}
              <GridTableComponent
                grid={grid}
                columns={columns}
                displayItems={displayItems}
                container={container}
                containerId={containerId}
                editableFields={editableFields}
                currentWidths={currentWidths}
                filterText={grid.filterText}
                isIndexing={isIndexing}
                isExporting={isExporting}
              />
            </div>
          </div>
        )}

        {!isIndexing && pagination && pagination.active !== false && (pagination.position === 'bottom' || pagination.position === 'all' || (!pagination.position && (streamTotal > 0 || streamTotalRaw > 0))) && (
          <div className="everygrid-pagination-bottom shrink-0">
            <PaginationComponent
              grid={grid}
              container={container}
              currentPage={grid.getCurrentPage(containerId)}
              totalPages={grid.getTotalPages(containerId)}
              totalItems={grid.getFilteredTotal(containerId)}
              totalCount={streamTotalRaw || items.length}
              pageSize={pagination?.pageSize || items.length}
            />
          </div>
        )}
      </div>
      {grid.activePopup && createPortal(grid.activePopup, document.body)}
    </div>
  );
};
