import {useEffect} from 'react';
import {Highlight, themes} from 'prism-react-renderer';
import {Everygrid} from '@everygrid/grid';

/**
 * `g.diff()` as it is: the call, and what it returns — inserted / updated / deleted rows, each
 * with its key, its index, the row as it is and as it was loaded, and the cells that changed.
 */
export default function DiffModal({gridId, onClose}: { gridId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const diff = Everygrid.get(gridId)?.diff() ?? {inserted: [], updated: [], deleted: [], cells: 0};
  const code = `const g = Everygrid.get('${gridId}');

g.diff()   // {inserted, updated, deleted, cells} — original vs current, by kind
${JSON.stringify(diff, null, 2)}`;

  return (
      <div className='fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4' onClick={onClose}>
        <div className='flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl'
             onClick={(e) => e.stopPropagation()}>
          <div className='flex items-center gap-3 border-b border-slate-200 px-5 py-3 text-sm'>
            <span className='font-mono font-semibold text-slate-800'>diff</span>
            <span className='text-slate-500'>
              {diff.inserted.length} inserted · {diff.updated.length} updated · {diff.deleted.length} deleted · {diff.cells} cells
            </span>
            <button type='button' className='ml-auto text-slate-400 hover:text-slate-700' onClick={onClose} aria-label='Close'>✕</button>
          </div>
          <div className='overflow-auto'>
            <Highlight code={code} language='tsx' theme={themes.nightOwl}>
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
        </div>
      </div>
  );
}
