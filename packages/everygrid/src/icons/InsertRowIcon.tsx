import {icon} from './registry';
/** Toolbar "insert row": a plus, drawn with the same stroke weight and box as the other toolbar icons. */
export const InsertRowIcon = icon('insertRow', ({className}: {className?: string}) => (
  <svg
    viewBox='-1.5 -1.5 27 27'
    fill='none'
    stroke='currentColor'
    strokeWidth={2}
    strokeLinecap='round'
    xmlns='http://www.w3.org/2000/svg'
    className={className}
  >
    <line x1='12' y1='4' x2='12' y2='20' />
    <line x1='4' y1='12' x2='20' y2='12' />
  </svg>
));
