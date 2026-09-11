import {useEffect} from 'react';
import type {RowChange} from '@everygrid/grid';

const show = (v: unknown) => v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * Original vs modified, side by side, straight from `Everygrid.get(id).changes()`: one block per
 * changed row (its status, key and index) — a modified row lists each changed cell before → after,
 * an inserted row its values, a deleted row the row that goes. Read-only: a view of `changes()`.
 */
const STATUS = {
  inserted: 'bg-emerald-100 text-emerald-800',
  updated: 'bg-amber-100 text-amber-800',
  deleted: 'bg-red-100 text-red-800',
};
export default function DiffModal({gridId, changes, onClose}: {
  gridId: string;
  changes: RowChange[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cells = changes.reduce((n, r) => n + r.cells.length, 0);

  return (
      <div className='fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4' onClick={onClose}>
        <div className='flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl'
             onClick={(e) => e.stopPropagation()}>
          <div className='flex items-center gap-3 border-b border-slate-200 px-5 py-3'>
            <span className='font-semibold text-slate-800'>Changes · {gridId}</span>
            <span className='text-sm text-slate-500'>{changes.length} rows · {cells} cells</span>
            <button type='button' className='ml-auto text-slate-400 hover:text-slate-700' onClick={onClose} aria-label='Close'>✕</button>
          </div>
          <div className='overflow-auto px-5 py-4 text-sm'>
            {changes.length === 0 && <p className='text-slate-500'>No changes.</p>}
            {changes.map((r) => (
                <div key={r.index} className='mb-4 rounded-lg border border-slate-200'>
                  <div className='flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2'>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${STATUS[r.status]}`}>{r.status}</span>
                    <span className={`font-medium ${r.key === null ? 'text-slate-500' : 'text-slate-800'}`}>{r.key === null ? 'new row' : `key ${show(r.key)}`}</span>
                    <span className='text-xs text-slate-500'>row #{r.index}</span>
                  </div>
                  {/* An inserted or deleted row is listed field by field (the values it has); long
                      values wrap rather than widen the modal. */}
                  {r.status !== 'updated' && (
                      <table className='w-full table-fixed'>
                        <tbody>
                        {Object.entries(r.status === 'deleted' ? r.original : r.row)
                            .filter(([, v]) => v !== null && v !== undefined && v !== '')
                            .map(([field, v]) => (
                                <tr key={field} className='border-b border-slate-100 last:border-0'>
                                  <td className='w-36 px-3 py-1.5 font-mono text-xs text-slate-600'>{field}</td>
                                  <td className={`px-3 py-1.5 font-mono text-xs break-all whitespace-pre-wrap ${r.status === 'deleted' ? 'text-red-700 line-through decoration-red-300' : 'text-emerald-700'}`}>
                                    {show(v)}
                                  </td>
                                </tr>
                            ))}
                        </tbody>
                      </table>
                  )}
                  <table className='w-full table-fixed'>
                    <tbody>
                    {r.cells.map((c) => (
                        <tr key={c.field} className='border-b border-slate-100 last:border-0'>
                          <td className='w-36 px-3 py-1.5 font-mono text-xs text-slate-600'>{c.field}</td>
                          <td className='px-3 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-red-700 line-through decoration-red-300'>{show(c.from)}</td>
                          <td className='w-6 text-center text-slate-400'>→</td>
                          <td className='px-3 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-emerald-700'>{show(c.to)}</td>
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
}
