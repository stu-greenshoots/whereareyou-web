/// <reference lib="webworker" />
/*
 * The service worker, hand-authored (injectManifest) because generateSW has
 * no way to express a push handler. Everything the generated worker used to
 * do is reproduced here in code: precache the built shell, serve the app
 * shell for navigations, cache viewed map tiles — and now surface web push.
 *
 * Push payloads are generic BY DESIGN: they say that something happened and
 * which session — never positions, chat bodies, zone names or people's
 * names. A notification is delivered to a lock screen, which is the least
 * private display surface this product touches.
 */
import { clientsClaim, type WorkboxPlugin } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// autoUpdate, as before: a new worker takes over immediately rather than
// stranding a fast-moving prototype's users on a stale build.
void self.skipWaiting();
clientsClaim();

// The built shell + static assets, injected at build time.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Any route resolves to the app shell offline, so /lookup works too. API
// calls must never be cached — offline, a failed mint is what triggers the
// offline-code fallback, which is the correct behaviour.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/v1\//, /^\/health/],
  }),
);

// Map tiles are the one thing that genuinely needs the network. Cache what
// has actually been viewed (never pre-fetch — the tile policies forbid it),
// so a map seen before losing signal keeps its tiles. Must match
// TILE_SOURCES in src/Map.tsx.
registerRoute(
  /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/.*/,
  new CacheFirst({
    cacheName: 'carto-tiles',
    plugins: [
      // Workbox's plugin types predate exactOptionalPropertyTypes; the
      // instances are the intended values, the cast only bridges the gap.
      new ExpirationPlugin({ maxEntries: 250, maxAgeSeconds: 7 * 24 * 60 * 60 }) as WorkboxPlugin,
      new CacheableResponsePlugin({ statuses: [0, 200] }) as WorkboxPlugin,
    ],
  }),
);

// The live room's basemap is OSM standard, not CARTO — it is the only free
// raster that actually names shops and pubs (see TILE_SOURCES in Map.tsx).
// Its own tile usage policy asks clients to cache rather than re-fetch, so
// this is required of us, not merely convenient. Same rules as above: only
// what has been viewed, never a pre-fetch.
registerRoute(
  /^https:\/\/tile\.openstreetmap\.org\/.*/,
  new CacheFirst({
    cacheName: 'osm-tiles',
    plugins: [
      new ExpirationPlugin({ maxEntries: 250, maxAgeSeconds: 7 * 24 * 60 * 60 }) as WorkboxPlugin,
      new CacheableResponsePlugin({ statuses: [0, 200] }) as WorkboxPlugin,
    ],
  }),
);

/** What a push payload may carry — anything else is ignored. */
interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

self.addEventListener('push', (event) => {
  // Defensive parse: a payload we cannot read still surfaces as a generic
  // notification rather than being dropped — the tap-through is the value.
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    payload = {};
  }
  const title =
    typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'whereareyou';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const url = typeof payload.url === 'string' && payload.url !== '' ? payload.url : './';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // Relative to the worker's own location, so the GitHub Pages base
      // needs no special-casing here.
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data as { url?: string } | undefined)?.url ?? './';
  const target = new URL(raw, self.location.href).href;
  event.waitUntil(
    (async () => {
      // Focus an existing window if the app is already open; open one
      // otherwise. Navigation failures are tolerated — a focused app is
      // already most of the way there.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clients[0];
      if (existing !== undefined) {
        await existing.focus();
        if (existing.url !== target) {
          try {
            await existing.navigate(target);
          } catch {
            // Focused is enough.
          }
        }
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
