// This is a library public-API entry (`@everygrid/grid/react`), not a Vite app component module, so
// it intentionally exports a hook + a component + a type together — react-refresh's "components only"
// rule doesn't apply to a consumed package entry.
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Everygrid } from '../core/Everygrid';

type Fetcher = string | (() => Promise<Record<string, unknown>[]>);

// Deferred unmounts, keyed by grid id, so React StrictMode's transient mount→unmount→mount can
// cancel the teardown before it runs — and so a real unmount tears down from a timeout, never
// synchronously while React is rendering (which would warn on the grid's own React root).
const pendingUnmount = new Map<string, ReturnType<typeof setTimeout>>();
// resetAutoInit already destroys every grid; a teardown still pending from before it must not fire
// afterwards and unmount a grid mounted anew under the same id.
Everygrid._resetHooks.add(() => {
  pendingUnmount.forEach(timer => clearTimeout(timer));
  pendingUnmount.clear();
});

/**
 * Mount an Everygrid grid for the life of the component that renders its `<div id={id}/>`.
 *
 * One line per grid: it creates the grid (config is auto-loaded from the app-root
 * `everygrid.config.json`) and tears it down on unmount. `mount` coalesces concurrent creates of the
 * same id, and the teardown is deferred + cancelled on remount, so React StrictMode's double-invoke
 * neither double-creates nor unmounts a root mid-render.
 */
export function useGrid(id: string, fetcher?: Fetcher): void {
  // The grid is created once per id, but the fetcher it was given can close over component state
  // (a size picker, a filter). Registering a wrapper that reads the latest one means a reload runs
  // the fetcher as currently rendered, rather than the one captured at mount.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  useEffect(() => {
    const pending = pendingUnmount.get(id);
    if (pending !== undefined) {
      clearTimeout(pending);
      pendingUnmount.delete(id);
    }
    const initial = fetcher;
    const source: Fetcher | undefined = typeof initial === 'function'
      ? () => {
          const latest = fetcherRef.current;
          return typeof latest === 'function' ? latest() : initial();
        }
      : initial;
    void Everygrid.mountGrid(id, source);

    return () => {
      pendingUnmount.set(id, setTimeout(() => {
        pendingUnmount.delete(id);
        Everygrid.unmountGrid(id);
      }, 0));
    };
    // Remount only when the id changes; a new fetcher identity shouldn't rebuild the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

export interface EverygridGridProps {
  id: string;
  fetcher?: Fetcher;
  className?: string;
  style?: CSSProperties;
}

/** Renders the grid's container `<div>` and manages its lifecycle via {@link useGrid}. */
export function EverygridGrid({ id, fetcher, className, style }: EverygridGridProps) {
  useGrid(id, fetcher);
  return <div id={id} className={className} style={style} />;
}

type Locale = 'ko' | 'en';

/** Options shared by the React locale bindings — the same as {@link Everygrid.mountLocaleSwitch}'s. */
export interface EverygridLocaleOptions {
  /** Remember the choice in localStorage: `true` (built-in key) or a key of your own. */
  persist?: boolean | string;
  /** Used when nothing is saved; otherwise the browser's language. */
  defaultLocale?: Locale;
}

function savedLocale(persist: boolean | string | undefined): Locale | null {
  const key = Everygrid.localeStorageKey(persist);
  if (!key) return null;
  try {
    const v = localStorage.getItem(key);
    return v === 'ko' || v === 'en' ? v : null;
  } catch {
    return null; // storage blocked
  }
}

/**
 * Everygrid's UI language as React state, for a language control you build yourself:
 * `const [locale, setLocale] = useEverygridLocale({persist: true})`. Setting it switches every grid
 * on the page (Everygrid.setLocale); a switch made anywhere else updates it too. With `persist` the
 * choice is saved and restored.
 */
export function useEverygridLocale(opts: EverygridLocaleOptions = {}): [Locale, (locale: Locale) => void] {
  const {persist, defaultLocale} = opts;
  const [locale, setState] = useState<Locale>(() => savedLocale(persist) ?? defaultLocale ?? Everygrid.getLocale());
  // Apply the restored/default choice once, so the grids match what this state says.
  useEffect(() => {
    if (savedLocale(persist) || defaultLocale) Everygrid.setLocale(locale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => Everygrid.onLocaleChange(next => {
    setState(next);
    const key = Everygrid.localeStorageKey(persist);
    if (key) {
      try { localStorage.setItem(key, next); } catch { /* storage blocked */ }
    }
  }), [persist]);
  return [locale, (next: Locale) => Everygrid.setLocale(next)];
}

export interface EverygridLocaleSwitchProps extends EverygridLocaleOptions {
  /** `'button'` (default): a flag toggle. `'select'`: a dropdown. */
  type?: 'button' | 'select';
  /** `'icon'` (flags), `'text'` (names) or `'both'`. */
  display?: 'icon' | 'text' | 'both';
  /** Text per locale, replacing what `display` would show. */
  labels?: Partial<Record<Locale, string>>;
  className?: string;
}

/**
 * The language switch, as a component — {@link Everygrid.mountLocaleSwitch} for React. Renders
 * Everygrid's own toggle (or dropdown) and keeps it in step with every grid on the page.
 */
export function EverygridLocaleSwitch({type, display, labels, persist, defaultLocale, className}: EverygridLocaleSwitchProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const labelKey = JSON.stringify(labels ?? null);
  useEffect(() => {
    if (!ref.current) return;
    return Everygrid.mountLocaleSwitch(ref.current, {type, display, labels, persist, defaultLocale});
    // labels is compared by value (labelKey); a new object with the same text must not remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, display, labelKey, persist, defaultLocale]);
  return <span ref={ref} className={className} style={{display: 'contents'}}/>;
}
