import {useCallback, useContext, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Everygrid, useGrid} from '@everygrid/grid';
import {HeadingSlotContext} from '../headingSlot';
import {makeVirtualGridData, resolveRowCount} from './virtualGridData';

/** Row counts offered by the size picker. Past ~493,000 rows (34px rows) the grid splits the
 *  result into scrollable segments, so the larger sizes are what exercise that path. */
const ROW_CHOICES = [100_000, 250_000, 500_000, 750_000, 1_000_000];

// Virtual-scroll demo — renders only the rows in view, on its own tab.
export default function VirtualScrollDemo({active}: { active: boolean }) {
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
    // Building the rows blocks the main thread, and starting it inside the change handler froze
    // the select mid-interaction — the dropdown had not closed and the new value had not painted.
    // Two frames is the cheap way to say "after the next paint", so the picker settles first.
    await new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    try {
      await Everygrid.reload('virtual-grid', {silent: true, discard: true});
    } finally {
      setBusy(false);
    }
  };

  // The size picker belongs to the whole tab, so it sits on the title row beside the code button
  // when that row exists; on a phone (no title row) it stays above the grid.
  const slot = useContext(HeadingSlotContext);
  const picker = (
      <label className='flex items-center'>
        <select
            aria-label='Rows'
            title='Rows'
            className='h-[34px] rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 shadow-sm disabled:opacity-50'
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
  );

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
          {slot && active ? createPortal(picker, slot) : picker}
          {/* Virtual scrolling needs a bounded height to scroll inside. */}
          <div id='virtual-grid' className='w-full border-slate-200 h-[560px] flex flex-col'/>
        </main>
      </div>
  );
}
