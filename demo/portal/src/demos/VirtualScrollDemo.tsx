import {useEffect, useState} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';
import LocaleSwitch from './LocaleSwitch';
import {usePersistedLocale} from './useLocale';
import RowCountPicker from './RowCountPicker';
import {makeVirtualGridData, resolveRowCount} from './virtualGridData';

// Virtual-scroll demo — renders only the rows in view, on its own tab.
export default function VirtualScrollDemo({active}: { active: boolean }) {
  // Language is per tab: applied through the API whenever this tab is the one on screen.
  const [locale, setLocale] = usePersistedLocale();
  useEffect(() => {
    if (active) Everygrid.setLocale(locale);
  }, [active, locale]);

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
            <LocaleSwitch value={locale} onChange={setLocale}/>
            <RowCountPicker value={rows} onChange={choose}/>
          </div>
          {/* Virtual scrolling needs a bounded height to scroll inside. */}
          <div id='virtual-grid' className='w-full border-slate-200 h-[560px] flex flex-col'/>
        </main>
      </div>
  );
}
