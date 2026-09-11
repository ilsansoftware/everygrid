import {useCallback, useEffect, useRef, useState, type DragEvent, type ChangeEvent, type ClipboardEvent} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';
import LocaleSwitch, {type Locale} from './LocaleSwitch';

type Row = Record<string, unknown>;

/** Largest file the sandbox will parse. A 50 MB JSON text becomes a few hundred MB of row objects
 *  plus a copy in the WASM worker — the most a desktop tab takes comfortably. A phone gets a tenth. */
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_BYTES_MOBILE = 5 * 1024 * 1024;

function maxBytes(): number {
  const mobile = /Mobi|Android|iPhone|iPod|iPad/i.test(navigator.userAgent)
      || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && window.innerWidth < 820);
  return mobile ? MAX_BYTES_MOBILE : MAX_BYTES;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * The rows in a parsed document. A bare array is the rows. A wrapper — an object whose ONLY
 * property is an array of objects (`{data: [...]}`, `{rows: [...]}`) — is unwrapped, so an API
 * response saved to disk works without editing. Any other object is one row, the same rule the
 * library applies to a fetched document, with nested objects and arrays shown as JSON cells: an
 * order with `items` inside is one order, not two items.
 */
function extractRows(doc: unknown): Row[] {
  const isRow = (r: unknown): r is Row => !!r && typeof r === 'object' && !Array.isArray(r);
  if (Array.isArray(doc)) {
    if (doc.length === 0) throw new Error('The array is empty.');
    const bad = doc.findIndex(r => !isRow(r));
    if (bad !== -1) throw new Error(`Row ${bad} is not an object — every row must be a JSON object.`);
    return doc as Row[];
  }
  if (!isRow(doc)) throw new Error('Expected a JSON array or object at the top level.');
  const values = Object.values(doc);
  const only = values.length === 1 ? values[0] : undefined;
  return Array.isArray(only) && only.length > 0 && only.every(isRow) ? (only as Row[]) : [doc];
}

type FileInfo = { name: string; bytes: number; rows: number; columns: number };

// JSON to grid — drop a JSON file or paste JSON text and the grid renders it, columns inferred
// from the rows.
export default function SandboxDemo({active}: { active: boolean }) {
  // Language is per tab: applied through the API whenever this tab is the one on screen.
  const [locale, setLocale] = useState<Locale>('en');
  useEffect(() => {
    if (active) Everygrid.setLocale(locale);
  }, [active, locale]);

  // The grid re-runs this same fetcher on every reload, so the rows it should show live in a ref.
  const rowsRef = useRef<Row[]>([]);
  const fetcher = useCallback(() => Promise.resolve(rowsRef.current), []);
  useGrid('sandbox-grid', fetcher);

  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState('');
  /** Which input the right column shows: the file drop zone or the JSON text box. */
  const [source, setSource] = useState<'file' | 'json'>('file');

  /** A file and pasted text take the same path; `read` hands over the text once the size passed. */
  const load = async (name: string, bytes: number, read: () => Promise<string>) => {
    setError(null);
    const limit = maxBytes();
    if (bytes > limit) {
      setError(`${name} is ${formatBytes(bytes)}; the limit is ${formatBytes(limit)}.`);
      return;
    }
    setBusy(true);
    try {
      // Parsing a large file blocks the main thread; yielding once lets the busy state paint first.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const rows = extractRows(JSON.parse(await read()));
      rowsRef.current = rows;
      const columns = new Set<string>();
      for (const r of rows.slice(0, 200)) Object.keys(r).forEach(k => columns.add(k));
      setInfo({name, bytes, rows: rows.length, columns: columns.size});
      // Silent because nobody pressed the toolbar's reload; discarding because the previous file's
      // rows should not sit there while the new ones are indexed.
      await Everygrid.reload('sandbox-grid', {silent: true, discard: true});
    } catch (e) {
      rowsRef.current = [];
      setInfo(null);
      setError(e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : (e as Error).message);
      await Everygrid.reload('sandbox-grid', {silent: true, discard: true});
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const loadFile = (file: File) => load(file.name, file.size, () => file.text());
  const loadText = (text: string) => load('Pasted JSON', new Blob([text]).size, () => Promise.resolve(text));

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  };
  // A paste is a normal paste — inserted at the caret, keeping what is already in the box — and
  // renders straight away when the box then holds valid JSON. Otherwise (a fragment pasted into
  // a draft) it just lands, and the Render button covers the rest.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const clip = e.clipboardData.getData('text');
    if (!clip.trim()) return;
    const el = e.currentTarget;
    const next = el.value.slice(0, el.selectionStart) + clip + el.value.slice(el.selectionEnd);
    try { JSON.parse(next); } catch { return; }
    e.preventDefault();
    // Insert through the editing pipeline rather than setting state: a value set from script
    // wipes the box's undo history, so Cmd+Z / Cmd+Shift+Z stopped working after a paste. The
    // resulting input event lands in onChange as usual.
    document.execCommand('insertText', false, clip);
    void loadText(next);
  };

  return (
      <div className='max-w-7xl mx-auto'>
        {/* Grid on the left at twice the width; the input on the right, one of two behind a
            File | JSON toggle. Stacked the other way round on a narrow screen, input first. */}
        <main className='min-h-150 grid gap-4 py-8 bg-white md:grid-cols-3'>
          <div className='demo-tools md:col-span-3'><LocaleSwitch value={locale} onChange={setLocale}/></div>
          <div className='order-2 md:order-1 md:col-span-2 h-[560px] flex flex-col'>
            {/* The grid is mounted from the start (the hook needs its element) but stays hidden until
                a file has loaded — empty, it would show the library's "check your configuration"
                hint, which is the wrong message here. Virtual scrolling needs a bounded height. */}
            <div hidden={!info} className='flex-1 min-h-0 flex flex-col'>
              <div id='sandbox-grid' className='w-full h-full border-slate-200 flex flex-col'/>
            </div>
            {!info && (
                <div className='flex-1 flex items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-400'>
                  {busy ? 'Parsing…' : 'The grid appears here.'}
                </div>
            )}
          </div>

          <div className='order-1 md:order-2 flex flex-col gap-4 md:h-[560px]'>
            <div className='locale-btn-group' role='group' aria-label='Input'>
              {(['file', 'json'] as const).map((id) => (
                  <button
                      key={id}
                      type='button'
                      className={`locale-btn source-btn${source === id ? ' active' : ''}`}
                      aria-pressed={source === id}
                      onClick={() => setSource(id)}
                  >
                    {id === 'file' ? 'File' : 'JSON'}
                  </button>
              ))}
            </div>

            {source === 'file' && (
            <div
                className={`flex-1 flex flex-col justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition-colors
                  ${dragging ? 'border-indigo-400 bg-indigo-50' : 'border-slate-300 bg-slate-50'}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
            >
              <p className='text-slate-700'>
                Drop a <code>.json</code> file here, or{' '}
                <button
                    type='button'
                    className='text-indigo-600 underline disabled:opacity-50'
                    disabled={busy}
                    onClick={() => inputRef.current?.click()}
                >
                  choose one
                </button>
                .
              </p>
              <p className='mt-1 text-xs text-slate-500'>
                An array of objects, a single object, or a wrapper like {'{'}data: [...]{'}'}.
                Up to {formatBytes(maxBytes())}. Nothing leaves your browser.
              </p>
              <input ref={inputRef} type='file' accept='.json,application/json' hidden onChange={onChange}/>
            </div>
            )}

            {source === 'json' && (<>
            <textarea
                className='min-h-28 w-full flex-1 resize-none rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none'
                placeholder='Paste JSON here'
                spellCheck={false}
                value={pasted}
                disabled={busy}
                onChange={(e) => setPasted(e.target.value)}
                onPaste={onPaste}
            />
            <div className='flex items-center gap-3'>
              <button
                  type='button'
                  className='h-[34px] rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50'
                  disabled={busy || !pasted.trim()}
                  onClick={() => void loadText(pasted)}
              >
                Render
              </button>
              <button
                  type='button'
                  className='text-sm text-slate-500 hover:text-slate-800 disabled:opacity-50'
                  disabled={busy || !pasted}
                  onClick={() => setPasted('')}
              >
                Clear
              </button>
            </div>
            </>)}

            {error && <p className='text-sm text-red-600' role='alert'>{error}</p>}
            {info && !error && (
                <p className='text-sm text-slate-600'>
                  <span className='font-medium text-slate-800'>{info.name}</span>
                  {' · '}{formatBytes(info.bytes)}
                  {' · '}{info.rows.toLocaleString()} rows
                  {' · '}{info.columns} columns
                </p>
            )}
          </div>
        </main>
      </div>
  );
}
