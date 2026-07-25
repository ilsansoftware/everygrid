import {useEffect} from 'react';
import {Everygrid, I18n, loadEverygridConfig, createEverygrid} from '@everygrid/grid';

export type Locale = 'en' | 'ko';

// React demo — grids driven directly by the Everygrid API from a React component. (The two heavy
// grids — large-data + virtual scroll — live on their own tabs; see LargeDataDemo / VirtualScrollDemo.)
export default function ReactDemo({locale}: { locale: Locale }) {
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
      // No fetcher → shows the empty-state grid from its config.
      void createEverygrid('empty-grid');
      Everygrid.refreshAll();
    });
    // Unmount only this demo's own grids (not a global resetAutoInit) so the other React tabs,
    // which share the Everygrid singleton, keep theirs.
    return () => {
      cancelled = true;
      ['test-grid', 'test-grid2', 'test-grid3', 'api-grid', 'empty-grid'].forEach((id) => Everygrid.unmount(id));
    };
    // Mount/unmount only — locale and visibility are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply the locale when it changes (no-op until the grids exist). Column widths recompute on
  // show via the grid's own ResizeObserver, so no refresh-on-tab-change is needed here.
  useEffect(() => {
    I18n.setLocale(locale);
    Everygrid.rerenderAll();
  }, [locale]);

  return (
      <div className="max-w-7xl mx-auto">
        <main className="min-h-150 flex flex-col gap-8 py-8 bg-white">
          <div id="test-grid" className="w-full border-slate-200"/>
          <div id="test-grid2" className="w-full border-slate-200"/>
          <div id="test-grid3" className="w-full border-slate-200"/>
          <div id="api-grid" className="w-full border-slate-200"/>
          <div id="empty-grid" className="w-full border-slate-200"/>
        </main>
      </div>
  );
}
