import { useEverygridDemo } from '../lib/useEverygridDemo';
import type { Locale } from '../lib/everygrid';

// The large-data grid streams the real 1.6M-row file. Its config sets `dataLimit: 'auto'`, so on a
// phone the library stops the stream at a device-safe count (and shows a banner) instead of loading
// the whole ~100MB and crashing the tab; a roomy desktop streams all of it.

// React demo — grids driven directly by the Everygrid API from a React component.
export default function ReactDemo({ locale, active = true }: { locale: Locale; active?: boolean }) {
  useEverygridDemo(
    locale,
    (EG) =>
    EG.autoInit(
      {
        'test-grid': '/react/data.json',
        'test-grid2': '/react/data2.json',
        'test-grid3': '/react/data3.json',
        'api-grid': 'https://jsonplaceholder.typicode.com/posts',
        'large-data-grid': 'https://d3886c7yrxubj8.cloudfront.net/data/large_table_data.json',
      },
      '/react/everygrid.config.json',
    ),
    active,
  );

  return (
    <div className="max-w-7xl mx-auto">
      <main className="min-h-150 flex flex-col gap-8 py-8 bg-white">
        <div id="test-grid" className="w-full border-slate-200" />
        <div id="test-grid2" className="w-full border-slate-200" />
        <div id="test-grid3" className="w-full border-slate-200" />
        <div id="api-grid" className="w-full border-slate-200" />
        <div id="large-data-grid" className="w-full border-slate-200" />
        <div id="empty-grid" className="w-full border-slate-200" />
      </main>
    </div>
  );
}