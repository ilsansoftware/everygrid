import {useEffect} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';

interface DiffPopupProps<T extends Record<string, unknown>> {
  grid: Everygrid<T>;
  containerId: string;
  onClose: () => void;
}

/** One line of the diff grid: a changed cell, or one field of an inserted / deleted row. */
interface DiffLine extends Record<string, unknown> {
  status: 'inserted' | 'updated' | 'deleted';
  key: string | number | null;
  row: number;
  field: string;
  from: unknown;
  to: unknown;
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
  const lines: DiffLine[] = [];
  const empty = (v: unknown) => v === null || v === undefined || v === '';
  for (const r of changes) {
    if (r.status === 'updated') {
      for (const c of r.cells) lines.push({status: 'updated', key: r.key, row: r.index, field: c.field, from: c.from, to: c.to});
    } else {
      const source = r.status === 'deleted' ? r.original : r.row;
      for (const [field, v] of Object.entries(source)) {
        if (empty(v)) continue;
        lines.push({status: r.status, key: r.key, row: r.index, field, from: r.status === 'deleted' ? v : null, to: r.status === 'inserted' ? v : null});
      }
    }
  }
  const cells = changes.reduce((n, r) => n + r.cells.length, 0);

  // The diff grid lives for the popup: created once its container exists, destroyed with it.
  useEffect(() => {
    const locale = I18n.getLocale();
    const labels: Record<string, string> = {
      status: I18n.t('grid.diffStatus'), key: I18n.t('grid.diffKey'), row: I18n.t('grid.diffRow'),
      field: I18n.t('grid.diffField'), from: I18n.t('grid.diffFrom'), to: I18n.t('grid.diffTo'),
    };
    const instance = new Everygrid<DiffLine>({
      targets: [{id: diffId, title: I18n.t('toolbar.diff')}],
      data: lines,
      // The popup has its own header; the grid shows just the rows.
      toolbar: [{id: diffId, active: false}],
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
