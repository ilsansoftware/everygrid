import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import { createReadStream, readFileSync, writeFileSync } from 'fs';
import path from 'path';

// Where each demo gets the library from:
//
//            React demo (bundled)             vanilla / jquery (<script> tag)
//   dev      workspace source, via the        workspace dist/everygrid.standalone.js,
//            alias below — edits in           served at /lib/ (pair with `pnpm demo`,
//            packages/everygrid apply live    which runs the library build in --watch)
//   build    the @everygrid/grid dependency   jsDelivr, same npm version (or $EVERYGRID_CDN)
//            — the npm release, resolved
//            through its own exports map
//
// The alias is deliberately dev-only. package.json depends on the published tarball by URL
// rather than workspace:*, so a production build consumes @everygrid/grid exactly as an
// outside consumer would; aliasing it away in `vite build` would defeat that entirely.
// The npm release's standalone via jsDelivr, pinned to the exact version the React demo installed
// — read from the dependency, not hardcoded, so a version bump can't leave the html demos silently
// on the previous release while the React demo moves on. $EVERYGRID_CDN overrides it.
const INSTALLED_VERSION = JSON.parse(
  readFileSync(path.resolve(__dirname, 'node_modules/@everygrid/grid/package.json'), 'utf-8'),
).version;
const CDN_STANDALONE = `https://cdn.jsdelivr.net/npm/@everygrid/grid@${INSTALLED_VERSION}/dist/everygrid.standalone.js`;
const LOCAL_STANDALONE = path.resolve(__dirname, '../../packages/everygrid/dist/everygrid.standalone.js');
const DEV_STANDALONE_URL = '/lib/everygrid.standalone.js';

// The html demos are static files under public/, copied verbatim — vite's built-in
// %VITE_*% html substitution only runs on html it processes as an entry, so it never
// reaches them. Swap the loader URL by hand instead.
const SRC_PLACEHOLDER = '%EVERYGRID_STANDALONE%';
const HTML_DEMOS = ['vanilla', 'jquery'];

function everygridStandaloneSrc() {
  return {
    name: 'everygrid-standalone-src',
    configureServer(server: import('vite').ViteDevServer) {
      // Registered from configureServer directly, so both run before vite's own static
      // handler would answer these paths with the untouched file.
      server.middlewares.use(DEV_STANDALONE_URL, (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        // no-store: the file is rewritten in place by the library's --watch build, and a
        // cached copy would silently defeat the whole point of serving it locally.
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(LOCAL_STANDALONE)
          .on('error', () => {
            res.statusCode = 404;
            res.end(
              `// ${LOCAL_STANDALONE} not built yet — run \`pnpm build:standalone\`.`,
            );
          })
          .pipe(res);
      });

      server.middlewares.use((req, res, next) => {
        const match = HTML_DEMOS.find((d) => req.url?.split('?')[0] === `/${d}/index.html`);
        if (!match) return next();
        const file = path.resolve(__dirname, 'public', match, 'index.html');
        res.setHeader('Content-Type', 'text/html');
        res.end(readFileSync(file, 'utf-8').replaceAll(SRC_PLACEHOLDER, DEV_STANDALONE_URL));
      });

      // The html demos load the standalone via a plain <script> in an iframe — outside vite's
      // module graph, so HMR can't touch them. Watch the file the library's --watch build rewrites
      // and push a custom event; App reloads the affected iframes (see App.tsx). React-demo-like
      // hot-swap for the vanilla / jquery tabs.
      server.watcher.add(LOCAL_STANDALONE);
      server.watcher.on('change', (file) => {
        if (path.resolve(file) === LOCAL_STANDALONE) {
          server.ws.send({ type: 'custom', event: 'everygrid:standalone-updated' });
        }
      });
    },
    closeBundle() {
      const cdn = process.env.EVERYGRID_CDN ?? CDN_STANDALONE;
      for (const demo of HTML_DEMOS) {
        const file = path.resolve(__dirname, 'dist', demo, 'index.html');
        writeFileSync(file, readFileSync(file, 'utf-8').replaceAll(SRC_PLACEHOLDER, cdn));
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    wasm(),
    nodePolyfills(),
    everygridStandaloneSrc(),
  ],
  resolve: {
    alias: (command === 'serve'
      ? { '@everygrid/grid': path.resolve(__dirname, '../../packages/everygrid/src/index.ts') }
      : {}) as Record<string, string>,
  },
  optimizeDeps: {
    exclude: ['everygrid-wasm'],
  },
  server: {
    port: 4000,
    strictPort: true,
  },
  build: {
    // The demo copies in the self-contained standalone bundle (inlined WASM/worker/CSS), which is
    // intentionally large and unsplittable — keep the limit above its size to avoid noise.
    chunkSizeWarningLimit: 4000,
  },
}));
