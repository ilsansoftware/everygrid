import {useCallback, useState} from 'react';
import {Everygrid} from '@everygrid/grid';
import type {Locale} from './LocaleSwitch';

/** The key `bindLocaleControls({persist: true})` uses in the html demos — shared, so a reload (and
 *  a hop between tabs) comes back in the language that was on screen. */
const LOCALE_KEY = Everygrid.LOCALE_STORAGE_KEY;

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
