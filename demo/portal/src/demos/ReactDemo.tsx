import {useEffect, useState} from 'react';
import {Everygrid, useGrid} from '@everygrid/grid';
import LocaleSwitch, {type Locale} from './LocaleSwitch';

// React demo — grids driven directly by the Everygrid API from a React component. (The two heavy
// grids — large-data + virtual scroll — live on their own tabs; see LargeDataDemo / VirtualScrollDemo.)
// One useGrid line per grid; the hook owns create/teardown and auto-loads the root
// everygrid.config.json.
export default function ReactDemo({active}: { active: boolean }) {
  // Language is per tab: applied through the API whenever this tab is the one on screen.
  const [locale, setLocale] = useState<Locale>('en');
  useEffect(() => {
    if (active) Everygrid.setLocale(locale);
  }, [active, locale]);

  useGrid('test-grid', '/react/data.json');
  useGrid('test-grid2', '/react/data2.json');
  useGrid('test-grid3', '/react/data3.json');
  useGrid('api-grid', () => fetch('https://jsonplaceholder.typicode.com/posts').then(r => r.json()));
  useGrid('empty-grid'); // no fetcher → empty-state grid from its config

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
          <div className='demo-tools'><LocaleSwitch value={locale} onChange={setLocale}/></div>
          <div id='test-grid' className='w-full border-slate-200'/>
          <div id='test-grid2' className='w-full border-slate-200'/>
          <div id='test-grid3' className='w-full border-slate-200'/>
          <div id='api-grid' className='w-full border-slate-200'/>
          <div id='empty-grid' className='w-full border-slate-200'/>
        </main>
      </div>
  );
}
