import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDemo from './demos/ReactDemo';
import reactSrc from './demos/ReactDemo.tsx?raw';
import type { Locale } from './lib/everygrid';

type TabId = 'react' | 'vanilla' | 'jquery';

const TABS: { id: TabId; title: string; icon: string }[] = [
  { id: 'react', title: 'React Demo', icon: '/react/favicon.ico' },
  { id: 'vanilla', title: 'Vanilla JS Demo', icon: '/vanilla/favicon.ico' },
  { id: 'jquery', title: 'jQuery Demo', icon: '/jquery/favicon.ico' },
];

const LOCALES: { id: Locale; flag: string; title: string }[] = [
  { id: 'ko', flag: '🇰🇷', title: '한국어' },
  { id: 'en', flag: '🇺🇸', title: 'English' },
];

// Language + label used by the "Show Code" modal per demo.
const CODE_META: Record<TabId, { hlLang: string; label: string }> = {
  react: { hlLang: 'typescript', label: 'tsx' },
  vanilla: { hlLang: 'xml', label: 'html' },
  jquery: { hlLang: 'xml', label: 'html' },
};

declare global {
  interface Window {
    hljs?: { highlightElement: (el: HTMLElement) => void };
  }
}

function isTabId(v: string | null): v is TabId {
  return v === 'react' || v === 'vanilla' || v === 'jquery';
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
  // Source of each html demo, once fetched. State rather than a ref, so the modal can
  // derive its text during render instead of a ref read + setState round trip.
  const [codeByTab, setCodeByTab] = useState<Partial<Record<TabId, string>>>({});

  const codeRef = useRef<HTMLElement>(null);
  const frameRefs = useRef<Partial<Record<TabId, HTMLIFrameElement | null>>>({});
  // Lets the 'ready' listener below read the current locale without resubscribing on
  // every locale change.
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

  // Persist tab + reflect it in the URL hash.
  useEffect(() => {
    localStorage.setItem('eg-portal-tab', tab);
    if (window.location.hash.replace('#', '') !== tab) {
      window.history.pushState({ tab }, '', `#${tab}`);
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

  // When a demo iframe signals it is ready, push the current locale to it.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'ready') {
        (e.source as Window | null)?.postMessage(
          { type: 'setLocale', locale: localeRef.current },
          '*',
        );
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
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

  // Broadcast locale changes to the active iframe demo (React demo reads it via props).
  useEffect(() => {
    if (tab !== 'react') {
      frameRefs.current[tab]?.contentWindow?.postMessage({ type: 'setLocale', locale }, '*');
    }
  }, [locale, tab]);

  // The React demo's source is bundled at build time; the html demos are fetched once and
  // then reused, so the text to show is derived rather than mirrored into state.
  const codeText = tab === 'react' ? reactSrc : (codeByTab[tab] ?? 'Loading...');

  // Fetch an html demo's source the first time its modal is opened.
  useEffect(() => {
    if (!modalOpen || tab === 'react' || codeByTab[tab]) return;
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

  // Re-highlight whenever the modal content changes.
  useLayoutEffect(() => {
    if (modalOpen && codeRef.current) {
      delete codeRef.current.dataset.highlighted;
      window.hljs?.highlightElement(codeRef.current);
    }
  }, [modalOpen, codeText]);

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
        <h1>Every Grid Demo</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={t.id === tab ? 'active' : ''}
              data-tab={t.id}
              title={t.title}
              onClick={() => setTab(t.id)}
            >
              <img src={t.icon} width="100%" height="100%" alt={t.title} />
            </button>
          ))}
        </nav>
        <div className="header-right">
          <div className="locale-btn-group">
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
          <button className="show-code-btn" title="Show source code" onClick={() => setModalOpen(true)}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </button>
        </div>
      </header>

      <div className="demo-panel">
        {TABS.filter((t) => mounted.has(t.id)).map((t) =>
          t.id === 'react' ? (
            <div key={t.id} hidden={t.id !== tab}>
              <ReactDemo locale={locale} active={t.id === tab} />
            </div>
          ) : (
            <iframe
              key={t.id}
              ref={(el) => {
                frameRefs.current[t.id] = el;
              }}
              className="demo-frame"
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

      <div
        className={`code-modal-overlay${modalOpen ? ' open' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setModalOpen(false);
        }}
      >
        <div className="code-modal">
          <div className="code-modal-header">
            <span className="code-modal-title">
              Source Code
              <span className="code-modal-lang">{meta.label}</span>
            </span>
            <button className="code-modal-close" title="Close" onClick={() => setModalOpen(false)}>
              ✕
            </button>
          </div>
          <div className="code-modal-body">
            <pre>
              {/* key forces a fresh node so highlight.js re-runs cleanly */}
              <code key={`${tab}-${codeText.length}`} ref={codeRef} className={`language-${meta.hlLang}`}>
                {codeText}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </>
  );
}
