import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * HTTPS is not a nicety here — the Geolocation API refuses to run outside a
 * secure context. `localhost` is exempt, but a LAN address is not, so testing
 * on a phone over http://192.168.x.x would load the page and then silently
 * never return a fix.
 *
 * The certificate is self-signed, so a phone will show a warning once. Accept
 * it and geolocation works.
 */
export default defineConfig({
  /*
   * GitHub Pages serves a project site from `/<repo>/`, not from the root, so
   * every asset URL needs that prefix. Driven by an env var rather than
   * hardcoded, so local dev and any root-hosted deploy keep `/` and only the
   * Pages build sets it. Vite rewrites `/`-prefixed URLs in CSS and HTML with
   * this value, which is what keeps the self-hosted @font-face paths working.
   */
  base: process.env['VITE_BASE'] ?? '/',
  plugins: [
    react(),
    // VITE_HTTP=1 runs a plain-http instance (localhost is a secure context
    // without TLS) — used for browser-automation checks; phones keep 5173.
    ...(process.env['VITE_HTTP'] === '1' ? [] : [basicSsl()]),
    /*
     * The service worker is what turns this from "installable" into "usable
     * with no signal". Once installed, the whole shell — HTML, JS, CSS, the
     * self-hosted fonts and icons — is precached, so the app opens offline and
     * you can still mint an offline code and read the coordinates, entirely
     * on-device. That is the case this app most needs to survive.
     */
    VitePWA({
      // Auto-update rather than prompt: a fast-moving prototype should never
      // strand a user on a stale build, and there is no in-app update UI.
      // (skipWaiting/clientsClaim now live in src/sw.ts itself.)
      registerType: 'autoUpdate',
      // The manifest is already hand-authored in public/ and linked from
      // index.html — let the plugin own only the service worker so there is one
      // source of truth for each.
      manifest: false,
      // Hand-authored worker: generateSW cannot express a push handler, so
      // the shell precache, navigation fallback and tile cache moved into
      // src/sw.ts as code. The plugin still injects the precache manifest.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Precache the built shell + the static assets copied from public/.
        globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
        // iOS launch screens are fetched by the OS at install time, not by
        // the app — precaching megabytes of splash PNGs would bloat every
        // other platform's cache for nothing.
        globIgnores: ['splash/**'],
      },
      devOptions: { enabled: false },
    }),
  ],
  // `appType: 'spa'` is the default, and it already serves index.html for
  // unknown paths — so /resolve survives a reload with no extra config.
  server: {
    port: 5173,
    // Listen on all interfaces so the phone can reach it.
    host: true,
    proxy: {
      // Proxy the API through this origin. Without it, an HTTPS page calling an
      // HTTP API is blocked as mixed content — and it removes the CORS problem
      // at the same time.
      '/v1': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Live rooms ride a WebSocket on the same path prefix.
        ws: true,
      },
      '/health': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
