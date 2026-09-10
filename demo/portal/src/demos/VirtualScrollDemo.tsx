import {useCallback, useRef, useState} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';

/** Row counts offered by the size picker. Past ~493,000 rows (34px rows) the grid splits the
 *  result into scrollable segments, so the larger sizes are what exercise that path. */
const ROW_CHOICES = [100_000, 250_000, 500_000, 750_000, 1_000_000];

// Virtual-scroll demo — renders only the rows in view, on its own tab.
export default function VirtualScrollDemo() {
  const [current, setCurrent] = useState(resolveRowCount);
  // The fetcher is captured once, at mount, so it reads the size through a ref rather than closing
  // over the value — otherwise every reload would rebuild the size it was first created with.
  const rowsRef = useRef(current);
  const fetcher = useCallback(() => makeVirtualGridData(rowsRef.current), []);
  useGrid('virtual-grid', fetcher);

  // Swapped in place: the grid re-runs that same fetcher, so nothing is unmounted and the grid
  // keeps its identity. Reloading the page instead rebuilt the whole portal for what is really
  // just new data. Silent because nobody pressed the toolbar's reload button, and discarding
  // because a different size is a different result — the old rows should not sit there meanwhile.
  const [busy, setBusy] = useState(false);
  const choose = async (rows: number) => {
    rowsRef.current = rows;
    setCurrent(rows);
    // Locked while the rows are being built: a reload started during one already in flight is
    // dropped, which would leave the picker showing a size the grid never loaded.
    setBusy(true);
    try {
      await Everygrid.reload('virtual-grid', {silent: true, discard: true});
    } finally {
      setBusy(false);
    }
  };

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
          <label className='flex items-center gap-2 text-sm text-slate-600'>
            Rows
            <select
                className='rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50'
                value={ROW_CHOICES.includes(current) ? current : ''}
                disabled={busy}
                onChange={(e) => void choose(Number(e.target.value))}
            >
              {!ROW_CHOICES.includes(current) && (
                  <option value=''>{current.toLocaleString()}</option>
              )}
              {ROW_CHOICES.map((n) => (
                  <option key={n} value={n}>{n.toLocaleString()}</option>
              ))}
            </select>
          </label>
          {/* Virtual scrolling needs a bounded height to scroll inside. */}
          <div id='virtual-grid' className='w-full border-slate-200 h-[560px] flex flex-col'/>
        </main>
      </div>
  );
}

// virtual-grid data, generated in the page (100k rows ≈ 25 MB + a copy in the WASM worker). Fine on a
// desktop but kills a phone's tab, so the starting row count scales to the device — a coarse /
// narrow / low-RAM device gets far fewer. The size picker takes over from there.
type Row = Record<string, unknown>;

/** The starting size: as much as the device looks able to take. The picker drives it after that. */
function resolveRowCount(): number {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean }
  };
  const mem = nav.deviceMemory; // GB (Chromium) or undefined
  const width = Math.min(window.innerWidth || Infinity, window.screen?.width || Infinity);
  const uaMobile = !!nav.userAgentData?.mobile || /Mobi|Android|iPhone|iPod|iPad/i.test(nav.userAgent);
  const coarseNarrow = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches && nav.maxTouchPoints > 0 && width < 820;
  const constrained = uaMobile || coarseNarrow || width < 820;
  const deviceMax = constrained
      ? (mem ? Math.max(3000, Math.min(100000, mem * 3000)) : 5000)
      : (mem && mem <= 4 ? 25000 : 100000);
  return deviceMax;
}

function makeVirtualGridData(rows: number): Promise<Row[]> {
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Ulsan'];
  const teams = ['Platform', 'Growth', 'Payments', 'Data', 'Infra', 'Design'];
  const out: Row[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    out[i] = {
      id: 'ID_' + (i + 1),
      name: 'User_' + (i + 1),
      team: teams[i % teams.length],
      city: cities[i % cities.length],
      score: (i * 7919) % 1000,
      joinedDate: new Date(Date.UTC(2015 + (i % 10), i % 12, (i % 28) + 1)).toISOString().slice(0, 10),
      active: i % 3 !== 0,
    };
  }
  return Promise.resolve(out);
}
