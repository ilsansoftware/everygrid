import {useEffect} from 'react';
import {Everygrid, I18n, loadEverygridConfig, createEverygrid} from '@everygrid/grid';

export type Locale = 'en' | 'ko';

// The large-data grid streams the real 1.6M-row file. Its config sets `dataLimit: 'auto'`, so on a
// phone the library stops the stream at a device-safe count (and shows a banner) instead of loading
// the whole ~100MB and crashing the tab; a roomy desktop streams all of it.

// React demo — grids driven directly by the Everygrid API from a React component.
export default function ReactDemo({locale, active = true}: { locale: Locale; active?: boolean }) {
  // Create the grids once, tear them down on unmount (so a tab switch doesn't leak the singleton).
  useEffect(() => {
    let cancelled = false;
    I18n.setLocale(locale);
    // Sub-app config isn't at the site root — load it explicitly, then create each grid.
    void loadEverygridConfig(['/react/everygrid.config.json']).then(() => {
      if (cancelled) return;
      // Fire-and-forget: each grid paints a skeleton immediately, then fills in.
      void createEverygrid('test-grid', '/react/data.json');
      void createEverygrid('test-grid2', '/react/data2.json');
      void createEverygrid('test-grid3', '/react/data3.json');
      void createEverygrid('api-grid',
          () => fetch('https://jsonplaceholder.typicode.com/posts')
          .then(r => r.json()));
      // URL string → streamed (device-safe) instead of buffering ~100MB.
      void createEverygrid('large-data-grid', 'https://d3886c7yrxubj8.cloudfront.net/data/large_table_data.json');
      Everygrid.refreshAll();
    });
    return () => {
      cancelled = true;
      Everygrid.resetAutoInit();
    };
    // Mount/unmount only — locale and visibility are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply the locale when it changes; re-measure when the tab becomes visible again (a hidden
  // tab measures as zero-width, so column widths need recomputing on show). Both are no-ops until
  // the grids exist.
  useEffect(() => {
    I18n.setLocale(locale);
    Everygrid.refreshAll();
  }, [locale]);
  useEffect(() => {
    if (active) Everygrid.refreshAll();
  }, [active]);

  return (
      <div className="max-w-7xl mx-auto">
        <main className="min-h-150 flex flex-col gap-8 py-8 bg-white">
          <div id="test-grid" className="w-full border-slate-200"/>
          <div id="test-grid2" className="w-full border-slate-200"/>
          <div id="test-grid3" className="w-full border-slate-200"/>
          <div id="api-grid" className="w-full border-slate-200"/>
          <div id="large-data-grid" className="w-full border-slate-200"/>
          <div id="empty-grid" className="w-full border-slate-200"/>
        </main>
      </div>
  );
}
