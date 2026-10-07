import {useState} from 'react';
import {Everygrid, EverygridLocaleSwitch, useGrid} from '@everygrid/grid';
// Demo-only (not part of the library): a plain <select> for the row count, and a generator of
// fake rows — stand-ins for your own control and your own data.
import RowCountPicker from './RowCountPicker';
import {makeVirtualGridData, resolveRowCount} from './virtualGridData';

// Virtual-scroll demo — renders only the rows in view, on its own tab.
export default function VirtualScrollDemo() {
  const [rows, setRows] = useState(resolveRowCount);
  // useGrid runs whichever fetcher was rendered last, so the picked size is simply closed over.
  useGrid('virtual-grid', () => makeVirtualGridData(rows));

  // Swapped in place: the grid re-runs the fetcher, so nothing is unmounted and the grid keeps its
  // identity. Silent because nobody pressed the toolbar's reload button, and discarding because a
  // different size is a different result — the old rows should not sit there meanwhile. A pick
  // made while one is still building is queued behind it, latest wins.
  const choose = (n: number) => {
    setRows(n);
    void Everygrid.reload('virtual-grid', {silent: true, discard: true});
  };

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
          <div className='demo-tools'>
            <EverygridLocaleSwitch persist defaultLocale='en'/>
            <RowCountPicker value={rows} onChange={choose}/>
          </div>
          {/* Virtual scrolling needs a bounded height to scroll inside. */}
          <div id='virtual-grid' className='w-full border-slate-200 h-[560px] flex flex-col'/>
        </main>
      </div>
  );
}
