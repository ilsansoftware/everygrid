import {useEffect, useState} from 'react';
import {Everygrid, type RowChange} from '@everygrid/grid';
import DiffModal from './DiffModal';

/**
 * Change tracking through the handle API: `Everygrid.get(id)` is a grid → row → cell cursor;
 * `changes()` is every changed row with its cells, and `patch()` what a save would send. Edit a
 * cell in the grid above (or press "edit via API") and watch the patch; open the diff, revert or
 * commit from here.
 */
export default function ChangesPanel({gridId}: { gridId: string }) {
  const [changes, setChanges] = useState<RowChange[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);

  useEffect(() => {
    // The grid mounts asynchronously, so poll once until its handle exists, then subscribe.
    let off = () => {};
    const timer = setInterval(() => {
      const g = Everygrid.get(gridId);
      if (!g) return;
      clearInterval(timer);
      setChanges(g.changes());
      off = g.on('change', setChanges);
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

  const patch = Everygrid.get(gridId)?.patch() ?? [];
  const none = changes.length === 0;
  const btn = 'rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-40';

  return (
      <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm'>
        <div className='flex items-center gap-3'>
          <span className='font-medium text-slate-800'>Changes</span>
          <span className='text-slate-500'>{changes.length} row{changes.length === 1 ? '' : 's'}</span>
          <button type='button' className={`ml-auto ${btn}`} onClick={editViaApi}>edit via API</button>
          <button type='button' className={btn} disabled={none} onClick={() => setDiffOpen(true)}>diff</button>
          <button type='button' className={btn} disabled={none} onClick={() => Everygrid.get(gridId)?.revert()}>revert</button>
          <button type='button' className='rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700 disabled:opacity-40'
                  disabled={none} onClick={() => Everygrid.get(gridId)?.commit()}>commit</button>
        </div>
        <pre className='mt-3 max-h-40 overflow-auto rounded bg-white p-3 font-mono text-xs text-slate-700'>
          {none ? '// patch(): nothing changed yet' : JSON.stringify(patch, null, 2)}
        </pre>
        {diffOpen && <DiffModal gridId={gridId} changes={changes} onClose={() => setDiffOpen(false)}/>}
      </div>
  );
}
