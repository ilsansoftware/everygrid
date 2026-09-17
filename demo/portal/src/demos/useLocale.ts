import {useCallback, useState} from 'react';
import type {Locale} from './LocaleSwitch';

/** Where the portal has always kept the chosen language — one key for every demo, the html ones
 *  included, so a reload (and a hop between tabs) comes back in the language that was on screen. */
const LOCALE_KEY = 'eg-portal-locale';

function initialLocale(): Locale {
  const saved = localStorage.getItem(LOCALE_KEY);
  return saved === 'ko' || saved === 'en' ? saved : 'en';
}

/** Locale state for one demo tab, persisted across reloads. Pair it with `Everygrid.setLocale`. */
export function usePersistedLocale(): [Locale, (next: Locale) => void] {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const change = useCallback((next: Locale) => {
    setLocale(next);
    localStorage.setItem(LOCALE_KEY, next);
  }, []);
  return [locale, change];
}
