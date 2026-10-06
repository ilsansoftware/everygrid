import {scopeUtilities} from '../../packages/everygrid/scopeUtilities.js';

export default {
  plugins: [
    (await import('@tailwindcss/postcss')).default(),
    // In dev the library's CSS is compiled here from source, so scope its utilities the way the
    // library's own build does (see the plugin) — otherwise the portal's `bg-white` would follow
    // the grid's theme.
    scopeUtilities,
    (await import('autoprefixer')).default(),
  ],
};
