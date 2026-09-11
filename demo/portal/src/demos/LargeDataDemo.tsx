import {useEffect, useState} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';
import LocaleSwitch, {type Locale} from './LocaleSwitch';

// Large-data demo — the streaming 1.6M-row grid on its own tab. Its config sets `dataLimit: 'auto'`,
// so on a phone the library stops the stream at a device-safe count (and shows a banner) instead of
// loading the whole ~100MB and crashing the tab; a roomy desktop streams all of it.
// URL string fetcher → streamed (device-safe) instead of buffering ~100MB.
export default function LargeDataDemo({active}: { active: boolean }) {
  // Language is per tab: applied through the API whenever this tab is the one on screen.
  const [locale, setLocale] = useState<Locale>('en');
  useEffect(() => {
    if (active) Everygrid.setLocale(locale);
  }, [active, locale]);

  useGrid('large-data-grid', 'https://d3886c7yrxubj8.cloudfront.net/data/large_table_data.json');

  return (
    <div className='max-w-7xl mx-auto'>
      <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
        <div className='demo-tools'><LocaleSwitch value={locale} onChange={setLocale}/></div>
        <div id='large-data-grid' className='w-full border-slate-200' />
      </main>
    </div>
  );
}
