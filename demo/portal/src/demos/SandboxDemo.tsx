import {useCallback, useRef, useState, type DragEvent, type ChangeEvent} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';

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
 * The rows in a parsed document. A bare array is the rows. An object whose first array-valued
 * property holds objects is unwrapped (`{data: [...]}`, `{rows: [...]}`…), so an API response
 * saved to disk works without editing. Any other object is one row — the same rule the library
 * applies to a fetched document — with nested objects and arrays shown as JSON cells.
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
  const nested = Object.values(doc).find(v => Array.isArray(v) && v.length > 0 && v.every(isRow));
  return nested ? (nested as Row[]) : [doc];
}

type FileInfo = { name: string; bytes: number; rows: number; columns: number };

// JSON to grid — drop any JSON file and the grid renders it, columns inferred from the rows.
export default function SandboxDemo() {
  // The grid re-runs this same fetcher on every reload, so the rows it should show live in a ref.
  const rowsRef = useRef<Row[]>([]);
  const fetcher = useCallback(() => Promise.resolve(rowsRef.current), []);
  useGrid('sandbox-grid', fetcher);

  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (file: File) => {
    setError(null);
    const limit = maxBytes();
    if (file.size > limit) {
      setError(`${file.name} is ${formatBytes(file.size)}; the limit is ${formatBytes(limit)}.`);
      return;
    }
    setBusy(true);
    try {
      // Parsing a large file blocks the main thread; yielding once lets the busy state paint first.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const rows = extractRows(JSON.parse(await file.text()));
      rowsRef.current = rows;
      const columns = new Set<string>();
      for (const r of rows.slice(0, 200)) Object.keys(r).forEach(k => columns.add(k));
      setInfo({name: file.name, bytes: file.size, rows: rows.length, columns: columns.size});
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

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void load(file);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void load(file);
  };

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-6 py-8 bg-white'>
          <div
              className={`rounded-lg border-2 border-dashed px-6 py-8 text-center text-sm transition-colors
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
              An array of objects, an object containing one, or a single object. Up to {formatBytes(maxBytes())}.
              Columns are inferred from the rows; nothing leaves your browser.
            </p>
            <input ref={inputRef} type='file' accept='.json,application/json' hidden onChange={onChange}/>
          </div>

          {busy && <p className='text-sm text-slate-500'>Parsing…</p>}
          {error && <p className='text-sm text-red-600' role='alert'>{error}</p>}
          {info && !error && (
              <p className='text-sm text-slate-600'>
                <span className='font-medium text-slate-800'>{info.name}</span>
                {' · '}{formatBytes(info.bytes)}
                {' · '}{info.rows.toLocaleString()} rows
                {' · '}{info.columns} columns
              </p>
          )}

          {/* The grid is mounted from the start (the hook needs its element) but stays hidden until a
              file has loaded — empty, it would show the library's "check your configuration" hint,
              which is the wrong message here. Virtual scrolling needs a bounded height to scroll in. */}
          <div hidden={!info}>
            <div id='sandbox-grid' className='w-full border-slate-200 h-[560px] flex flex-col'/>
          </div>
        </main>
      </div>
  );
}
