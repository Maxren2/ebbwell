import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  root: 'web',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
      },
    }),
  ],
});
