import {useEffect} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

interface DiffPopupProps<T extends Record<string, unknown>> {
  grid: Everygrid<T>;
  containerId: string;
  onClose: () => void;
}

/**
 * One row of the diff grid — one changed row of the source grid. `diff` is an object the grid
 * shows through its JSON viewer: for an updated row `{field: {from, to}}` per changed cell, for an
 * inserted row the row's values, for a deleted row the row as loaded.
 */
interface DiffLine extends Record<string, unknown> {
  status: 'inserted' | 'updated' | 'deleted';
  key: string | number | null;
  row: number;
  diff: Record<string, unknown>;
}

/**
 * The diff, shown by Everygrid itself: a second, read-only grid mounted inside the popup whose
 * rows are the changes since load — an updated row's cells before → after, an inserted or
 * deleted row field by field. Everything the grid does (search, sort, columns, export) works on
 * the diff too. Destroyed with the popup.
 */
export const DiffPopupComponent = <T extends Record<string, unknown>>({grid, containerId, onClose}: DiffPopupProps<T>) => {
  const diffId = `${containerId}__diff`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changes = grid._changedRows(containerId);
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  const compact = (row: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(row).filter(([, v]) => !empty(v)));
  const lines: DiffLine[] = changes.map(r => ({
    status: r.status,
    key: r.key,
    row: r.index,
    diff: r.status === 'updated'
      ? Object.fromEntries(r.cells.map(c => [c.field, {from: c.from, to: c.to}]))
      : compact(r.status === 'deleted' ? r.original : r.row),
  }));
  const cells = changes.reduce((n, r) => n + r.cells.length, 0);

  // The diff grid lives for the popup: created once its container exists, destroyed with it.
  useEffect(() => {
    const locale = I18n.getLocale();
    const labels: Record<string, string> = {
      status: I18n.t('grid.diffStatus'), key: I18n.t('grid.diffKey'), row: I18n.t('grid.diffRow'),
      diff: I18n.t('grid.diffDiff'),
    };
    // Fixed widths that add up to the popup; the diff object shows as a summary that opens the
    // grid's JSON viewer, so nothing widens the table sideways.
    const widths: Record<string, number> = {status: 100, key: 110, row: 80, diff: 440};
    const instance = new Everygrid<DiffLine>({
      targets: [{id: diffId}],   // no title: the popup header already says what this is
      data: lines,
      columns: Object.keys(widths).map(field => ({field, headerName: labels[field], width: widths[field]})),
      columnI18n: {[locale]: {[diffId]: labels}},
    });
    return () => { instance.destroy(); };
    // The lines are computed from the grid's state at open time; the popup is not live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffId]);

  return (
    <div className={Everygrid.POPUP_OVERLAY_CLASS} onClick={onClose}>
      <div className={`${Everygrid.POPUP_CONTENT_CLASS} everygrid-popup-l everygrid-diff-popup`} onClick={(e) => e.stopPropagation()}>
        <div className='everygrid-popup-header'>
          <h3>
            {I18n.t('toolbar.diff')}
            <span className='everygrid-diff-summary'>
              {I18n.t('grid.diffSummary', {rows: changes.length, cells})}
            </span>
          </h3>
          <span className={Everygrid.POPUP_CLOSE_CLASS} onClick={onClose}
                dangerouslySetInnerHTML={{__html: Everygrid.POPUP_CLOSE_HTML}}></span>
        </div>
        <div className='everygrid-popup-body flex-1 min-h-0 flex flex-col'>
          <div id={diffId} className='everygrid-diff-grid flex-1 min-h-0 flex flex-col'/>
        </div>
      </div>
    </div>
  );
};
