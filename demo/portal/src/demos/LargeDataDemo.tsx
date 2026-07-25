import { useEffect } from 'react';
import { Everygrid, I18n, loadEverygridConfig, createEverygrid } from '@everygrid/grid';
import type { Locale } from './ReactDemo';

// Large-data demo — the streaming 1.6M-row grid on its own tab. Its config sets `dataLimit: 'auto'`,
// so on a phone the library stops the stream at a device-safe count (and shows a banner) instead of
// loading the whole ~100MB and crashing the tab; a roomy desktop streams all of it.
export default function LargeDataDemo({ locale }: { locale: Locale }) {
  useEffect(() => {
    let cancelled = false;
    I18n.setLocale(locale);
    // Sub-app config isn't at the site root — load it explicitly, then create the grid.
    void loadEverygridConfig(['/react/everygrid.config.json']).then(() => {
      if (cancelled) return;
      // URL string → streamed (device-safe) instead of buffering ~100MB.
      void createEverygrid('large-data-grid', 'https://d3886c7yrxubj8.cloudfront.net/data/large_table_data.json');
      Everygrid.refreshAll();
    });
    // Unmount only this demo's grid (not a global resetAutoInit) — the other React tabs share the
    // Everygrid singleton.
    return () => { cancelled = true; Everygrid.unmount('large-data-grid'); };
    // Mount/unmount only — locale and visibility are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { I18n.setLocale(locale); Everygrid.rerenderAll(); }, [locale]);

  return (
    <div className="max-w-7xl mx-auto">
      <main className="min-h-150 flex flex-col gap-8 py-8 bg-white">
        <div id="large-data-grid" className="w-full border-slate-200" />
      </main>
    </div>
  );
}
