import {useEffect, useRef, useState} from 'react';
import {GridEngineWasm} from '@everygrid/grid';
import {AllCommunityModule, createGrid, ModuleRegistry, type GridApi} from 'ag-grid-community';
import {
  columnFilteringFeature,
  constructTable,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
} from '@tanstack/table-core';
import {storeReactivityBindings} from '@tanstack/table-core/store-reactivity-bindings';

// Benchmark — the same rows, the same three operations, run through Everygrid's engine, AG Grid
// Community and TanStack Table, one after another in this tab. Two numbers per operation:
//   time    — from the call until the first page of the result is ready (and, for AG Grid, painted)
//   freeze  — the longest gap between animation frames meanwhile: how long the page could not
//             repaint or answer a click. A smooth page is ~17 ms.
// Everygrid filters and sorts in a Web Worker; the other two run on the main thread. Each operation
// runs REPS times on a reset table. The headline is the FIRST run, since every library caches
// something (Everygrid keeps a per-column sort index and the last filter result, AG Grid its
// quick-filter text) and a repeat measures the cache; the repeat median is shown beside it. The
// operations use different filters and sort columns so no one reuses another's cache. The match
// counts are printed so you can check every library answered the same question.

ModuleRegistry.registerModules([AllCommunityModule]);

type Row = {id: number; name: string; team: string; city: string; score: number; joined: string; active: boolean};
const FIELDS = ['id', 'name', 'team', 'city', 'score', 'joined', 'active'] as const;
const SIZES = [100_000, 500_000, 1_000_000];
const REPS = 4;
type Op = {key: string; label: string; filter: string; sort: string};
const OPS: Op[] = [
  {key: 'filter', label: 'Filter: text "busan"', filter: 'busan', sort: ''},
  {key: 'sort', label: 'Sort: score desc', filter: '', sort: 'score'},
  {key: 'both', label: 'Filter "daegu" + sort joined desc', filter: 'daegu', sort: 'joined'},
];

/** Seeded so every run (and every visitor) gets the same rows. */
function makeRows(n: number): Row[] {
  let s = 42;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T, >(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const first = ['Ada', 'Grace', 'Linus', 'Alan', 'Edsger', 'Barbara', 'Ken', 'Margaret', 'Dennis', 'Frances'];
  const last = ['Lovelace', 'Hopper', 'Torvalds', 'Turing', 'Dijkstra', 'Liskov', 'Thompson', 'Hamilton', 'Ritchie', 'Allen'];
  const teams = ['Platform', 'Growth', 'Payments', 'Data', 'Infra', 'Design'];
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Ulsan'];
  const rows: Row[] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = {
      id: i + 1,
      name: `${pick(first)} ${pick(last)}`,
      team: pick(teams),
      city: pick(cities),
      score: Math.floor(rand() * 100_000),
      joined: new Date(Date.UTC(2010, 0, 1) + Math.floor(rand() * 5000) * 86_400_000).toISOString().slice(0, 10),
      active: rand() < 0.7,
    };
  }
  return rows;
}

/** What each library has to do. `query` resolves once the first page of the result is available;
 *  `sort` is a field to sort descending by, or '' for none. */
interface Contender {
  name: string;
  load(rows: Row[]): Promise<void>;
  query(filter: string, sort: string): Promise<number>;
  dispose(): void;
}

function everygrid(): Contender {
  let engine: GridEngineWasm | null = null;
  return {
    name: 'Everygrid',
    async load(rows) {
      engine = await GridEngineWasm.create(`bench-${Date.now()}`);
      await engine.setData(rows, false);
    },
    async query(filter, sort) {
      const r = await engine!.filterSortAndGetPage(filter, sort, false, 0, 50);
      return r.filtered;
    },
    dispose() {
      engine?.terminate();
    },
  };
}

function agGrid(host: HTMLElement): Contender {
  let api: GridApi<Row> | null = null;
  return {
    name: 'AG Grid',
    load(rows) {
      return new Promise(resolve => {
        api = createGrid<Row>(host, {
          columnDefs: FIELDS.map(field => ({field})),
          rowData: rows,
          onFirstDataRendered: () => resolve(),
        });
      });
    },
    async query(filter, sort) {
      api!.setGridOption('quickFilterText', filter);
      api!.applyColumnState({state: sort ? [{colId: sort, sort: 'desc'}] : [], defaultState: {sort: null}});
      return api!.getDisplayedRowCount();
    },
    dispose() {
      api?.destroy();
    },
  };
}

function tanstack(): Contender {
  const features = tableFeatures({
    coreReactivityFeature: storeReactivityBindings(),
    columnFilteringFeature,
    globalFilteringFeature,
    filteredRowModel: createFilteredRowModel(),
    filterFns: {includesString: filterFn_includesString},
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
  });
  const helper = createColumnHelper<typeof features, Row>();
  const columns = helper.columns(FIELDS.map(f => helper.accessor(f, {})));
  let table: ReturnType<typeof constructTable<typeof features, Row>> | null = null;
  return {
    name: 'TanStack Table',
    async load(rows) {
      table = constructTable({features, columns, data: rows, globalFilterFn: 'includesString'});
      table.getRowModel();
    },
    async query(filter, sort) {
      table!.setGlobalFilter(filter);
      table!.setSorting(sort ? [{id: sort, desc: true}] : []);
      return table!.getRowModel().rows.length;
    },
    dispose() {
      table = null;
    },
  };
}

// A hidden tab gets no animation frames at all, so a frame wait falls back to a timer rather than
// hang — the run then finishes, flagged, instead of stalling until the tab is shown again.
const nextFrame = () => new Promise<void>(r => {
  const t = setTimeout(r, 250);
  requestAnimationFrame(() => {
    clearTimeout(t);
    r();
  });
});

/** Times `fn` until its result is painted, and records the longest frame gap meanwhile. */
async function timed<T>(fn: () => Promise<T>): Promise<{ms: number; freeze: number; value: T}> {
  await nextFrame();
  await nextFrame();
  let last = performance.now();
  let freeze = 0;
  let running = true;
  const tick = (t: number) => {
    freeze = Math.max(freeze, t - last);
    last = t;
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const t0 = performance.now();
  const value = await fn();
  await nextFrame();
  const ms = performance.now() - t0;
  running = false;
  freeze = Math.max(freeze, performance.now() - last);
  return {ms, freeze, value};
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

type Cell = {ms: number; freeze: number; warm?: number; count?: number};
type Results = Record<string, Record<string, Cell>>; // contender → op key ('load' | OPS) → cell

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export default function BenchmarkDemo() {
  const [size, setSize] = useState(SIZES[0]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [results, setResults] = useState<Results>({});
  const [ranSize, setRanSize] = useState(0);
  const agHost = useRef<HTMLDivElement>(null);
  const dot = useRef<HTMLDivElement>(null);

  // A dot moved from JavaScript every frame: it stops whenever the main thread is busy, which is
  // what the "freeze" column measures. (A CSS animation would keep going on the compositor.)
  useEffect(() => {
    let id = 0;
    const move = (t: number) => {
      if (dot.current) dot.current.style.transform = `translateX(${(Math.sin(t / 300) + 1) * 120}px)`;
      id = requestAnimationFrame(move);
    };
    id = requestAnimationFrame(move);
    return () => cancelAnimationFrame(id);
  }, []);

  const run = async () => {
    setRunning(true);
    setResults({});
    setRanSize(size);
    setStatus(`Generating ${size.toLocaleString()} rows…`);
    await nextFrame();
    const rows = makeRows(size);
    const all: Results = {};
    let hidden = document.hidden;
    const onHide = () => { hidden ||= document.hidden; };
    document.addEventListener('visibilitychange', onHide);
    for (const c of [everygrid(), agGrid(agHost.current!), tanstack()]) {
      const out: Record<string, Cell> = {};
      all[c.name] = out;
      try {
        setStatus(`${c.name}: loading…`);
        out.load = await timed(() => c.load(rows));
        setResults({...all});
        for (const op of OPS) {
          setStatus(`${c.name}: ${op.label}…`);
          const runs: {ms: number; freeze: number; value: number}[] = [];
          for (let i = 0; i < REPS; i++) {
            await c.query('', ''); // reset, unmeasured
            runs.push(await timed(() => c.query(op.filter, op.sort)));
          }
          const [first, ...repeats] = runs;
          out[op.key] = {ms: first.ms, freeze: first.freeze, warm: median(repeats.map(r => r.ms)), count: first.value};
          setResults({...all});
        }
      } catch (e) {
        console.error(e);
        setStatus(`${c.name} failed: ${(e as Error).message}`);
      } finally {
        c.dispose();
      }
    }
    document.removeEventListener('visibilitychange', onHide);
    setStatus(hidden ? 'Done — but the tab was hidden during the run, so these numbers are not valid. Run again with the tab in view.' : 'Done.');
    setRunning(false);
  };

  const names = Object.keys(results);
  const steps = [{key: 'load', label: 'Load rows'}, ...OPS];
  const best = (key: string, metric: 'ms' | 'freeze') =>
      Math.min(...names.map(n => results[n][key]?.[metric] ?? Infinity));

  const markdown = () => {
    const head = `| ${ranSize.toLocaleString()} rows | ${names.join(' | ')} |\n|---|${names.map(() => '---|').join('')}`;
    const body = steps.map(s => `| ${s.label} | ${names.map(n => {
      const c = results[n][s.key];
      return c ? `${fmt(c.ms)} (freeze ${fmt(c.freeze)}${c.warm !== undefined ? `, repeat ${fmt(c.warm)}` : ''})` : '–';
    }).join(' | ')} |`).join('\n');
    return `${head}\n${body}\n\n_${navigator.userAgent}, ${navigator.hardwareConcurrency} cores_`;
  };

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='flex flex-col gap-6 py-8 bg-white text-sm text-slate-700'>
          <p className='max-w-3xl leading-relaxed'>
            The same seeded rows, filtered and sorted by Everygrid's WASM engine (in a Web Worker), AG Grid
            Community and TanStack Table (both on the main thread). <b>Time</b> runs until the first page of the
            result is ready; <b>freeze</b> is the longest the page went without a frame meanwhile — watch the dot
            stop. Each figure is the first run; <i>repeat</i> is the median of the next {REPS - 1}, when caches
            are warm. The match counts should agree.
          </p>

          <div className='demo-tools'>
            <select
                aria-label='Rows'
                className='demo-select h-[34px] rounded-lg border border-slate-300 bg-white pl-3 text-sm text-slate-700 shadow-sm'
                value={size}
                disabled={running}
                onChange={e => setSize(Number(e.target.value))}
            >
              {SIZES.map(n => <option key={n} value={n}>{n.toLocaleString()} rows</option>)}
            </select>
            <button
                type='button'
                className='h-[34px] rounded-lg bg-slate-900 px-4 font-medium text-white disabled:opacity-50'
                disabled={running}
                onClick={run}
            >
              {running ? 'Running…' : 'Run benchmark'}
            </button>
            <div className='relative h-3 w-[252px] rounded-full bg-slate-100' title='Moves only while the main thread is free'>
              <div ref={dot} className='absolute top-0 h-3 w-3 rounded-full bg-emerald-500'/>
            </div>
            <span className='text-slate-500'>{status}</span>
          </div>

          {names.length > 0 && (
              <div className='overflow-x-auto'>
                <table className='w-full border-collapse'>
                  <thead>
                  <tr className='border-b border-slate-200 text-left'>
                    <th className='py-2 pr-4 font-medium'>{ranSize.toLocaleString()} rows</th>
                    {names.map(n => <th key={n} className='py-2 pr-4 font-medium'>{n}</th>)}
                  </tr>
                  </thead>
                  <tbody>
                  {steps.map(s => (
                      <tr key={s.key} className='border-b border-slate-100 align-top'>
                        <td className='py-2 pr-4'>{s.label}</td>
                        {names.map(n => {
                          const c = results[n][s.key];
                          if (!c) return <td key={n} className='py-2 pr-4 text-slate-400'>–</td>;
                          return (
                              <td key={n} className='py-2 pr-4 tabular-nums'>
                                <span className={c.ms === best(s.key, 'ms') ? 'font-semibold' : ''}>{fmt(c.ms)}</span>
                                <span className={`ml-2 ${c.freeze === best(s.key, 'freeze') ? 'text-emerald-600' : c.freeze > 100 ? 'text-rose-600' : 'text-slate-500'}`}>
                                  freeze {fmt(c.freeze)}
                                </span>
                                <div className='text-xs text-slate-400'>
                                  {c.warm !== undefined && `repeat ${fmt(c.warm)} · `}
                                  {c.count !== undefined && `${c.count.toLocaleString()} rows`}
                                </div>
                              </td>
                          );
                        })}
                      </tr>
                  ))}
                  </tbody>
                </table>
                {!running && (
                    <button type='button' className='mt-3 text-xs text-slate-500 underline'
                            onClick={() => void navigator.clipboard.writeText(markdown())}>
                      Copy as Markdown
                    </button>
                )}
              </div>
          )}

          <div>
            <div className='mb-1 text-xs text-slate-500'>AG Grid needs a real DOM, so it renders here while it runs:</div>
            <div ref={agHost} className='h-[240px] w-full'/>
          </div>
        </main>
      </div>
  );
}
