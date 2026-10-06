import type {ReactNode} from 'react';

/**
 * Carry a grid's theme across a portal. Popups and the search dropdown render into <body>, outside
 * the grid's subtree, so a `data-everygrid-theme` set on an ancestor of the grid (rather than on
 * <html>) would not reach them. `display: contents` adds no box — only the attribute, and so the
 * tokens it switches, which custom properties inherit through.
 */
export function withPortalTheme(anchor: Element | null | undefined, node: ReactNode): ReactNode {
  const theme = anchor?.closest('[data-everygrid-theme]')?.getAttribute('data-everygrid-theme');
  return theme ? <div data-everygrid-theme={theme} style={{display: 'contents'}}>{node}</div> : node;
}

/** The same, for a portalled element already in the DOM: copy the anchor's theme onto it. */
export function syncPortalTheme(anchor: Element | null, el: HTMLElement | null): void {
  if (!el) return;
  const theme = anchor?.closest('[data-everygrid-theme]')?.getAttribute('data-everygrid-theme');
  if (theme) el.setAttribute('data-everygrid-theme', theme);
  else el.removeAttribute('data-everygrid-theme');
}
