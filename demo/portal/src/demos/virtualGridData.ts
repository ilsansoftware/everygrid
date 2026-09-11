// Data for the virtual-scroll demo, kept out of VirtualScrollDemo.tsx so the portal's code modal
// shows only the grid usage.

// virtual-grid data, generated in the page (100k rows ≈ 25 MB + a copy in the WASM worker). Fine on a
// desktop but kills a phone's tab, so the starting row count scales to the device — a coarse /
// narrow / low-RAM device gets far fewer. The size picker takes over from there.
type Row = Record<string, unknown>;

/** The starting size: as much as the device looks able to take. The picker drives it after that. */
export function resolveRowCount(): number {
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
  return deviceMax;
}

/** Rows are built in slices with a yield between them so the tab stays responsive: a million rows
 *  in one loop locks the main thread for seconds, and the picker looks frozen for all of it. */
const BUILD_CHUNK = 50_000;

export async function makeVirtualGridData(rows: number): Promise<Row[]> {
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Ulsan'];
  const teams = ['Platform', 'Growth', 'Payments', 'Data', 'Infra', 'Design'];
  // The three date components cycle every 10, 12 and 28 rows, so the dates repeat every 420 — build
  // those once instead of constructing a million Date objects and formatting each one.
  const dates = Array.from({length: 420}, (_, i) =>
      new Date(Date.UTC(2015 + (i % 10), i % 12, (i % 28) + 1)).toISOString().slice(0, 10));

  const out: Row[] = new Array(rows);
  for (let start = 0; start < rows; start += BUILD_CHUNK) {
    const end = Math.min(start + BUILD_CHUNK, rows);
    for (let i = start; i < end; i++) {
      out[i] = {
        id: 'ID_' + (i + 1),
        name: 'User_' + (i + 1),
        team: teams[i % teams.length],
        city: cities[i % cities.length],
        score: (i * 7919) % 1000,
        joinedDate: dates[i % dates.length],
        active: i % 3 !== 0,
      };
    }
    if (end < rows) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return out;
}
