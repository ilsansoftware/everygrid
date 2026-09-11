// This is a library public-API entry (`@everygrid/grid/react`), not a Vite app component module, so
// it intentionally exports a hook + a component + a type together — react-refresh's "components only"
// rule doesn't apply to a consumed package entry.
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Everygrid } from '../core/Everygrid';

type Fetcher = string | (() => Promise<Record<string, unknown>[]>);

// Deferred unmounts, keyed by grid id, so React StrictMode's transient mount→unmount→mount can
// cancel the teardown before it runs — and so a real unmount tears down from a timeout, never
// synchronously while React is rendering (which would warn on the grid's own React root).
const pendingUnmount = new Map<string, ReturnType<typeof setTimeout>>();

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
    void Everygrid.createGrid(id, source);

    return () => {
      pendingUnmount.set(id, setTimeout(() => {
        pendingUnmount.delete(id);
        Everygrid.unmount(id);
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
