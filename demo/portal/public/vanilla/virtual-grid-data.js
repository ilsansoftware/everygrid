// Data source for the `virtual-grid` demo, kept out of index.html.
//
// The 100k-row set is generated in the page rather than shipped as JSON. 100k rows (~25 MB, plus a
// copy in the WASM worker) is fine on a desktop but kills a phone's tab, so the row count scales to
// the device: a coarse-pointer / narrow / mobile device — or a low-RAM one, when the browser reports
// navigator.deviceMemory — gets far fewer. Override with ?rows=500000 to force a size.
//
// Exposed as a global so the classic <script> in index.html can pass it to Everygrid.mount().
window.makeVirtualGridData = function () {
  const mem = navigator.deviceMemory; // GB (Chromium) or undefined
  const uaMobile = (navigator.userAgentData && navigator.userAgentData.mobile)
    || /Mobi|Android|iPhone|iPod|iPad/i.test(navigator.userAgent);
  const coarseNarrow = typeof matchMedia === 'function'
    && matchMedia('(pointer: coarse)').matches
    && navigator.maxTouchPoints > 0
    && Math.min(window.innerWidth || Infinity, (window.screen && window.screen.width) || Infinity) < 820;
  const constrained = uaMobile || coarseNarrow
    || Math.min(window.innerWidth || Infinity, (window.screen && window.screen.width) || Infinity) < 820;
  const deviceMax = constrained
    ? (mem ? Math.max(3000, Math.min(100000, mem * 3000)) : 5000)
    : (mem && mem <= 4 ? 25000 : 100000);
  const rows = parseInt(new URLSearchParams(location.search).get('rows'), 10) || deviceMax;
  const cities = ['Seoul', 'Busan', 'Incheon', 'Daegu', 'Daejeon', 'Gwangju', 'Ulsan'];
  const teams = ['Platform', 'Growth', 'Payments', 'Data', 'Infra', 'Design'];
  const out = new Array(rows);
  for (let i = 0; i < rows; i++) {
    out[i] = {
      id: i + 1,
      name: 'User ' + (i + 1),
      team: teams[i % teams.length],
      city: cities[i % cities.length],
      score: (i * 7919) % 1000,
      joinedDate: new Date(Date.UTC(2015 + (i % 10), i % 12, (i % 28) + 1))
        .toISOString().slice(0, 10),
      active: i % 3 !== 0,
    };
  }
  return Promise.resolve(out);
};
