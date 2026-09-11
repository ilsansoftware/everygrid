import {createContext} from 'react';

/**
 * The element on the page-title row that a demo may portal its own controls into, so a control
 * that belongs to the whole tab (a size picker) sits with the title rather than above the grid.
 * Null when the title row is not rendered (a phone), in which case the demo keeps the control
 * inline. A demo should only portal while it is the active tab — every mounted tab stays mounted.
 */
export const HeadingSlotContext = createContext<HTMLElement | null>(null);
