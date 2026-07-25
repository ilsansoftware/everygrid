import {useEffect} from 'react';
import {Everygrid, I18n, loadEverygridConfig, createEverygrid} from '@everygrid/grid';
import type {Locale} from './ReactDemo';

// Virtual-scroll demo — a 100k-row grid that renders only the rows in view, on its own tab.
export default function VirtualScrollDemo({locale}: { locale: Locale }) {
  useEffect(() => {
    let cancelled = false;
    I18n.setLocale(locale);
    void loadEverygridConfig(['/react/everygrid.config.json']).then(() => {
      if (cancelled) return;
      void createEverygrid('virtual-grid', makeVirtualGridData);
      Everygrid.refreshAll();
    });
    // Unmount only this demo's grid (not a global resetAutoInit) — the other React tabs share the
    // Everygrid singleton.
    return () => {
      cancelled = true;
      Everygrid.unmount('virtual-grid');
    };
    // Mount/unmount only — locale and visibility are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    I18n.setLocale(locale);
    Everygrid.rerenderAll();
  }, [locale]);

  return (
      <div className="max-w-7xl mx-auto">
        <main className="min-h-150 flex flex-col gap-8 py-8 bg-white">
          {/* Virtual scrolling needs a bounded height to scroll inside. */}
          <div id="virtual-grid" className="w-full border-slate-200 h-[560px] flex flex-col"/>
        </main>
      </div>
  );
}

type Row = Record<string, unknown>;

// virtual-grid data, generated in the page (100k rows ≈ 25 MB + a copy in the WASM worker). Fine on a
// desktop but kills a phone's tab, so the row count scales to the device — a coarse / narrow / low-RAM
// device gets far fewer. Override with ?rows=500000 to force a size.
function makeVirtualGridData(): Promise<Row[]> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean }
  };
  const mem = nav.deviceMemory; // GB (Chromium) or undefined
  const width = Math.min(window.innerWidth || Infinity, window.screen?.width || Infinity);
  const uaMobile = !!nav.userAgentData?.mobile || /Mobi|Android|iPhone|iPod|iPad/i.test(nav.userAgent);
  const coarseNarrow = typeof matchMedia === 'function'
      && matchMedia('(pointer: coarse)').matches && nav.maxTouchPoints > 0 && width < 820;
  const constrained = uaMobile || coarseNarrow || width < 820;
  const deviceMax = constrained
      ? (mem ? Math.max(3000, Math.min(100000, mem * 3000)) : 5000)
      : (mem && mem <= 4 ? 25000 : 100000);
  const rows = parseInt(new URLSearchParams(location.search).get('rows') ?? '', 10) || deviceMax;
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Ulsan'];
  const teams = ['Platform', 'Growth', 'Payments', 'Data', 'Infra', 'Design'];
  const out: Row[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    out[i] = {
      id: 'ID_' + (i + 1),
      name: 'User_' + (i + 1),
      team: teams[i % teams.length],
      city: cities[i % cities.length],
      score: (i * 7919) % 1000,
      joinedDate: new Date(Date.UTC(2015 + (i % 10), i % 12, (i % 28) + 1)).toISOString().slice(0, 10),
      active: i % 3 !== 0,
    };
  }
  return Promise.resolve(out);
}
