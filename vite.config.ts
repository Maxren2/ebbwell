import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// Voice input runs Whisper with ONNX Runtime (WebAssembly). Its runtime files are served from
// this app, versioned, instead of the CDN the library would otherwise use.
const ORT_DIR = 'node_modules/onnxruntime-web/dist';
const ORT_VERSION = (JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')) as { version: string }).version;
const ORT_BASE = `/assets/ort-${ORT_VERSION}/`;

/** ONNX Runtime's own reference to its WebGPU build (27 MB) is never used: wasmPaths points above. */
function dropBundledOnnxWasm(): Plugin {
  return {
    name: 'ebbwell-drop-bundled-onnx-wasm',
    apply: 'build',
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) if (/ort-wasm-simd-threaded[^/]*\.wasm$/.test(name)) delete bundle[name];
    },
  };
}

function onnxRuntimeFiles(): Plugin {
  return {
    name: 'ebbwell-onnxruntime-files',
    apply: 'build',
    generateBundle() {
      for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        this.emitFile({ type: 'asset', fileName: `${ORT_BASE.slice(1)}${file}`, source: readFileSync(join(ORT_DIR, file)) });
      }
    },
  };
}

export default defineConfig({
  root: 'web',
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __ORT_BASE__: JSON.stringify(ORT_BASE) },
  // The speech-recognition worker loads ONNX Runtime with dynamic imports.
  worker: { format: 'es', plugins: () => [dropBundledOnnxWasm()] },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // No inline scripts/styles: required by the strict CSP.
    assetsInlineLimit: 0,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/auth': 'http://localhost:8080',
    },
  },
  plugins: [
    react(),
    onnxRuntimeFiles(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'auth.css', 'signed-out.html'],
      manifest: {
        id: '/',
        name: 'Ebbwell',
        short_name: 'Ebbwell',
        description: 'A private journal',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#16131a',
        theme_color: '#16131a',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Custom service worker (push notifications); only the app shell is precached,
      // health data is never cached on the device.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // Voice input (speech recognition) is fetched only by those who turn it on.
        globIgnores: ['assets/ort-*/**', 'assets/voice.worker-*.js'],
      },
    }),
  ],
});
