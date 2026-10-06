import React from 'react';
import {icon} from './registry';

export const ChevronDownIcon = icon('chevronDown', (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='currentColor'
       strokeWidth='3' strokeLinecap='round' strokeLinejoin='round' {...props}>
    <path d='m6 9 6 6 6-6'/>
  </svg>
));
