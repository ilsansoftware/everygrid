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
//   build    the @everygrid/grid dependency   $EVERYGRID_CDN — the deployed standalone
//            — a CDN tarball URL, resolved
//            through its own exports map
//
// The alias is deliberately dev-only. package.json depends on the published tarball by URL
// rather than workspace:*, so a production build consumes @everygrid/grid exactly as an
// outside consumer would; aliasing it away in `vite build` would defeat that entirely.
// The rolling pointer, not a versioned URL: deploy.sh overrides this with the immutable
// /packages/everygrid.standalone-<version>-<hash>.js it just published, so this only applies
// to a plain `vite build`. Hardcoding a version here meant a version bump left it silently
// pointing at the previous release — which still resolves, so nothing would ever fail loudly.
const CDN_STANDALONE = 'https://d3886c7yrxubj8.cloudfront.net/latest/everygrid.standalone.js';
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
    chunkSizeWarningLimit: 3000,
  },
}));
