import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { mobileBridge, DEDUPE, MOBILE_SRC } from './vite/mobileBridge.ts';

// GitHub Pages serves the site under /<repo>/; CI sets GLORIA_BASE.
const base = process.env.GLORIA_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [
    mobileBridge(),
    react(),
    VitePWA({
      // The app asks before updating: it flushes the database snapshot first.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/favicon-64.png', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'GLORIA 山峰監測',
        short_name: 'GLORIA',
        description: 'GLORIA summit monitoring — offline field recording (Mitalivana)',
        lang: 'zh-TW',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        background_color: '#ffffff',
        theme_color: '#6b5532',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,ico,json,webmanifest}'],
        // The species database is stored in IndexedDB by the app itself and
        // its manifest must always come from the network.
        globIgnores: ['data/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { dedupe: DEDUPE },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  server: { host: '127.0.0.1', fs: { allow: ['.', MOBILE_SRC] } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: { deps: { inline: [/mobile\/app\/src/] } },
  },
});
