import {useEffect, useState} from 'react';
import {Highlight, themes} from 'prism-react-renderer';
import {Everygrid, type RowChange} from '@everygrid/grid';
import DiffModal from './DiffModal';

type Kind = 'inserted' | 'updated' | 'deleted' | 'checked';

/**
 * Change tracking through the handle API. `Everygrid.get(id)` is a grid → row → cell cursor;
 * `changes()` is every inserted / updated / deleted row, and `patch()` what a save would send.
 * Edit, insert, delete or check rows in the grid above and watch each tab; open the diff or commit from here.
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


  const g = Everygrid.get(gridId);
  const patch = g?.patch() ?? {inserted: [], updated: [], deleted: []};
  const none = changes.length === 0;

  // One tab per kind: the count, and only the code that deals with rows of that kind — how to
  // reach them, and the JSON they give you — filled in with the live values.
  const counts: Record<Kind, number> = {
    inserted: patch.inserted.length, updated: patch.updated.length, deleted: patch.deleted.length, checked: checked.length,
  };
  // What each kind hands you, as plain JSON — how it gets saved (fetch, a form, a queue) is yours.
  const pj = (v: unknown) => JSON.stringify(v, null, 2);
  // The API hands you the objects — row handles in plain arrays, JSON from patch(). What happens
  // to them (a save, a form, a queue) is written by you; these are only examples.
  const code: Record<Kind, string> = {
    inserted: `const g = Everygrid.get('${gridId}');

g.insertRow({name: 'New person'})     // a new row above the data rows; needs rowActions.insertRow
g.insertedRows()                      // RowHandle[] (their own index space)  → ${g?.insertedRows().map(r => `#${r.index}`).join(' ') || '—'}
g.insertedRows()[0]?.cell('age').set(30)
g.insertedRows().forEach(r => r.cancel())            // drop them again
g.rows().filter(r => r.inserted())                   // the same rows, as a filter

const {inserted} = g.patch();         // the new rows, whole:
${pj(patch.inserted)}

g.commit();                           // once saved: they join the loaded data, at the end`,
    updated: `const g = Everygrid.get('${gridId}');

g.row(0).cell('age').set(31)          // edit exactly as typing would (honours editableCols)
g.updatedRows()                       // RowHandle[]  → ${g?.updatedRows().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}
g.updatedRows()[0]?.changes()         // [{field, from, to}]
g.column('age').changes()             // the same seen from a column
g.updatedRows().forEach(r => r.cell('age').cancel())
g.rows().filter(r => r.updated())                    // the same rows, as a filter

const {updated} = g.patch();          // per row: its key and only the changed fields:
${pj(patch.updated)}

g.commit();                           // once they are saved`,
    deleted: `const g = Everygrid.get('${gridId}');

g.row(2).delete()                     // struck through until commit; needs rowActions.deleteRow
g.deletedRows()                       // RowHandle[]  → ${g?.deletedRows().map(r => `#${r.index} key ${r.key()}`).join(' ') || '—'}
g.deletedRows()[0]?.original()        // the row as loaded
g.deletedRows().forEach(r => r.cancel())             // bring them all back
g.rows().filter(r => r.deleted())                    // the same rows, as a filter

const {deleted} = g.patch();          // per row: its key, and the row as loaded:
${pj(patch.deleted)}

g.commit();                           // once they are gone — now the rows really leave the grid`,
    checked: `const g = Everygrid.get('${gridId}');   // checkbox.mapping = 'id'

g.checkedRows()                       // RowHandle[]  → ${g?.checkedRows().map(r => `#${r.index}`).join(' ') || '—'}
g.rows().filter(r => r.checked())                    // the same rows, as a filter
g.rows()[0].check()  g.rows()[0].checked()  g.checkAll()  g.uncheckAll()
g.on('check', ({values, rows, changed, checked}) => …)

g.checkedRows().forEach(r => r.delete())             // whatever you need, over the handles
g.checkedRows().forEach(r => r.cell('active').set(false))

g.checkedRows().map(r => r.get())     // the checked rows as JSON:
${pj(g?.checkedRows().map(r => r.get()) ?? [])}`,
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
          <button type='button' disabled={none} onClick={() => setDiffOpen(true)}
                  className='ml-auto rounded px-2 py-1 font-mono text-slate-600 hover:bg-slate-200 disabled:opacity-40 disabled:hover:bg-transparent'>
            g.diff()
          </button>
        </div>
        {/* Same highlighter and theme as the portal's Code modal. Grows with its content — an inner
            scroll box hid the JSON below the fold. */}
        <div className='mt-3 overflow-x-auto rounded-lg'>
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
