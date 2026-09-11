import {useContext} from 'react';
import {createPortal} from 'react-dom';
import {HeadingSlotContext} from '../headingSlot';

/** Row counts offered. Past ~493,000 rows (34px rows) the grid splits the result into scrollable
 *  segments, so the larger sizes are what exercise that path. */
const ROW_CHOICES = [100_000, 250_000, 500_000, 750_000, 1_000_000];

/**
 * The row-count picker for the virtual-scroll demo. It belongs to the whole tab, so it sits on the
 * title row (via the heading slot) while the tab is active and that row exists; on a phone, where
 * there is no title row, it renders in place.
 */
export default function RowCountPicker({value, onChange, active}: {
  value: number;
  onChange: (rows: number) => void;
  active: boolean;
}) {
  const slot = useContext(HeadingSlotContext);
  const picker = (
      <label className='flex items-center'>
        <select
            aria-label='Rows'
            title='Rows'
            className='h-[34px] rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 shadow-sm'
            value={ROW_CHOICES.includes(value) ? value : ''}
            onChange={(e) => onChange(Number(e.target.value))}
        >
          {!ROW_CHOICES.includes(value) && (
              <option value=''>{value.toLocaleString()}</option>
          )}
          {ROW_CHOICES.map((n) => (
              <option key={n} value={n}>{n.toLocaleString()}</option>
          ))}
        </select>
      </label>
  );
  return slot && active ? createPortal(picker, slot) : picker;
}
