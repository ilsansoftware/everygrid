import {useCallback, useEffect, useRef, useState} from 'react';
import {Highlight, themes} from 'prism-react-renderer';
import {Everygrid, type GridLoadProgress} from '@everygrid/grid';
import ReactDemo, {type Locale} from './demos/ReactDemo';
import LargeDataDemo from './demos/LargeDataDemo';
import VirtualScrollDemo from './demos/VirtualScrollDemo';
import reactSrc from './demos/ReactDemo.tsx?raw';
import largeSrc from './demos/LargeDataDemo.tsx?raw';
import virtualSrc from './demos/VirtualScrollDemo.tsx?raw';

type TabId = 'react' | 'vanilla' | 'jquery' | 'large' | 'virtual';

// React-based tabs (rendered inline) vs. iframe demos.
const REACT_TABS: TabId[] = ['react', 'large', 'virtual'];

// Tabs whose grid streams/indexes long enough to be worth a progress indicator on the nav button —
// keyed to the grid's container id so App can poll Everygrid.getLoadProgress while the tab is hidden.
const PROGRESS_GRID_OF_TAB: Partial<Record<TabId, string>> = {
  large: 'large-data-grid',
  virtual: 'virtual-grid',
};

// Compact row count for the nav badge: 1_600_000 → '1.6M', 25_000 → '25k'.
function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// `icon` tabs show a favicon; `label` tabs (the React-only heavy demos) show text instead.
const TABS: { id: TabId; title: string; icon?: string; label?: string }[] = [
  {id: 'react', title: 'React Demo', icon: '/react/favicon.ico'},
  {id: 'vanilla', title: 'Vanilla JS Demo', icon: '/vanilla/favicon.ico'},
  {id: 'jquery', title: 'jQuery Demo', icon: '/jquery/favicon.ico'},
  {id: 'large', title: 'Large Data — streaming 1.6M rows', label: 'large data'},
  {id: 'virtual', title: 'Virtual Scroll — 100k rows', label: 'virtual scroll'},
];

const LOCALES: { id: Locale; flag: string; title: string }[] = [
  {id: 'ko', flag: '🇰🇷', title: '한국어'},
  {id: 'en', flag: '🇺🇸', title: 'English'},
];

// Prism language + label used by the 'Show Code' modal per demo. ('markup' is Prism's name for HTML.)
const CODE_META: Record<TabId, { lang: string; label: string }> = {
  react: {lang: 'tsx', label: 'tsx'},
  vanilla: {lang: 'markup', label: 'html'},
  jquery: {lang: 'markup', label: 'html'},
  large: {lang: 'tsx', label: 'tsx'},
  virtual: {lang: 'tsx', label: 'tsx'},
};

function isTabId(v: string | null): v is TabId {
  return v === 'react' || v === 'vanilla' || v === 'jquery' || v === 'large' || v === 'virtual';
}

function initialTab(): TabId {
  const hash = window.location.hash.replace('#', '');
  if (isTabId(hash)) return hash;
  const saved = localStorage.getItem('eg-portal-tab');
  return isTabId(saved) ? saved : 'react';
}

function initialLocale(): Locale {
  const saved = localStorage.getItem('eg-portal-locale');
  return saved === 'ko' || saved === 'en' ? saved : 'en';
}

export default function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [modalOpen, setModalOpen] = useState(false);
  // Source of each HTML demo, once fetched. State rather than a ref, so the modal can
  // derive its text during render instead of a ref read + setState round trip.
  const [codeByTab, setCodeByTab] = useState<Partial<Record<TabId, string>>>({});

  const frameRefs = useRef<Partial<Record<TabId, HTMLIFrameElement | null>>>({});
  // Lets the iframe onLoad handler read the current locale without a stale closure.
  const localeRef = useRef(locale);
  useEffect(() => {
    localeRef.current = locale;
  }, [locale]);

  // Keep-alive: a tab is mounted the first time it is opened and then stays mounted,
  // hidden rather than unmounted. Unmounting tore down the Everygrid instance (via the
  // hook's resetAutoInit) and recreated the iframe, so every tab switch re-fetched every
  // dataset and re-indexed the streaming grid into WASM from scratch.
  const [mounted, setMounted] = useState<Set<TabId>>(() => new Set([tab]));
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

  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    localStorage.setItem('eg-portal-locale', next);
  }, []);

  // Apply the locale to the in-app (React) grids once, here — not per demo component, which would
  // run rerenderAll once per mounted React tab. The iframe demos get it via postMessage below.
  useEffect(() => {
    Everygrid.setLocale(locale);
  }, [locale]);

  // Broadcast locale changes to the active iframe demo (its page called Everygrid.listenForLocale()).
  useEffect(() => {
    if (!REACT_TABS.includes(tab)) {
      const win = frameRefs.current[tab]?.contentWindow;
      if (win) Everygrid.sendLocale(win, locale);
    }
  }, [locale, tab]);

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

  return (
      <>
        <header>
          <h1>everygrid Demo</h1>
          <nav>
            {TABS.map((t) => {
              const gid = PROGRESS_GRID_OF_TAB[t.id];
              const prog = gid ? loadProgress[gid] : undefined;
              const loading = !!prog?.active;
              return (
                <button
                    key={t.id}
                    className={t.id === tab ? 'active' : ''}
                    data-tab={t.id}
                    title={t.title}
                    onClick={() => setTab(t.id)}
                >
                  {t.label
                      ? <span className='tab-label'>
                          {t.label}
                          {loading && (
                            <span className='tab-progress-badge'>
                              {prog!.percent >= 0 ? `${prog!.percent}%` : compactCount(prog!.rowsLoaded)}
                            </span>
                          )}
                        </span>
                      : <img src={t.icon} width='100%' height='100%' alt={t.title}/>}
                </button>
              );
            })}
          </nav>
          <div className='header-right'>
            <div className='locale-btn-group'>
              {LOCALES.map((l) => (
                  <button
                      key={l.id}
                      className={`locale-btn${l.id === locale ? ' active' : ''}`}
                      data-locale={l.id}
                      title={l.title}
                      onClick={() => changeLocale(l.id)}
                  >
                    {l.flag}
                  </button>
              ))}
            </div>
            <button className='show-code-btn' title='Show source code'
                    onClick={() => setModalOpen(true)}>
              <svg
                  xmlns='http://www.w3.org/2000/svg'
                  width='14'
                  height='14'
                  viewBox='0 0 24 24'
                  fill='none'
                  stroke='currentColor'
                  strokeWidth='2'
                  strokeLinecap='round'
                  strokeLinejoin='round'
              >
                <polyline points='16 18 22 12 16 6'/>
                <polyline points='8 6 2 12 8 18'/>
              </svg>
            </button>
          </div>
        </header>

        <div className='demo-panel'>
          {/* One heading for the active tab, OUTSIDE the scroll area — otherwise a grid's sticky
            header pins to the panel top and covers it. */}
          <h2 className='demo-heading'>{TABS.find((t) => t.id === tab)?.title}</h2>
          <div className='demo-scroll'>
            {TABS.filter((t) => mounted.has(t.id)).map((t) =>
                REACT_TABS.includes(t.id) ? (
                    <div key={t.id} hidden={t.id !== tab}>
                      {t.id === 'react' ? (
                          <ReactDemo/>
                      ) : t.id === 'large' ? (
                          <LargeDataDemo/>
                      ) : (
                          <VirtualScrollDemo/>
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
                        // Portal-driven locale sync: once the iframe's document (and its
                        // listenForLocale) has loaded, push the current locale. No 'ready' handshake
                        // needed — the listener is registered synchronously, before this fires.
                        onLoad={(e) => {
                          const win = e.currentTarget.contentWindow;
                          if (win) Everygrid.sendLocale(win, localeRef.current);
                        }}
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
