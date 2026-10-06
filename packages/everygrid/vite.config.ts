import { defineConfig } from 'vite';
import type { NormalizedOutputOptions, OutputBundle } from 'rollup';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import dts from 'vite-plugin-dts';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tailwindcss from '@tailwindcss/vite';
import { scopeUtilities } from './scopeUtilities.js';

const isStandalone = process.env.BUILD_FORMAT === 'standalone';

// Inline the WASM binary (base64) and the Web Workers into a single self-contained module — for
// BOTH builds. The standalone UMD needs it to be one `<script>`-able file; the ES build needs it so
// a bundler consumer (React app) doesn't inherit a bare `new Worker("/assets/GridEngineWorker-*.js")`
// string that only resolves from the deployed CDN root (it 404s under any other origin/sub-path).
// Inlining makes the worker a blob, so the wasm must be inlined too (a blob worker can't resolve a
// sibling .wasm via import.meta.url).
const wasmInlinePlugin = {
  name: 'wasm-inline-base64',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.endsWith('.wasm')) return null;
    const wasmBuffer = readFileSync(id);
    const base64 = wasmBuffer.toString('base64');
    return `
const base64="${base64}";
const binary=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
export default binary.buffer;
`;
  },
  transform(code: string, id: string) {
    // Only the UMD build trips the import.meta.url warning; the ES build keeps it (unused anyway,
    // since init() below receives the inlined binary via module_or_path).
    if (isStandalone && id.includes('everygrid_wasm.js')) {
      // Remove import.meta.url usage to avoid UMD build warnings
      return code.replace(
        /if \(module_or_path === undefined\) \{[\s\S]*?module_or_path = new URL\('everygrid_wasm_bg\.wasm', import\.meta\.url\);[\s\S]*?}/,
        'if (module_or_path === undefined) { /* WASM binary provided via load() hook */ }'
      );
    }
    // Inline the export worker into the standalone bundle (same reasoning as GridEngineWorker
    // below): otherwise the UMD build emits a separate hashed asset referenced by an absolute
    // /assets/ path that only resolves from the deployed CDN root.
    if (id.includes('ExcelExportClient')) {
      return code.replace("'./ExportWorker?worker'", "'./ExportWorker?worker&inline'");
    }
    if (!id.includes('GridEngineWasm')) return null;
    // In standalone builds, import the WASM binary and pass it to init()
    const withImport = `import wasmBinary from 'everygrid-wasm/everygrid_wasm_bg.wasm';\n` + code;
    return withImport
      .replace(
        '_initPromise = init().then(',
        '_initPromise = init({ module_or_path: wasmBinary }).then('
      )
      // Inline the Web Worker so the standalone is a single self-contained file with no
      // sibling /assets/GridEngineWorker-*.js to fetch. Without this the UMD build emits
      // the worker as a separate hashed asset referenced by an absolute /assets/ path,
      // which only resolves when served from the deployed CDN root — it 404s under any
      // other origin/path (local demos, sub-paths). ?worker&inline embeds it as a blob.
      .replace(
        "'./GridEngineWorker?worker'",
        "'./GridEngineWorker?worker&inline'"
      );
  },
};

const inlineCssPlugin = {
  name: 'inline-css',
  apply: 'build' as const,
  enforce: 'post' as const,
  generateBundle(_options: NormalizedOutputOptions, bundle: OutputBundle) {
    let cssContent = '';
    let cssFileName = '';
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (fileName.endsWith('.css') && chunk.type === 'asset') {
        cssContent = typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source).toString();
        cssFileName = fileName;
      }
    }
    if (!cssContent) return;
    const normalizedCss = cssContent.replace(/@layer\s+properties\s*\{([\s\S]*?)}\s*}/g, '$1}');
    // Inject the stylesheet at import time so `import '@everygrid/grid'` (or the <script>) styles the
    // grid with no separate CSS import. The ES build extracts its CSS to a sibling Everygrid.css that
    // a bundler consumer would otherwise never load — which left the deployed React demo unstyled.
    const cssInject = `;(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(normalizedCss)};document.head.appendChild(s);})();`;
    // UMD may run where `process` is undefined; the ES build never needs this shim.
    const chromePolyfill = ';(function(){if(typeof process==="undefined"){window.process={env:{},versions:{},emit:function(){}}}})();';
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === 'chunk' && chunk.isEntry) {
        chunk.code = cssInject + (isStandalone ? chromePolyfill : '') + chunk.code;
      }
    }
    // Standalone ships one self-contained file → drop the now-inlined CSS asset. The ES build keeps
    // it so `@everygrid/grid/css` still resolves for consumers who want the raw stylesheet.
    if (isStandalone && cssFileName) delete bundle[cssFileName];
  },
};

export default defineConfig({
  // Keep the library's Tailwind utilities on Everygrid's own elements (see scopeUtilities.js).
  css: { postcss: { plugins: [scopeUtilities] } },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      '@everygrid/core'
    ],
    exclude: ['everygrid-wasm'],
  },
  plugins: [
    react(),
    tailwindcss(),
    // Inline worker + wasm for both formats (see wasmInlinePlugin); nodePolyfills is UMD-only.
    wasmInlinePlugin,
    ...(isStandalone ? [nodePolyfills()] : []),
    dts({
      include: ['src'],
      insertTypesEntry: true,
      copyDtsFiles: false,
      tsconfigPath: './tsconfig.lib.json',
      afterBuild: () => {
        writeFileSync(resolve(__dirname, 'dist/index.d.ts'), 'export * from "./src/index";\nexport { default } from "./src/index";\n');
      },
    }),
    inlineCssPlugin,
  ],
  resolve: {
    alias: {
      buffer: 'buffer',
    },
  },
  build: {
    // The standalone UMD deliberately inlines the WASM binary (base64), worker, and CSS into one
    // self-contained file, so it can't be code-split — the limit just tracks that expected size.
    chunkSizeWarningLimit: 4000,
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, (isStandalone) ? 'src/standalone-entry.ts' : 'src/index.ts'),
      name: 'Everygrid',
      formats: (isStandalone) ? ['umd'] : ['es'],
      fileName: (format) => {
        if (isStandalone) return 'everygrid.standalone.js';
        if (format === 'es') return 'index.js';
        return 'everygrid.standalone.js';
      },
    },
    rollupOptions: {
      // ES build (`.` / `./react` / `./core`) externalizes React so consumers use their own copy
      // (React is a peerDependency) — one React, one Everygrid singleton. The standalone UMD bundles
      // React so it stays self-contained for `<script>` / CDN use (vanilla / jquery pages have none).
      external: isStandalone
        ? []
        : (id: string) => id === 'react' || id === 'react-dom'
          || id.startsWith('react/') || id.startsWith('react-dom/'),
      output: {
        assetFileNames: isStandalone ? 'Everygrid.standalone.[ext]' : 'Everygrid.css',
        globals: {
          'react': 'React',
          'react-dom': 'ReactDOM',
          'react/jsx-runtime': 'React',
          'react/jsx-dev-runtime': 'React'
        },
        extend: true,
        paths: {},
      },
    },
  },
});
