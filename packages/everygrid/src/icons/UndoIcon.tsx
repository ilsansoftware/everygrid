import {icon} from './registry';
export const UndoIcon = icon('undo', ({className}: {className?: string}) => (
  <svg viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'
       xmlns='http://www.w3.org/2000/svg' className={className}>
    <path d='M9 14 4 9l5-5'/>
    <path d='M4 9h10a6 6 0 0 1 0 12h-3'/>
  </svg>
));
