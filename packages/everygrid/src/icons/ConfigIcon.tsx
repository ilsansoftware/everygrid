import {icon} from './registry';
/** Toolbar "config": curly braces, in the toolbar's stroke weight and box. */
export const ConfigIcon = icon('config', ({className}: {className?: string}) => (
  <svg
    viewBox='-1.5 -1.5 27 27'
    fill='none'
    stroke='currentColor'
    strokeWidth={2}
    strokeLinecap='round'
    strokeLinejoin='round'
    xmlns='http://www.w3.org/2000/svg'
    className={className}
  >
    <path d='M9 3H8a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1' />
    <path d='M15 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1' />
  </svg>
));
