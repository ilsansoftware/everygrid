import {useEffect, useState} from 'react';
import {Everygrid, type RowChange} from '@everygrid/grid';
import DiffModal from './DiffModal';

/**
 * Change tracking through the handle API. `Everygrid.get(id)` is a grid → row → cell cursor;
 * `changes()` is every added / modified / deleted row, and `patch()` what a save would send.
 * Edit, add or delete rows in the grid above (or press "edit via API") and watch the patch turn
 * into the save calls below; open the diff, revert or commit from here.
 */
export default function ChangesPanel({gridId}: { gridId: string }) {
  const [changes, setChanges] = useState<RowChange[]>([]);
  const [checked, setChecked] = useState<unknown[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [tab, setTab] = useState<'patch' | 'save' | 'select'>('patch');

  useEffect(() => {
    // The grid mounts asynchronously, so poll once until its handle exists, then subscribe.
    let off = () => {};
    const timer = setInterval(() => {
      const g = Everygrid.get(gridId);
      if (!g) return;
      clearInterval(timer);
      setChanges(g.changes());
      setChecked(g.checkedValues());
      const offChange = g.on('change', setChanges);
      // The checkbox column: `values` is every checked row's mapping value (here: id).
      const offCheck = g.on('check', (e) => setChecked(e.values));
      off = () => { offChange(); offCheck(); };
    }, 200);
    return () => { clearInterval(timer); off(); };
  }, [gridId]);

  const editViaApi = () => {
    const g = Everygrid.get(gridId);
    if (!g) return;
    const age = g.row(0).cell('age');                 // first row, "age" column
    age.set(Number(age.get() || 0) + 1);
    g.rowByKey(2).set({category: 'Ops'});              // the row whose rowKey (id) is 2
    g.addRow({name: 'New person', age: 30});           // a new row at the top (rowActions.addRow)
    g.row(g.data().length - 1).delete();               // the last row (rowActions.deleteRow)
  };

  // Checked rows as handles — a bulk action is one line.
  const deleteChecked = () => Everygrid.get(gridId)?.checked().forEach(r => r.delete());

  const g = Everygrid.get(gridId);
  const patch = g?.patch() ?? {added: [], updated: [], deleted: []};
  const none = changes.length === 0;
  const btn = 'rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-40';
  const tabBtn = (id: typeof tab, label: string) => (
      <button type='button' onClick={() => setTab(id)}
              className={`px-2 py-0.5 rounded ${tab === id ? 'bg-slate-800 text-white' : 'text-slate-500 hover:text-slate-800'}`}>
        {label}
      </button>
  );

  // What a save looks like for exactly this patch: one request per kind, then commit.
  const saveExample = `const g = Everygrid.get('${gridId}');
const {added, updated, deleted} = g.patch();

// ${patch.added.length} added → POST the whole rows
if (added.length) await fetch('/api/users', {method: 'POST', body: JSON.stringify(added)});
// ${patch.updated.length} updated → PATCH each by key with only the changed fields
for (const {key, changes} of updated)   // ${patch.updated.map(u => `${u.key}: ${JSON.stringify(u.changes)}`).join(', ') || '—'}
  await fetch(\`/api/users/\${key}\`, {method: 'PATCH', body: JSON.stringify(changes)});
// ${patch.deleted.length} deleted → DELETE by key
for (const key of deleted)              // ${patch.deleted.join(', ') || '—'}
  await fetch(\`/api/users/\${key}\`, {method: 'DELETE'});

g.commit();   // saved: current state becomes the baseline`;

  const selectors = `const g = Everygrid.get('${gridId}');

// changed rows by kind — each is a RowHandle
g.added()      // ${g?.added().map(r => `#${r.index}`).join(' ') || '—'}
g.updated()    // ${g?.updated().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}
g.deleted()    // ${g?.deleted().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}

// any row: by data index, by key, by predicate, by position on screen
g.row(0)  g.rowByKey(2)  g.find(r => r.name === 'Kim')  g.visibleRow(0)

// a row's state and its cells
g.row(0).status()      // 'added' | 'modified' | 'deleted' | null
g.row(0).changes()     // [{field, from, to}]
g.row(0).cell('age').get() / .original() / .set(31) / .revert()
g.row(0).delete() / .restore() / .revert()

// a column across all rows
g.column('age').changes()   // [{index, key, from, to, row}]

// the checkbox column (checkbox.mapping = 'id')
g.checked()                 // ${g?.checked().map(r => `#${r.index}`).join(' ') || '—'}  (RowHandle[])
g.checkedValues()           // ${JSON.stringify(g?.checkedValues() ?? [])}
g.check([1, 2])  g.uncheck([1])  g.checkAll()  g.uncheckAll()
g.row(0).isChecked()  g.row(0).check()
g.on('check', ({values, rows, changed, checked}) => …)`;

  return (
      <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm'>
        <div className='flex items-center gap-3'>
          <span className='font-medium text-slate-800'>Changes</span>
          <span className='text-slate-500'>
            {patch.added.length} added · {patch.updated.length} updated · {patch.deleted.length} deleted
          </span>
          <span className='text-slate-400'>·</span>
          <span className='text-slate-500'>{checked.length} checked</span>
          <button type='button' className={`ml-auto ${btn}`} onClick={editViaApi}>edit via API</button>
          <button type='button' className={btn} disabled={checked.length === 0} onClick={deleteChecked}>delete checked</button>
          <button type='button' className={btn} disabled={none} onClick={() => setDiffOpen(true)}>diff</button>
          <button type='button' className={btn} disabled={none} onClick={() => g?.revert()}>revert</button>
          <button type='button' className='rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700 disabled:opacity-40'
                  disabled={none} onClick={() => g?.commit()}>commit</button>
        </div>
        <div className='mt-3 flex items-center gap-1 text-xs'>
          {tabBtn('patch', 'patch()')}{tabBtn('save', 'save with fetch')}{tabBtn('select', 'selectors')}
        </div>
        <pre className='mt-2 max-h-56 overflow-auto rounded bg-white p-3 font-mono text-xs leading-relaxed text-slate-700'>
          {tab === 'patch' ? (none ? '// patch(): nothing changed yet' : JSON.stringify(patch, null, 2))
              : tab === 'save' ? saveExample : selectors}
        </pre>
        {diffOpen && <DiffModal gridId={gridId} changes={changes} onClose={() => setDiffOpen(false)}/>}
      </div>
  );
}
