import type {ComponentType, ReactElement} from 'react';

/** Every icon Everygrid draws, by name. Each renders with `everygrid-icon everygrid-icon-<kebab-name>`. */
export type IconName =
  | 'chevronDown' | 'columns' | 'columnWidth' | 'comma' | 'config' | 'diff' | 'download' | 'edit'
  | 'excel' | 'globe' | 'hide' | 'info' | 'insertRow' | 'mobileColumns' | 'pinEmpty' | 'pinFilled'
  | 'reload' | 'rowDetail' | 'search' | 'sortDown' | 'sortReset' | 'sortUp' | 'trash' | 'undo';

/** A replacement icon: SVG markup (trusted — it is inserted as-is) or a component taking `className`. */
export type IconSource = string | ComponentType<{className?: string}>;

const overrides: Partial<Record<IconName, IconSource>> = {};

/** Merge replacements in; `null` restores that icon's default. (Everygrid.setIcons re-renders.) */
export function setIconOverrides(icons: Partial<Record<IconName, IconSource | null>>): void {
  for (const [name, src] of Object.entries(icons) as [IconName, IconSource | null][]) {
    if (src) overrides[name] = src;
    else delete overrides[name];
  }
}

const kebab = (name: string) => name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

/** The root <svg> tag of `markup`, its own class/size attributes swapped for ours. Size comes from
 *  CSS like the built-in icons (they fill the box they are put in), so width/height must go. */
function withClass(markup: string, className: string): string {
  return markup.replace(/<svg\b([^>]*)>/i, (_, attrs: string) =>
    `<svg${attrs.replace(/\s(class|width|height)=("[^"]*"|'[^']*')/gi, '')} class="${className}" aria-hidden="true">`);
}

/** The replacement SVG markup for an icon, if one was set as a string — for DOM-drawn controls. */
export function iconMarkup(name: IconName, className: string): string | null {
  const src = overrides[name];
  return typeof src === 'string' ? withClass(src, `everygrid-icon everygrid-icon-${kebab(name)} ${className}`) : null;
}

/** Wrap a built-in icon: stable classes, and the replacement from setIcons when there is one. */
export function icon<P extends {className?: string}>(name: IconName, Default: (props: P) => ReactElement) {
  const base = `everygrid-icon everygrid-icon-${kebab(name)}`;
  const Icon = (props: P) => {
    const className = props.className ? `${base} ${props.className}` : base;
    const src = overrides[name];
    if (typeof src === 'string') {
      // display: contents — the wrapper adds no box, so the <svg> sizes against the same parent.
      return <span style={{display: 'contents'}} dangerouslySetInnerHTML={{__html: withClass(src, className)}}/>;
    }
    if (src) {
      const Custom = src;
      return <Custom className={className}/>;
    }
    return <Default {...props} className={className}/>;
  };
  Icon.displayName = `EverygridIcon(${name})`;
  return Icon;
}
