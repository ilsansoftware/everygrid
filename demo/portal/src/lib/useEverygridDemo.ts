import { useEffect, useRef } from 'react';
import { resolveEverygrid, type EverygridType, type Locale } from './everygrid';

/**
 * Shared lifecycle for an in-app grid demo:
 *  - resolves the Everygrid singleton, applies the current locale, runs `init`
 *  - tears the grid down on unmount (so tab switches don't leak the global singleton)
 *  - re-applies the locale whenever it changes
 *  - re-renders when the demo becomes visible again
 *
 * The portal keeps each visited tab mounted and merely hides it, so `init` runs once per
 * demo and the data is never re-fetched on a tab switch. Only one demo owns the parent
 * window's Everygrid singleton (the others are iframes with their own), so sharing it is
 * still safe.
 */
export function useEverygridDemo(
  locale: Locale,
  init: (eg: EverygridType) => Promise<void>,
  active = true,
) {
  const egRef = useRef<EverygridType | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    resolveEverygrid()
      .then(async (EG) => {
        if (cancelled) return;
        egRef.current = EG;
        EG.I18n.setLocale(locale);
        await init(EG);
        if (cancelled) return;
        readyRef.current = true;
        EG.refreshAll();
      })
      .catch((err: unknown) => console.error('Everygrid demo init error:', err));

    return () => {
      cancelled = true;
      readyRef.current = false;
      egRef.current?.resetAutoInit();
    };
    // Mount/unmount only — locale changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (readyRef.current && egRef.current) {
      egRef.current.I18n.setLocale(locale);
      egRef.current.refreshAll();
    }
  }, [locale]);

  // While hidden the grids measure as zero-width, so column widths must be recomputed
  // once the demo is shown again. This only re-renders — it does not re-fetch.
  useEffect(() => {
    if (active && readyRef.current) egRef.current?.refreshAll();
  }, [active]);
}