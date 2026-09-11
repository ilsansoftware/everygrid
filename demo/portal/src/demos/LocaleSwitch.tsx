import {useContext} from 'react';
import {createPortal} from 'react-dom';
import {HeadingSlotContext} from '../headingSlot';

export type Locale = 'en' | 'ko';

const LOCALES: { id: Locale; flag: string; title: string }[] = [
  {id: 'ko', flag: '🇰🇷', title: '한국어'},
  {id: 'en', flag: '🇺🇸', title: 'English'},
];

/**
 * The language toggle for one demo tab. Each tab keeps its own locale and applies it with
 * `Everygrid.setLocale` while it is the active tab — see the demos. Sits on the title row (via the
 * heading slot) while the tab is active and that row exists; inline on a phone.
 */
export default function LocaleSwitch({value, onChange, active}: {
  value: Locale;
  onChange: (locale: Locale) => void;
  active: boolean;
}) {
  const slot = useContext(HeadingSlotContext);
  const group = (
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
  return slot && active ? createPortal(group, slot) : group;
}
