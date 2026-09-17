export type Locale = 'en' | 'ko';

const LOCALES: { id: Locale; flag: string; title: string }[] = [
  {id: 'en', flag: '🇺🇸', title: 'English'},
  {id: 'ko', flag: '🇰🇷', title: '한국어'},
];

/**
 * The language toggle for one demo tab. Each tab keeps its own locale and applies it with
 * `Everygrid.setLocale` while it is the active tab — see the demos. Every demo, React or plain
 * html, draws it in the same place: the control row above its first grid. The choice itself
 * is kept by usePersistedLocale, so a reload comes back in the same language.
 */
export default function LocaleSwitch({value, onChange}: {
  value: Locale;
  onChange: (locale: Locale) => void;
}) {
  return (
      <div className='locale-btn-group' role='group' aria-label='Language'>
        {LOCALES.map((l) => (
            <button
                key={l.id}
                type='button'
                className={`locale-btn${l.id === value ? ' active' : ''}`}
                title={l.title}
                aria-pressed={l.id === value}
                onClick={() => onChange(l.id)}
            >
              {l.flag}
            </button>
        ))}
      </div>
  );
}
