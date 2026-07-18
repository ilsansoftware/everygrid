import ko from './ko.json';
import en from './en.json';

type TranslationKeys = typeof ko;

export class I18n {
  private static locale: 'ko' | 'en' = 'en';
  private static translations: Record<'ko' | 'en', TranslationKeys> = {ko, en};

  public static setLocale(locale: 'ko' | 'en') {
    this.locale = locale;
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
    const lang = navigator.language.split('-')[0];
    try {
      this.setLocale(lang as 'ko' | 'en');
    } catch (err) {
      console.error(err);
      this.setLocale('en'); // Default
    }
  }
}
