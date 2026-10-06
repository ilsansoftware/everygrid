/**
 * PostCSS plugin: confine Tailwind's utilities to Everygrid's own elements.
 *
 * Utility class names are global — the library's `.bg-white` or `.border-slate-200` would also
 * style a host page that happens to use the same Tailwind classes, and since the library's values
 * are theme tokens, that page would turn dark with the grid. Every rule in the
 * `everygrid.utilities` layer gets `:where(<an Everygrid element or one of its descendants>)`
 * appended, before any pseudo-element. `:where()` adds no specificity, so the cascade inside the
 * library is unchanged. Same scope as the generated preflight (src/styles/preflight.css).
 *
 * Plain JS with no `postcss` import, so both the library's vite.config.ts and the demo portal's
 * postcss.config.js (which compiles the library's CSS from source in dev) can load it. Idempotent:
 * already-scoped rules — the npm build the portal bundles in production — are left alone.
 */
const SCOPE = ':where([class*="everygrid-"], [class*="everygrid-"] *)';
const SCOPED = /:where\(\[class\*="?everygrid-/;

function inUtilitiesLayer(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'atrule' && p.name === 'keyframes') return false;
    if (p.type === 'atrule' && p.name === 'layer' && p.params === 'everygrid.utilities') return true;
  }
  return false;
}

/** Append the scope, keeping it before a pseudo-element (`::placeholder`), which must come last. */
function scopeSelector(sel) {
  if (SCOPED.test(sel)) return sel;
  const m = /(?<!\\)::/.exec(sel);
  return m ? sel.slice(0, m.index) + SCOPE + sel.slice(m.index) : sel + SCOPE;
}

export const scopeUtilities = {
  postcssPlugin: 'everygrid-scope-utilities',
  Once(root) {
    root.walkRules(rule => {
      if (inUtilitiesLayer(rule)) rule.selectors = rule.selectors.map(scopeSelector);
    });
  },
};
