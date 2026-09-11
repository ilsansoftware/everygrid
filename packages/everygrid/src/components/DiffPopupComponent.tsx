import {useEffect} from 'react';
import {I18n} from '../i18n/I18n';
import {Everygrid} from '../core/Everygrid';
import type {RowChange} from '../core/GridHandle';

const STATUS_CLASS: Record<RowChange['status'], string> = {
  inserted: 'bg-emerald-100 text-emerald-800',
  updated: 'bg-amber-100 text-amber-800',
  deleted: 'bg-red-100 text-red-800',
};

const show = (v: unknown) => v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

interface DiffPopupProps<T extends Record<string, unknown>> {
  grid: Everygrid<T>;
  containerId: string;
  onClose: () => void;
}

/**
 * Original vs current, read-only, from the grid's own change tracking: one block per changed row
 * (status, key, index) — an updated row lists each changed cell before → after, an inserted or
 * deleted row its fields. The toolbar's "diff" button opens it.
 */
export const DiffPopupComponent = <T extends Record<string, unknown>>({grid, containerId, onClose}: DiffPopupProps<T>) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changes = grid._changedRows(containerId);
  const cells = changes.reduce((n, r) => n + r.cells.length, 0);
  const label = (field: string) => grid.columnLabel(field, containerId);

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
        <div className='everygrid-popup-body flex-1 overflow-auto'>
          {changes.length === 0 && <p className='text-sm text-slate-500'>{I18n.t('grid.noChanges')}</p>}
          {changes.map((r) => (
            <div key={`${r.status}-${r.index}`} className='everygrid-diff-row'>
              <div className='everygrid-diff-row-head'>
                <span className={`everygrid-diff-status ${STATUS_CLASS[r.status]}`}>{r.status}</span>
                {r.key !== null
                  ? <span className='font-medium text-slate-800'>key {show(r.key)}</span>
                  : <span className='font-medium text-slate-500'>{I18n.t('grid.newRow')}</span>}
                <span className='text-xs text-slate-500'>#{r.index}</span>
              </div>
              <table className='everygrid-diff-table'>
                <tbody>
                {r.status !== 'updated'
                  ? Object.entries(r.status === 'deleted' ? r.original : r.row)
                      .filter(([, v]) => v !== null && v !== undefined && v !== '')
                      .map(([field, v]) => (
                        <tr key={field}>
                          <td className='everygrid-diff-field'>{label(field)}</td>
                          <td className={r.status === 'deleted' ? 'everygrid-diff-from' : 'everygrid-diff-to'} colSpan={3}>{show(v)}</td>
                        </tr>
                      ))
                  : r.cells.map((c) => (
                    <tr key={c.field}>
                      <td className='everygrid-diff-field'>{label(c.field)}</td>
                      <td className='everygrid-diff-from'>{show(c.from)}</td>
                      <td className='everygrid-diff-arrow'>→</td>
                      <td className='everygrid-diff-to'>{show(c.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
