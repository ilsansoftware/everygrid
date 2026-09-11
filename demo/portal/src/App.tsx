import {useEffect, useRef, useState} from 'react';
import {Highlight, themes} from 'prism-react-renderer';
import {Everygrid, type GridLoadProgress} from '@everygrid/grid';
import ReactDemo from './demos/ReactDemo';
import LargeDataDemo from './demos/LargeDataDemo';
import VirtualScrollDemo from './demos/VirtualScrollDemo';
import SandboxDemo from './demos/SandboxDemo';
import DocsPage from './demos/DocsPage';
import reactSrc from './demos/ReactDemo.tsx?raw';
import largeSrc from './demos/LargeDataDemo.tsx?raw';
import virtualSrc from './demos/VirtualScrollDemo.tsx?raw';

type TabId = 'react' | 'vanilla' | 'jquery' | 'large' | 'virtual' | 'sandbox' | 'docs';

// React-based tabs (rendered inline) vs. iframe demos.
const REACT_TABS: TabId[] = ['react', 'large', 'virtual', 'sandbox', 'docs'];

// Tabs whose grid streams/indexes long enough to be worth a progress indicator on the nav button —
// keyed to the grid's container id so App can poll Everygrid.getLoadProgress while the tab is hidden.
const PROGRESS_GRID_OF_TAB: Partial<Record<TabId, string>> = {
  large: 'large-data-grid',
  virtual: 'virtual-grid',
  sandbox: 'sandbox-grid',
};

// Compact row count for the nav badge: 1_600_000 → '1.6M', 25_000 → '25k'.
function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// `icon` tabs show a favicon with a short name beside it; `label` tabs (the React-only heavy demos)
// show text alone. `caption` is the one-liner under the page title.
// Demos share the header capsule; a `tool` (acts on your data) is a standalone button beside it.
// Demos share a labelled capsule each: the framework demos, then the scale demos.
type TabGroup = 'demo' | 'scale' | 'tool';
const GROUP_LABEL: Partial<Record<TabGroup, string>> = {demo: 'Demo', scale: 'Scale'};
const TABS: { id: TabId; title: string; caption?: string; icon?: string; name?: string; label?: string; group?: TabGroup }[] = [
  {id: 'react', title: 'Demo - React', icon: '/react/favicon.ico', name: 'React'},
  {id: 'vanilla', title: 'Demo - Vanilla JS', icon: '/vanilla/favicon.ico', name: 'JS'},
  {id: 'jquery', title: 'Demo - jQuery', icon: '/jquery/logo.svg', name: 'jQuery'},
  {id: 'large', title: 'Large Data', caption: 'streaming 1.6M rows', label: 'large\ndata', group: 'scale'},
  {id: 'virtual', title: 'Virtual Scroll', label: 'virtual\nscroll', group: 'scale'},
  {id: 'sandbox', title: 'JSON to Grid', caption: 'drop a file, get a grid', label: 'json to grid', group: 'tool'},
  {id: 'docs', title: 'API Docs', label: 'api docs', group: 'tool'},
];

// Tabs that are tools rather than demos: nothing to show under 'Show Code'.
const NO_CODE_TABS: TabId[] = ['sandbox', 'docs'];

// Prism language + label used by the 'Show Code' modal per demo. ('markup' is Prism's name for HTML.)
const CODE_META: Record<TabId, { lang: string; label: string }> = {
  react: {lang: 'tsx', label: 'tsx'},
  vanilla: {lang: 'markup', label: 'html'},
  jquery: {lang: 'markup', label: 'html'},
  large: {lang: 'tsx', label: 'tsx'},
  virtual: {lang: 'tsx', label: 'tsx'},
  sandbox: {lang: 'tsx', label: 'tsx'},
  docs: {lang: 'tsx', label: 'tsx'},
};

function isTabId(v: string | null): v is TabId {
  return v === 'react' || v === 'vanilla' || v === 'jquery' || v === 'large' || v === 'virtual' || v === 'sandbox' || v === 'docs';
}

// Tabs dropped on a phone: the large-data demo streams 1.6M rows, too heavy to feature on mobile.
const MOBILE_HIDDEN_TABS: TabId[] = ['large'];
const NARROW_QUERY = '(max-width: 640px)';
function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(NARROW_QUERY).matches;
}

function initialTab(): TabId {
  const hash = window.location.hash.replace('#', '');
  const saved = localStorage.getItem('eg-portal-tab');
  const resolved: TabId = isTabId(hash) ? hash : isTabId(saved) ? saved : 'react';
  // Don't open a mobile-hidden tab (e.g. entering via #large on a phone) — its tab wouldn't show.
  return isNarrowViewport() && MOBILE_HIDDEN_TABS.includes(resolved) ? 'react' : resolved;
}

export default function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [modalOpen, setModalOpen] = useState(false);
  const frameRefs = useRef<Partial<Record<TabId, HTMLIFrameElement | null>>>({});
  // Source of each HTML demo, once fetched. State rather than a ref, so the modal can
  // derive its text during render instead of a ref read + setState round trip.
  const [codeByTab, setCodeByTab] = useState<Partial<Record<TabId, string>>>({});

  // Keep-alive: a tab is mounted the first time it is opened and then stays mounted,
  // hidden rather than unmounted. Unmounting tore down the Everygrid instance (via the
  // hook's resetAutoInit) and recreated the iframe, so every tab switch re-fetched every
  // dataset and re-indexed the streaming grid into WASM from scratch.
  const [mounted, setMounted] = useState<Set<TabId>>(() => new Set([tab]));

  // Narrow (phone) viewport → drop the mobile-hidden tabs. Redirect off one if the viewport shrank
  // while it was active (entering on it is already prevented by initialTab).
  const [isNarrow, setIsNarrow] = useState(isNarrowViewport);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = () => setIsNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  if (isNarrow && MOBILE_HIDDEN_TABS.includes(tab)) setTab('react');

  // Synced during rendering rather than in an effect, to avoid a cascading render.
  if (!mounted.has(tab)) setMounted(new Set(mounted).add(tab));

  // Live load progress per grid id, so the nav can show a streaming/indexing bar for a tab whose
  // grid is loading in the background (keep-alive keeps it mounted after you switch away).
  const [loadProgress, setLoadProgress] = useState<Record<string, GridLoadProgress>>({});
  const seenActiveRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const gids = [...mounted]
      .map((t) => PROGRESS_GRID_OF_TAB[t])
      .filter((g): g is string => !!g);
    if (gids.length === 0) return;
    let timer = 0;
    const poll = () => {
      const readings = gids.map((g) => [g, Everygrid.getLoadProgress(g)] as const);
      setLoadProgress((prev) => {
        let changed = false;
        const next = {...prev};
        for (const [g, p] of readings) {
          if (!p) continue;
          if (p.active) seenActiveRef.current.add(g);
          const old = prev[g];
          if (!old || old.active !== p.active || old.percent !== p.percent || old.rowsLoaded !== p.rowsLoaded) {
            next[g] = p;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Stop once every tracked grid has been observed and none is still loading. The seenActive /
      // rowsLoaded guard avoids stopping in the gap between mount and the stream actually starting.
      const settled = readings.every(([g, p]) => p && !p.active && (seenActiveRef.current.has(g) || p.rowsLoaded > 0));
      if (!settled) timer = window.setTimeout(poll, 300);
    };
    timer = window.setTimeout(poll, 100);
    return () => clearTimeout(timer);
  }, [mounted]);

  // Persist tab + reflect it in the URL hash.
  useEffect(() => {
    localStorage.setItem('eg-portal-tab', tab);
    if (window.location.hash.replace('#', '') !== tab) {
      window.history.pushState({tab}, '', `#${tab}`);
    }
  }, [tab]);

  // Back/forward navigation between tabs.
  useEffect(() => {
    const onPop = () => {
      const hash = window.location.hash.replace('#', '');
      if (isTabId(hash)) setTab(hash);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Dev hot-swap for the html demos: when the library's --watch build rewrites the standalone,
  // the vite plugin (see vite.config.ts) fires this event and we reload the affected iframes —
  // the closest thing to the React demo's HMR for the vanilla / jquery tabs.
  useEffect(() => {
    if (!import.meta.hot) return;
    const reload = () => {
      for (const id of ['vanilla', 'jquery'] as const) {
        // Same-origin iframe → reload its document to pick up the freshly built standalone bundle.
        frameRefs.current[id]?.contentWindow?.location.reload();
      }
    };
    import.meta.hot.on('everygrid:standalone-updated', reload);
    return () => import.meta.hot?.off('everygrid:standalone-updated', reload);
  }, []);

  // The React demo's source is bundled at build time; the html demos are fetched once and
  // then reused, so the text to show is derived rather than mirrored into state.
  const codeText = tab === 'react' ? reactSrc
      : tab === 'large' ? largeSrc
          : tab === 'virtual' ? virtualSrc
              : (codeByTab[tab] ?? 'Loading...');

  // Fetch a html demo's source the first time its modal is opened (React tabs are bundled).
  useEffect(() => {
    if (!modalOpen || REACT_TABS.includes(tab) || codeByTab[tab]) return;
    let cancelled = false;
    const store = (text: string) => {
      if (!cancelled) setCodeByTab((prev) => ({...prev, [tab]: text}));
    };
    fetch(`/${tab}/index.html`)
    .then((r) => r.text())
    .then(store)
    .catch(() => store('// Failed to load source code'));
    return () => {
      cancelled = true;
    };
  }, [modalOpen, tab, codeByTab]);

  // Close the modal on Escape.
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  const meta = CODE_META[tab];

  const current = TABS.find((t) => t.id === tab);

  const tabsOf = (group: TabGroup) => TABS.filter((t) =>
      (t.group ?? 'demo') === group && !(isNarrow && MOBILE_HIDDEN_TABS.includes(t.id)));
  const renderTab = (t: typeof TABS[number]) => {
      const gid = PROGRESS_GRID_OF_TAB[t.id];
      const prog = gid ? loadProgress[gid] : undefined;
      // Badge is a heads-up for a grid loading on a tab you've left — on the active tab the
      // grid's own toolbar already shows its progress, so it's redundant there.
      const loading = !!prog?.active && t.id !== tab;
      return (
        <button
            key={t.id}
            className={t.id === tab ? 'active' : ''}
            data-tab={t.id}
            title={t.title}
            onClick={() => setTab(t.id)}
        >
          {t.label
              ? <span className={`tab-label${loading ? ' is-loading' : ''}`}>
                  <span className='tab-label-text'>{t.label}</span>
                  {loading && (
                    <span className='tab-progress-badge'>
                      {prog!.percent >= 0 ? `${prog!.percent}%` : compactCount(prog!.rowsLoaded)}
                    </span>
                  )}
                </span>
              : <>
                  <img src={t.icon} width='100%' height='100%' alt=''/>
                  <span className='tab-name'>{t.name}</span>
                </>}
        </button>
      );
  };

  // Lives beside the page title, next to the demo it shows the source of; the header keeps it only
  // on a phone, where the title row is dropped. Tools have no demo source, so there it is not shown.
  const codeButton = NO_CODE_TABS.includes(tab) ? null : (
    <button className='show-code-btn' title='Show source code'
            onClick={() => setModalOpen(true)}>
      <svg
          xmlns='http://www.w3.org/2000/svg'
          width='18'
          height='18'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2.2'
          strokeLinecap='round'
          strokeLinejoin='round'
      >
        <path d='m18 16 4-4-4-4'/>
        <path d='m6 8-4 4 4 4'/>
        <path d='m14.5 4-5 16'/>
      </svg>
      {!isNarrow && <span>Code</span>}
    </button>
  );

  return (
      <>
        <header>
          <h1>everygrid</h1>
          {(['demo', 'scale'] as TabGroup[]).map((group) => (
            <nav key={group} aria-label={GROUP_LABEL[group]}>
              <span className='nav-group-label'>{GROUP_LABEL[group]}</span>
              {tabsOf(group).map(renderTab)}
            </nav>
          ))}
          {/* Tools stand outside the capsule as buttons of their own. */}
          <div className='tool-tabs'>{tabsOf('tool').map(renderTab)}</div>
          {isNarrow && codeButton}
        </header>

        <div className='demo-panel'>
          {/* Heading sits OUTSIDE the scroll area (fixed above), otherwise a grid's sticky header
            would pin to the panel top and cover it. Dropped entirely on mobile to save space. */}
          {!isNarrow && (
            <div className='demo-heading'>
              {/* Caption on the title's line, so the row is the same height on every tab. */}
              <div className='demo-heading-title'>
                <h2>{current?.title}</h2>
                {current?.caption && <span className='demo-caption'>{current.caption}</span>}
              </div>
              {codeButton}
            </div>
          )}
          <div className='demo-scroll'>
            {TABS.filter((t) => mounted.has(t.id)).map((t) =>
                REACT_TABS.includes(t.id) ? (
                    <div key={t.id} hidden={t.id !== tab}>
                      {t.id === 'react' ? (
                          <ReactDemo active={t.id === tab}/>
                      ) : t.id === 'large' ? (
                          <LargeDataDemo active={t.id === tab}/>
                      ) : t.id === 'virtual' ? (
                          <VirtualScrollDemo active={t.id === tab}/>
                      ) : t.id === 'sandbox' ? (
                          <SandboxDemo active={t.id === tab}/>
                      ) : (
                          <DocsPage/>
                      )}
                    </div>
                ) : (
                    <iframe
                        key={t.id}
                        ref={(el) => {
                          frameRefs.current[t.id] = el;
                        }}
                        className='demo-frame'
                        hidden={t.id !== tab}
                        // Use the explicit file path: the vite dev server does not serve a
                        // nested public/<demo>/index.html for the bare "/<demo>/" directory
                        // URL (it falls back to the SPA root, nesting the whole portal).
                        src={`/${t.id}/index.html`}
                        title={t.title}
                    />
                ),
            )}
          </div>
        </div>

        <footer className='portal-footer'>
          <span className='portal-footer-brand'>Everygrid</span>
          <span className='portal-footer-tagline'>Config-driven data grid · Rust → WASM</span>
          <span className='portal-footer-copy'>© {new Date().getFullYear()}</span>
        </footer>

        <div
            className={`code-modal-overlay${modalOpen ? ' open' : ''}`}
            onClick={(e) => {
              if (e.target === e.currentTarget) setModalOpen(false);
            }}
        >
          <div className='code-modal'>
            <div className='code-modal-header'>
            <span className='code-modal-title'>
              Source Code
              <span className='code-modal-lang'>{meta.label}</span>
            </span>
              <button className='code-modal-close' title='Close'
                      onClick={() => setModalOpen(false)}>
                ✕
              </button>
            </div>
            <div className='code-modal-body'>
              <Highlight code={codeText} language={meta.lang} theme={themes.nightOwl}>
                {({className, style, tokens, getLineProps, getTokenProps}) => (
                  <pre className={className} style={style}>
                    {tokens.map((line, i) => (
                      <div key={i} {...getLineProps({line})}>
                        {line.map((token, key) => (
                          <span key={key} {...getTokenProps({token})} />
                        ))}
                      </div>
                    ))}
                  </pre>
                )}
              </Highlight>
            </div>
          </div>
        </div>
      </>
  );
}
