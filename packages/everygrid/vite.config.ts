import { defineConfig } from 'vite';
import type { NormalizedOutputOptions, OutputBundle } from 'rollup';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import dts from 'vite-plugin-dts';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';

const isStandalone = process.env.BUILD_FORMAT === 'standalone';

// Plugin to inline WASM binary as base64 for standalone builds (no import.meta.url)
const wasmInlinePlugin = {
  name: 'wasm-inline-base64',
  enforce: 'pre' as const,
  load(id: string) {
    if (!id.endsWith('.wasm')) return null;
    if (!isStandalone) return null;
    const wasmBuffer = readFileSync(id);
    const base64 = wasmBuffer.toString('base64');
    return `
const base64="${base64}";
const binary=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
export default binary.buffer;
`;
  },
  transform(code: string, id: string) {
    if (!isStandalone) return null;
    if (id.includes('everygrid_wasm.js')) {
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
    if (!isStandalone) return;
    let cssContent = '';
    for (const [fileName, chunk] of Object.entries(bundle)) {
      if (fileName.endsWith('.css') && chunk.type === 'asset') {
        cssContent = typeof chunk.source === 'string' ? chunk.source : Buffer.from(chunk.source).toString();
        delete bundle[fileName];
      }
    }
    if (cssContent) {
      const normalizedCss = cssContent.replace(/@layer\s+properties\s*\{([\s\S]*?)}\s*}/g, '$1}');
      const cssInject = `;(function(){var s=document.createElement('style');s.textContent=${JSON.stringify(normalizedCss)};document.head.appendChild(s);})();`;
      const chromePolyfill = ';(function(){if(typeof process==="undefined"){window.process={env:{},versions:{},emit:function(){}}}})();';
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && chunk.fileName.includes('standalone')) {
          chunk.code = cssInject + chromePolyfill + chunk.code;
        }
      }
    }
  },
};

export default defineConfig({
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
    // 💡 패키지용 빌드(isUmd)일 때는 리액트 컴파일러 플러그인이 가상 돔 큐를 오염시키지 않도록 배제
    react(),
    tailwindcss(),
    ...(!isStandalone ? [wasm()] : []),
    ...(isStandalone ? [nodePolyfills(), wasmInlinePlugin] : []),
    // 💡 [오타 교정 완료] 괄호 위치를 정밀하게 수선하여 TS1005, TS1109, TS1005 문법 오류를 완벽 박멸했습니다.
    dts({
      include: ['src'],
      insertTypesEntry: true,
      copyDtsFiles: false,
      tsconfigPath: './tsconfig.lib.json',
      afterBuild: () => {
        writeFileSync(resolve(__dirname, 'dist/index.d.ts'), 'export * from "./src/index";\nexport { default } from "./src/index";\n');
      },
    }),
    ...(isStandalone ? [inlineCssPlugin] : []),
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
