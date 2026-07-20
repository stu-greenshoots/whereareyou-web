import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
  plugins: [react(), basicSsl()],
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
      },
      '/health': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
