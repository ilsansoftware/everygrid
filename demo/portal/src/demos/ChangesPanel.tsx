import {useEffect, useState} from 'react';
import {Everygrid, type RowPatch} from '@everygrid/grid';

/**
 * Change tracking through the handle API: `Everygrid.get(id)` is a grid → row → cell cursor, and
 * `patch()` is what a save would send. Edit a cell in the grid above (or press "edit via API") and
 * watch the patch; revert or commit from here.
 */
export default function ChangesPanel({gridId}: { gridId: string }) {
  const [patch, setPatch] = useState<RowPatch[]>([]);

  useEffect(() => {
    // The grid mounts asynchronously, so poll once until its handle exists, then subscribe.
    let off = () => {};
    const timer = setInterval(() => {
      const g = Everygrid.get(gridId);
      if (!g) return;
      clearInterval(timer);
      setPatch(g.patch());
      off = g.on('change', () => setPatch(g.patch()));
    }, 200);
    return () => { clearInterval(timer); off(); };
  }, [gridId]);

  const editViaApi = () => {
    const g = Everygrid.get(gridId);
    if (!g) return;
    const age = g.row(0).cell('age');            // first row, "age" column
    age.set(Number(age.get()) + 1);
    g.rowByKey(2).set({category: 'Ops'});         // row whose rowKey (id) is 2
  };

  return (
      <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm'>
        <div className='flex items-center gap-3'>
          <span className='font-medium text-slate-800'>Changes</span>
          <span className='text-slate-500'>{patch.length} row{patch.length === 1 ? '' : 's'}</span>
          <button type='button' className='ml-auto rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100'
                  onClick={editViaApi}>edit via API</button>
          <button type='button' className='rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-40'
                  disabled={patch.length === 0} onClick={() => Everygrid.get(gridId)?.revert()}>revert</button>
          <button type='button' className='rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700 disabled:opacity-40'
                  disabled={patch.length === 0} onClick={() => Everygrid.get(gridId)?.commit()}>commit</button>
        </div>
        <pre className='mt-3 max-h-40 overflow-auto rounded bg-white p-3 font-mono text-xs text-slate-700'>
          {patch.length ? JSON.stringify(patch, null, 2) : '// patch(): nothing changed yet'}
        </pre>
      </div>
  );
}
