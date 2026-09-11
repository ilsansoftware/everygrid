import {useEffect, useState} from 'react';
import {Highlight, themes} from 'prism-react-renderer';
import {Everygrid, type RowChange} from '@everygrid/grid';
import DiffModal from './DiffModal';

type Kind = 'inserted' | 'updated' | 'deleted' | 'checked';

/**
 * Change tracking through the handle API. `Everygrid.get(id)` is a grid → row → cell cursor;
 * `changes()` is every inserted / updated / deleted row, and `patch()` what a save would send.
 * Edit, insert or delete rows in the grid above (or press "edit via API") and watch the patch turn
 * into the save calls below; open the diff, revert or commit from here.
 */
export default function ChangesPanel({gridId}: { gridId: string }) {
  const [changes, setChanges] = useState<RowChange[]>([]);
  const [checked, setChecked] = useState<unknown[]>([]);
  const [diffOpen, setDiffOpen] = useState(false);
  const [tab, setTab] = useState<Kind>('inserted');

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
    g.insertRow({name: 'New person', age: 30});           // a new row at the top (rowActions.insertRow)
    g.row(g.data().length - 1).delete();               // the last row (rowActions.deleteRow)
  };

  // Checked rows as handles — a bulk action is one line.
  const deleteChecked = () => Everygrid.get(gridId)?.checked().forEach(r => r.delete());

  const g = Everygrid.get(gridId);
  const patch = g?.patch() ?? {inserted: [], updated: [], deleted: []};
  const none = changes.length === 0;
  const btn = 'rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100 disabled:opacity-40';

  // One tab per kind: the count, and only the code that deals with rows of that kind — how to
  // reach them, and the JSON they give you — filled in with the live values.
  const counts: Record<Kind, number> = {
    inserted: patch.inserted.length, updated: patch.updated.length, deleted: patch.deleted.length, checked: checked.length,
  };
  // What each kind hands you, as plain JSON — how it gets saved (fetch, a form, a queue) is yours.
  const pj = (v: unknown) => JSON.stringify(v, null, 2);
  const code: Record<Kind, string> = {
    inserted: `const g = Everygrid.get('${gridId}');

g.insertRow({name: 'New person'});   // an empty row at the top, these fields filled; needs rowActions.insertRow
g.inserted()                          // RowHandle[]  → ${g?.inserted().map(r => `#${r.index}`).join(' ') || '—'}
g.inserted()[0]?.cell('age').set(30)  // fill it in; edits on a new row stay "inserted"
g.inserted()[0]?.revert()             // drop it again

const {inserted} = g.patch();         // the new rows, whole:
${pj(patch.inserted)}

g.commit();                           // once they are saved`,
    updated: `const g = Everygrid.get('${gridId}');

g.row(0).cell('age').set(31)          // edit exactly as typing would (honours editableCols)
g.updated()                           // RowHandle[]  → ${g?.updated().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}
g.updated()[0]?.changes()             // [{field, from, to}]
g.column('age').changes()             // the same seen from a column
g.updated()[0]?.cell('age').revert()  // one cell back;  g.updated()[0]?.revert() — the whole row

const {updated} = g.patch();          // per row: its key and only the changed fields:
${pj(patch.updated)}

g.commit();                           // once they are saved`,
    deleted: `const g = Everygrid.get('${gridId}');

g.row(2).delete()                     // struck through until commit; needs rowActions.deleteRow
g.deleted()                           // RowHandle[]  → ${g?.deleted().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}
g.deleted()[0]?.original()            // the row as loaded
g.deleted()[0]?.restore()             // undo

const {deleted} = g.patch();          // the keys to remove:
${pj(patch.deleted)}

g.commit();                           // once they are gone — now the rows really leave the grid`,
    checked: `const g = Everygrid.get('${gridId}');   // checkbox.mapping = 'id'

g.checked()                           // RowHandle[]  → ${g?.checked().map(r => `#${r.index}`).join(' ') || '—'}
g.check([1, 2])  g.uncheck([1])  g.checkAll()  g.uncheckAll()
g.row(0).isChecked()  g.row(0).check()
g.on('check', ({values, rows, changed, checked}) => …)

g.checkedValues()                     // the checked rows' mapping values:
${pj(checked)}

g.checked().map(r => r.get())         // or the rows themselves:
${pj(g?.checked().map(r => r.get()) ?? [])}`,
  };

  return (
      <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm'>
        <div className='flex items-center gap-1'>
          {(['inserted', 'updated', 'deleted', 'checked'] as Kind[]).map((k) => (
              <button key={k} type='button' onClick={() => setTab(k)}
                      className={`rounded px-2 py-1 ${tab === k ? 'bg-slate-800 text-white' : 'text-slate-600 hover:bg-slate-200'}`}>
                <span className='font-semibold tabular-nums'>{counts[k]}</span> {k}
              </button>
          ))}
          <button type='button' className={`ml-auto ${btn}`} onClick={editViaApi}>edit via API</button>
          <button type='button' className={btn} disabled={checked.length === 0} onClick={deleteChecked}>delete checked</button>
          <button type='button' className={btn} disabled={none} onClick={() => setDiffOpen(true)}>diff</button>
          <button type='button' className={btn} disabled={none} onClick={() => g?.revert()}>revert</button>
          <button type='button' className='rounded bg-slate-800 px-2 py-1 text-white hover:bg-slate-700 disabled:opacity-40'
                  disabled={none} onClick={() => g?.commit()}>commit</button>
        </div>
        {/* Same highlighter and theme as the portal's Code modal. */}
        <div className='mt-3 max-h-72 overflow-auto rounded-lg'>
          <Highlight code={code[tab]} language='tsx' theme={themes.nightOwl}>
            {({className, style, tokens, getLineProps, getTokenProps}) => (
                <pre className={`${className} changes-code`} style={style}>
                  {tokens.map((line, i) => (
                      <div key={i} {...getLineProps({line})}>
                        {line.map((token, key) => <span key={key} {...getTokenProps({token})}/>)}
                      </div>
                  ))}
                </pre>
            )}
          </Highlight>
        </div>
        {diffOpen && <DiffModal gridId={gridId} changes={changes} onClose={() => setDiffOpen(false)}/>}
      </div>
  );
}
