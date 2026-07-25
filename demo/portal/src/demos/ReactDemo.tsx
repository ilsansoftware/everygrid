import { useGrid } from '@everygrid/grid';

export type Locale = 'en' | 'ko';

// React demo — grids driven directly by the Everygrid API from a React component. (The two heavy
// grids — large-data + virtual scroll — live on their own tabs; see LargeDataDemo / VirtualScrollDemo.)
// One useGrid line per grid; the hook owns create/teardown and auto-loads the root
// everygrid.config.json. Locale is applied app-wide in App.
export default function ReactDemo() {
  useGrid('test-grid', '/react/data.json');
  useGrid('test-grid2', '/react/data2.json');
  useGrid('test-grid3', '/react/data3.json');
  useGrid('api-grid', () => fetch('https://jsonplaceholder.typicode.com/posts').then(r => r.json()));
  useGrid('empty-grid'); // no fetcher → empty-state grid from its config

  return (
      <div className='max-w-7xl mx-auto'>
        <main className='min-h-150 flex flex-col gap-8 py-8 bg-white'>
          <div id='test-grid' className='w-full border-slate-200'/>
          <div id='test-grid2' className='w-full border-slate-200'/>
          <div id='test-grid3' className='w-full border-slate-200'/>
          <div id='api-grid' className='w-full border-slate-200'/>
          <div id='empty-grid' className='w-full border-slate-200'/>
        </main>
      </div>
  );
}
