import {useEffect} from 'react';
import {Everygrid, type RowChange} from '@everygrid/grid';

const show = (v: unknown) => v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * Original vs modified, side by side, straight from `Everygrid.get(id).changes()`: one block per
 * changed row (its status, key and index) — a modified row lists each changed cell before → after,
 * an inserted row its values, a deleted row the row that goes. Each line and each row can be
 * cancelled from here — `g.row(i).cell(f).cancel()` / `g.row(i).cancel()`.
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

  const g = Everygrid.get(gridId);
  const cells = changes.reduce((n, r) => n + r.cells.length, 0);

  return (
      <div className='fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4' onClick={onClose}>
        <div className='flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl'
             onClick={(e) => e.stopPropagation()}>
          <div className='flex items-center gap-3 border-b border-slate-200 px-5 py-3'>
            <span className='font-semibold text-slate-800'>Diff · {gridId}</span>
            <span className='text-sm text-slate-500'>{changes.length} rows · {cells} cells</span>
            <button type='button' className='ml-auto text-slate-400 hover:text-slate-700' onClick={onClose} aria-label='Close'>✕</button>
          </div>
          <div className='overflow-auto px-5 py-4 text-sm'>
            {changes.length === 0 && <p className='text-slate-500'>No changes.</p>}
            {changes.map((r) => (
                <div key={r.index} className='mb-4 rounded-lg border border-slate-200'>
                  <div className='flex items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2'>
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${STATUS[r.status]}`}>{r.status}</span>
                    <span className='font-medium text-slate-800'>key {show(r.key)}</span>
                    <span className='text-xs text-slate-500'>row #{r.index}</span>
                    <button type='button' className='ml-auto text-xs text-slate-500 hover:text-slate-800'
                            onClick={() => g?.row(r.index).cancel()}>cancel row</button>
                  </div>
                  {r.status !== 'updated' && (
                      <div className={`px-3 py-2 font-mono text-xs ${r.status === 'deleted' ? 'text-red-700 line-through decoration-red-300' : 'text-emerald-700'}`}>
                        {show(r.status === 'deleted' ? r.original : r.row)}
                      </div>
                  )}
                  <table className='w-full'>
                    <tbody>
                    {r.cells.map((c) => (
                        <tr key={c.field} className='border-b border-slate-100 last:border-0'>
                          <td className='w-36 px-3 py-1.5 font-mono text-xs text-slate-600'>{c.field}</td>
                          <td className='px-3 py-1.5 font-mono text-xs text-red-700 line-through decoration-red-300'>{show(c.from)}</td>
                          <td className='w-6 text-center text-slate-400'>→</td>
                          <td className='px-3 py-1.5 font-mono text-xs text-emerald-700'>{show(c.to)}</td>
                          <td className='w-16 px-2 text-right'>
                            <button type='button' className='text-xs text-slate-400 hover:text-slate-800'
                                    onClick={() => g?.row(r.index).cell(c.field).cancel()}>cancel</button>
                          </td>
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
