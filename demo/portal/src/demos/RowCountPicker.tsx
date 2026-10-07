/** Row counts offered. Past ~493,000 rows (34px rows) the grid splits the result into scrollable
 *  segments, so the larger sizes are what exercise that path. */
const ROW_CHOICES = [100_000, 250_000, 500_000, 750_000, 1_000_000];

/** The row-count picker for the virtual-scroll demo; sits in the control row above the grid. */
export default function RowCountPicker({value, onChange}: {
  value: number;
  onChange: (rows: number) => void;
}) {
  return (
      <label className='flex items-center'>
        <select
            aria-label='Rows'
            title='Rows'
            className='demo-select h-[34px] rounded-lg border border-slate-300 bg-white pl-3 text-sm text-slate-700 shadow-sm'
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
}
