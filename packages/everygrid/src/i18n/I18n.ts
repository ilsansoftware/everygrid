import ko from './ko.json';
import en from './en.json';

type TranslationKeys = typeof ko;

export class I18n {
  private static locale: 'ko' | 'en' = 'en';
  // Set once the app calls setLocale, so browser auto-detection never overrides an explicit choice.
  private static explicit = false;
  private static translations: Record<'ko' | 'en', TranslationKeys> = {ko, en};

  public static setLocale(locale: 'ko' | 'en') {
    this.locale = locale;
    this.explicit = true;
  }

  public static getLocale(): 'ko' | 'en' {
    return this.locale;
  }

  /**
   * Retrieves translated text using dot notation.
   * Example: I18n.t('toolbar.showExcelPreview')
   */
  public static t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let result: unknown = this.translations[this.locale];

    for (const k of keys) {
      if (result && typeof result === 'object' && k in (result as Record<string, unknown>)) {
        result = (result as Record<string, unknown>)[k];
      } else {
        return key; // Return the key itself if not found
      }
    }

    if (typeof result !== 'string') {
      return key;
    }

    if (params) {
      let translated = result;
      Object.entries(params).forEach(([paramKey, value]) => {
        translated = translated.replace(`{${paramKey}}`, String(value));
      });
      return translated;
    }

    return result;
  }

  /**
   * Initializes the locale based on the browser language settings.
   */
  public static initFromBrowser() {
    // An explicit setLocale (e.g. from the host app) wins — don't clobber it with the browser locale
    // every time a grid is constructed.
    if (this.explicit) return;
    const lang = navigator.language.split('-')[0];
    this.locale = lang === 'ko' ? 'ko' : 'en';
  }
}
