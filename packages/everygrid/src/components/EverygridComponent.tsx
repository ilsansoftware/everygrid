import type {IEverygrid} from '../core/types';
import {cloneElement, useEffect, useLayoutEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {EmptyGridPlaceholder} from './EmptyGridPlaceholderComponent.tsx';
import {GridToolbarComponent} from './GridToolbarComponent';
import {GridTableComponent} from './GridTableComponent';
import {PaginationComponent} from './PaginationComponent';
import {RowCountComponent} from './RowCountComponent';
import {EXCEL_PAGE_SIZE, ExcelViewWrapperComponent} from './ExcelViewComponent';
import {PinnedTableComponent} from './PinnedTableComponent';
import {PopupComponent} from './PopupComponent';
import {NestedTableComponent} from './NestedTableComponent';
import {makeElementGate} from '../core/highlightUtils';
import {useVirtualWindow} from '../core/useVirtualWindow';
import {InfoIcon} from '../icons/InfoIcon';
import {I18n} from '../i18n/I18n';

const DEFAULT_ROW_HEIGHT = 36;
const DEFAULT_OVERSCAN = 6;

export const EverygridComponent = <T extends Record<string, unknown>>({
                                                                        grid,
                                                                        container,
                                                                      }: {
  grid: IEverygrid<T>;
  container: HTMLElement;
}) => {
  const [, setTick] = useState(0);
  // The Excel preview pages through the result on its own axis, independent of the grid's page.
  // Stored with the result it belongs to (see excelKey) rather than reset from an effect, which
  // would cost an extra render landing on page 0.
  const [excelPageState, setExcelPageState] = useState({key: '', page: 0});
  // Virtual grids scroll their preview instead of paging it, growing this count as it nears the end.
  const [excelLoadedState, setExcelLoadedState] = useState({key: '', count: 0});

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
  // A live stream count of 0 falls through rather than winning: during a reload it would report
  // an empty grid over rows that are still on screen, hiding the pagination and the row count.
  const streamTotalRaw = grid._streamRows.get(containerId)?.length
    ?? (grid._streamTotal.get(containerId) || undefined)
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
  // isLoading covers every load path — streaming, buffered fetch, fetcher function — so the body
  // below can decide skeleton vs content by one rule instead of per-path flags. Without it a
  // grid whose payload came back small flashed the "no data" placeholder mid-load.
  const isLoading = isIndexing || (grid._loading?.has(containerId) ?? false);

  // Progress-pill text shown in the toolbar's search slot (undefined = show the search box).
  const statusText = (isExporting && exportState)
    ? (exportState.total > 0
        ? I18n.t('grid.exportingPercent', {percent: Math.min(100, Math.round((exportState.done / exportState.total) * 100))})
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

  // Numeric progress (0–100) for the in-search-box loading bar; -1 = indeterminate.
  const progress = (isExporting && exportState)
    ? (exportState.total > 0 ? Math.min(100, Math.round((exportState.done / exportState.total) * 100)) : -1)
    : isProcessing ? -1
      : isIndexing ? indexingProgress
        : -1;

  // --- Virtual scrolling ---------------------------------------------------------------------
  // Off for this target => virtualConf is undefined and the hook runs against 0 rows, so the
  // window is empty and nothing below this point changes. The hook itself stays unconditional.
  const virtualConf = grid.getVirtualScroll(containerId);
  const rowHeight = virtualConf?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const overscan = virtualConf?.overscan ?? DEFAULT_OVERSCAN;
  const {scrollerRef, onScroll, scrollToTop, window: vwin} = useVirtualWindow(
    virtualConf ? streamTotal : 0, rowHeight, overscan,
  );

  const displayItems = virtualConf
    ? grid.getRowsInRange(containerId, vwin.start, vwin.end)
    : grid.getDisplayItems(containerId, items);
  const virtual = virtualConf
    ? {topPad: vwin.topPad, bottomPad: vwin.bottomPad, rowHeight}
    : undefined;

  const sortInfo = grid.sortConfig.get(containerId);
  const sortKey = sortInfo ? `${sortInfo.field}:${sortInfo.direction}` : '';
  useEffect(() => {
    scrollToTop();
  }, [grid.filterText, sortKey, scrollToTop]);

  // Keyed to the result it belongs to: a filter or sort change drops back to page 1, while
  // leaving and re-entering the preview returns to the page you were on. Clamped on read, so a
  // page that no longer exists (a smaller result) resolves to the last one.
  const excelKey = `${grid.isExcelViewMode}|${grid.filterText}|${sortKey}`;
  const excelPage = excelPageState.key === excelKey ? excelPageState.page : 0;
  const setExcelPage = (page: number) => setExcelPageState({key: excelKey, page});
  const excelLoaded = excelLoadedState.key === excelKey ? excelLoadedState.count : 0;

  // Three states, one source of truth, so every part of the grid agrees:
  //  - showSkeleton: nothing to show yet. The only case the body is replaced.
  //  - isBusy: something is in flight (load OR filter/sort). Everything visible stays put and
  //    goes inert together — overlay, toolbar icons, sort icons, pagination.
  //  - showEmpty: settled with no data at all. No toolbar either; there is nothing to act on.
  const showSkeleton = isLoading && displayItems.length === 0;
  const isBusy = isLoading || isProcessing;
  const showEmpty = !isLoading && items.length === 0 && streamTotalRaw === 0;
  const searchKeys = grid.getSearchKeys(containerId, displayItems);
  const columns = grid.getColumns(containerId, items);
  const dataFields = grid.getDataFields(containerId);
  const currentWidths = grid.getCurrentWidths(containerId);
  const editableFields = grid.getEditableFields(containerId);
  const pagination = grid.getPagination(containerId);
  const colorConfig = grid.options.colors?.find(conf => conf.id === containerId);
  const gridTitle = grid.getGridTitle(containerId);
  const dataLimited = grid._dataLimited?.get(containerId);


  useLayoutEffect(() => {
    // Virtual rows are a fixed height by definition, and both tables emit identical spacers, so
    // they are already aligned — measuring them would only cost a layout pass per frame.
    if (!virtualConf) grid.syncRowHeights(container);
    if (virtualConf) container.style.setProperty('--everygrid-row-height', `${rowHeight}px`);
  });

  useEffect(() => {
    if (colorConfig) {
      if (colorConfig.font?.header) container.style.setProperty('--everygrid-header-color', colorConfig.font.header);
      if (colorConfig.bg?.header) container.style.setProperty('--everygrid-header-bg', colorConfig.bg.header);
      if (colorConfig.font?.body) container.style.setProperty('--everygrid-body-color', colorConfig.font.body);
      if (colorConfig.bg?.body) container.style.setProperty('--everygrid-body-bg', colorConfig.bg.body);
    }
  }, [colorConfig, container, grid]);


  // What the row count describes: the page's slice when the grid is paged, and the whole filtered
  // result when it is not (virtual grids and single-page grids show all of it at once).
  const totalPages = grid.getTotalPages(containerId);
  const countPageSize = (!virtualConf && pagination?.pageSize && pagination.pageSize > 0)
    ? pagination.pageSize : 0;
  const isPaged = countPageSize > 0 && pagination?.active !== false;
  const currentPageNo = grid.getCurrentPage(containerId);
  const countStart = streamTotal === 0 ? 0 : (isPaged ? (currentPageNo - 1) * countPageSize + 1 : 1);
  const countEnd = isPaged ? Math.min(currentPageNo * countPageSize, streamTotal) : streamTotal;

  // Where the grid places its pagination — top, bottom, both. The Excel preview reads the same
  // flags so its own pager lands where the grid's would, and toggling into the preview doesn't
  // move the controls around. Defined here (not just before the normal-view return) because the
  // Excel branch below needs them too.
  const paginationActive = !showSkeleton && !virtualConf && !!pagination && pagination.active !== false;
  const hasTopPagination = paginationActive &&
    (pagination!.position === 'top' || pagination!.position === 'all');
  const hasBottomPagination = paginationActive &&
    (pagination!.position === 'bottom' || pagination!.position === 'all' ||
      (!pagination!.position && (streamTotal > 0 || streamTotalRaw > 0)));

  // Excel View Mode
  if (grid.isExcelViewMode) {
    // The preview pages through the entire result rather than showing a truncated head — that is
    // what removed the old "only the top 50 are shown" banner, and with it the mismatch between
    // the rows on screen and the number the banner quoted. Pages come straight off the engine, so
    // this is the same for a paged, virtual or unpaged grid.
    // The preview navigates the way the grid itself does: a paged grid gets pages of its own page
    // size, a virtual grid keeps scrolling. Either way the whole result is reachable.
    const excelPageSize = isPaged ? countPageSize : EXCEL_PAGE_SIZE;
    const excelScrolls = !!virtualConf;
    const excelTotalPages = Math.max(1, Math.ceil(streamTotal / excelPageSize));
    const pageIndex = Math.min(excelPage, excelTotalPages - 1);
    // Scrolling previews always start at the top of the result and grow downwards; paged ones show
    // exactly their page.
    const from = excelScrolls ? 0 : pageIndex * excelPageSize;
    const to = excelScrolls
      ? Math.min(streamTotal, Math.max(excelPageSize, excelLoaded))
      : Math.min(streamTotal, from + excelPageSize);

    // Pull in the next chunk as the body nears its end. The margin is a screenful, so the rows are
    // already there by the time the reader arrives.
    const onExcelScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
      if (!excelScrolls || to >= streamTotal) return;
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - el.clientHeight) {
        setExcelLoadedState({key: excelKey, count: Math.min(streamTotal, to + excelPageSize)});
      }
    };
    const pageRows = grid.getRowsInRange(containerId, from, to);
    // Rows whose block is still in flight come back as holes; take the contiguous run and let the
    // arrival re-render the rest rather than rendering gaps.
    const firstGap = pageRows.findIndex(r => r === undefined);
    const settled = (firstGap === -1 ? pageRows : pageRows.slice(0, firstGap)) as T[];
    // Cold start on the first page: the block has not arrived yet, so stand in with the rows
    // already on screen instead of flashing an empty preview.
    const excelItems = settled.length > 0
      ? settled
      : (pageIndex === 0 ? displayItems.filter((r): r is T => r !== undefined) : []);

    // One bar builder for both ends, so the preview's chrome matches the normal view: a row count
    // always, and the preview's own pager at whichever end the grid paginates (never for a
    // scrolling preview, which has no pages). `place` picks the panel classes that frame that end.
    const excelBar = (place: 'top' | 'bottom') => {
      const showPager = !excelScrolls && (place === 'top' ? hasTopPagination : hasBottomPagination);
      const frame = place === 'top'
        ? 'everygrid-pagination-top everygrid-panel-above-body everygrid-panel-strip'
        : 'everygrid-pagination-bottom everygrid-panel-below-body everygrid-panel-bottom';
      return (
        <div className={`shrink-0 everygrid-panel ${frame}`}>
          <RowCountComponent
            start={streamTotal === 0 ? 0 : from + 1}
            end={from + excelItems.length}
            total={streamTotal}
            rawTotal={streamTotalRaw || items.length}
          />
          {showPager && (
            <PaginationComponent
              grid={grid}
              container={container}
              currentPage={pageIndex + 1}
              totalPages={excelTotalPages}
              disabled={isBusy}
              onPageChange={(page) => setExcelPage(page - 1)}
            />
          )}
        </div>
      );
    };
    const toolbar = (
      <div className="everygrid-toolbar-container px-2 shrink-0 everygrid-panel everygrid-panel-top everygrid-panel-above-body">
        <GridToolbarComponent
          isExcelViewMode={grid.isExcelViewMode}
          isExporting={isExporting}
          statusText={statusText}
          progress={progress}
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
          searchKeys={searchKeys}
          labelOf={(k) => grid.columnLabel(k, containerId)}
          wasmReady={grid.wasmReady}
        />
      </div>
    );
    return (
      // Same shell as the normal view, so toggling the preview swaps content inside the grid's
      // existing box instead of producing a differently shaped block in its place.
      <div className="everygrid-wrapper relative bg-white overflow-hidden flex flex-col pb-2">
        <div className="flex-1 flex flex-col min-h-0">
          <ExcelViewWrapperComponent
            data={excelItems}
            toolbar={toolbar}
            header={excelBar('top')}
            footer={excelBar('bottom')}
            onBodyScroll={excelScrolls ? onExcelScroll : undefined}
          />
        </div>
      </div>
    );
  }


  // Virtual grids have no pagination bar to hold the count, so they always use the strip.
  const rowCountMode = virtualConf ? 'strip' : (pagination?.rowCount ?? 'strip');
  const rowCountData = {
    start: countStart,
    end: countEnd,
    total: streamTotal,
    rawTotal: streamTotalRaw || items.length,
  };

  // 'inline' hands the count to the pagination bar — but only at an end that actually has one.
  // Where there is no bar, the panel draws the count itself so both ends always carry it.
  const topInlineCount = rowCountMode === 'inline' && hasTopPagination;
  const bottomInlineCount = rowCountMode === 'inline' && hasBottomPagination;

  // Both tables take the same inputs; virtual mode just renders each of them twice, once per
  // half. Bundled so the header and the body cannot drift apart through a missed prop.
  const commonTableProps = {
    columns,
    displayItems,
    container,
    containerId,
    editableFields,
    filterText: grid.filterText,
    isIndexing: isBusy,
    isExporting,
    startIndex: vwin.start,
    virtual,
  };
  const pinnedProps = {instance: grid, ...commonTableProps};
  const mainProps = {grid, currentWidths, ...commonTableProps};

  // Normal View
  return (
    <div className="everygrid-wrapper relative bg-white overflow-hidden flex flex-col pb-2">
      <div className="flex-1 flex flex-col min-h-0 pt-0">
        {/* The toolbar stays up while loading — it hosts the search box, title and the progress
            pill. A settled empty grid gets none of it: search, sort reset, column selection and
            export all act on rows that don't exist. */}
        {!showEmpty && <div className={`everygrid-toolbar-container px-2 shrink-0 everygrid-panel everygrid-panel-top`}>
          <GridToolbarComponent
            gridTitle={gridTitle}
            isExporting={isExporting}
            statusText={statusText}
            progress={progress}
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
            searchKeys={searchKeys}
          labelOf={(k) => grid.columnLabel(k, containerId)}
            wasmReady={grid.wasmReady}
            isIndexing={isBusy}
          />
        </div>}

        {/* The strip under the toolbar is always here, whether or not top pagination is configured.
            Two reasons: a grid's chrome is then the same height either way, and the search
            suggestions have a band to open into before they reach the column headers — without it
            the dropdown lands straight on top of the columns. */}
        {!showEmpty && (
          <div className="everygrid-pagination-top shrink-0 everygrid-panel everygrid-panel-above-body everygrid-panel-strip">
            {!topInlineCount && <RowCountComponent {...rowCountData}/>}
            {hasTopPagination && <PaginationComponent
              grid={grid}
              container={container}
              currentPage={currentPageNo}
              totalPages={totalPages}
              disabled={isBusy}
              rowCount={topInlineCount ? rowCountData : undefined}
            />}
          </div>
        )}

        {/* dataLimit banner: the load was capped for this device, so state it plainly instead of
            silently showing a partial dataset. Persistent — it is a standing fact about the data,
            not a transient status. */}
        {!showSkeleton && dataLimited && (
          <div className="everygrid-data-limit-banner shrink-0">
            <InfoIcon/>
            <span>{dataLimited.total != null
              ? I18n.t('grid.dataLimited', {shown: dataLimited.shown.toLocaleString(), total: dataLimited.total.toLocaleString()})
              : I18n.t('grid.dataLimitedStream', {shown: dataLimited.shown.toLocaleString()})}</span>
          </div>
        )}

        {/* One rule for every grid, whatever load path it took: while a load is in flight, show
            the skeleton only if there is nothing to show yet. Rows already on screen (a reload,
            or a second load) stay up and the progress lives in the toolbar pill — the body never
            collapses out from under data that is still valid. */}
        {showSkeleton ? (
          <div className="relative w-full flex-1 min-h-0 overflow-hidden">
            <EmptyGridPlaceholder targetId={containerId} indexing/>
          </div>
        ) : showEmpty ? (
          <div className="relative w-full flex-1 min-h-0 overflow-hidden">
            <EmptyGridPlaceholder targetId={containerId}/>
          </div>
        ) : (
          <div
            // isolate: the body layers a busy overlay over pinned columns over the sticky header.
            // Without a stacking context of its own those numbers compete with everything else on
            // the page — including popups, which portal to <body> and so lost to the grid's own
            // chrome. Isolated, the in-body band only orders against itself; see the stacking
            // scale at the top of Everygrid.css.
            className={`relative w-full flex-1 min-h-0 flex flex-col overflow-hidden isolate ${grid.pinnedColumns.size > 0 ? 'has-pinned' : ''}`}
          >
            {/* inert takes the whole table out of the tab order and kills its events, so cell
                inputs, links and edit buttons go dead with the rest instead of staying reachable
                by keyboard underneath the overlay. Header controls also carry `disabled` for the
                greyed-out look — inert alone changes nothing visually. */}
            {/* One scroller, header sticky inside it — the original arrangement. What stops a row
                surfacing at the very top is the toolbar above: it overlaps this element's first
                couple of pixels (see .everygrid-toolbar-roof), so the seam is covered by an
                opaque element rather than defended by the header's own painting. */}
            <div
              ref={virtualConf ? scrollerRef : undefined}
              onScroll={virtualConf ? onScroll : undefined}
              className={`flex w-full h-full ${virtualConf ? 'everygrid-virtual-scroller' : ''}`}
              inert={isBusy}
            >
              {grid.pinnedColumns.size > 0 && (
                <PinnedTableComponent {...pinnedProps}/>
              )}
              <GridTableComponent {...mainProps}/>
            </div>
            {/* Rows on screen are stale until the operation lands, so the body goes inert as a
                whole rather than leaving the user to discover which controls still respond.
                z-60 is the top of the in-body band (see the stacking scale in Everygrid.css) —
                the overlay has to clear both headers, or sort/resize/pin stay live over frozen
                data. */}
            {isBusy && (
              <div className="absolute inset-0 z-60 bg-white/60 cursor-progress" aria-hidden="true"/>
            )}
            {/* Columns exist but no rows to show — an empty result (filtered out) or an empty
                dataset. Overlaid on the body so the header stays visible. */}
            {displayItems.length === 0 && !isProcessing && (
              <div className="absolute inset-0 top-8 flex flex-col items-center justify-center gap-1 text-slate-400 pointer-events-none bg-slate-50/30">
                <span className="text-sm font-medium italic">
                  {grid.filterText ? I18n.t('grid.noResults') : I18n.t('grid.noRows')}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Always here, like the strip above: the row count is a property of the data, not of the
            pagination, so a grid without pagination still states what it is showing at both ends. */}
        {!showEmpty && (
          <div className="everygrid-pagination-bottom shrink-0 everygrid-panel everygrid-panel-below-body everygrid-panel-bottom">
            {!bottomInlineCount && <RowCountComponent {...rowCountData}/>}
            {hasBottomPagination && <PaginationComponent
              grid={grid}
              container={container}
              currentPage={currentPageNo}
              totalPages={totalPages}
              disabled={isBusy}
              rowCount={bottomInlineCount ? rowCountData : undefined}
            />}
          </div>
        )}
      </div>
      {/* Clone so each render passes a fresh element reference; otherwise React's same-element
          bailout skips re-rendering the stored popup and it never picks up locale/state changes. */}
      {grid.activePopup && createPortal(cloneElement(grid.activePopup), document.body)}
      {/* Nested-table popup built here so it uses the CURRENT filterText (live highlighting). */}
      {grid.activePopupData && createPortal(
        <PopupComponent onClose={() => grid.closePopup()} title={grid.activePopupTitle || I18n.t('popup.detailTitle')} data={grid.activePopupData.data}>
          <NestedTableComponent
            data={grid.activePopupData.data}
            filterText={grid.filterText}
            elementGate={makeElementGate(grid.activePopupRow ?? grid.activePopupData.data, grid.filterText)}
          />
        </PopupComponent>,
        document.body,
      )}
    </div>
  );
};
