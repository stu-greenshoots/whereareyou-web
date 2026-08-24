/**
 * THE BASEMAP, DECIDED IN ONE PLACE.
 *
 * Every map in this app — the share screen, the operator's resolve panels,
 * the live room — used to name its own tile variant at the call site. That
 * made "use one consistent map everywhere" a hunt through three files, and
 * made "switch provider" a hunt through four (the service worker caches by
 * host, and silently stops caching anything if it is forgotten). So the
 * choice lives here instead, and a call site says only WHICH SURFACE IT IS.
 *
 * The shape is three layers:
 *
 *   TILE_STYLES    one entry per raster style we might draw, with everything
 *                  Leaflet needs to draw it.
 *   TILE_PRESETS   a provider preset: which style each surface gets.
 *   resolveTiles() surface in, ready-to-use layer config out.
 *
 * Switching every surface to a new provider is therefore one line — the
 * `VITE_TILE_PROVIDER` build var, or `DEFAULT_PROVIDER` below if it should
 * become the permanent default. Adding a provider is one TILE_STYLES entry
 * plus one TILE_PRESETS row.
 *
 *
 * WHY THE CURRENT PRESET IS TWO PROVIDERS
 *
 * `carto` is what ships today and is deliberately not uniform: CARTO on the
 * static surfaces, OSM standard in the live room. The reason is measured,
 * not aesthetic. CARTO's styles render NO business names at any zoom.
 * Measured 24 Aug over Soho, London (51.5133, -0.1310), Voyager against OSM
 * standard at z16/17/18:
 *
 *   z16  Voyager: street names and district labels (SEVEN DIALS, COVENT
 *                 GARDEN), nothing else. OSM: named venues and dense POI
 *                 icons throughout.
 *   z17  Voyager: street names only. OSM: "Victory House Hotel",
 *                 "SilverTime", "W London".
 *   z18  Voyager: HOUSE NUMBERS — 54, 15, 24, 30, 45, 99, 138-140 — plus
 *                 street names, and not one business named on the tile.
 *                 OSM: "Prince Edward Theatre", "Pret A Manger", "M&S Food",
 *                 "GG Beauty Spa", "She Soho", "Gauthier", "Limoncello".
 *
 * That is the field report exactly ("I just see house numbers"), and it is a
 * property of the STYLE — not the zoom, not the theme, not the label variant. No CARTO variant (`voyager_labels_under`, `_nolabels`,
 * `dark_all`) adds POIs the style never rendered. The live room is where
 * people find each other by landmark ("outside the Pret"), so it takes the
 * denser map; the share screen and the resolve panels keep the calm one.
 *
 * Four other rasters were measured the same day and rejected on evidence:
 *
 *   Esri World Street Map / World Topo — attractive, but at z18 they show
 *     street names and house numbers and NO business names. Same failure as
 *     CARTO. Also the slowest tested (median 384/377 ms).
 *   CyclOSM — the richest POI naming of the lot, and unusable here: the
 *     cycle-network overlay dominates every street in blue.
 *   OpenFreeMap "Liberty" (vector, keyless, 4 POI symbol layers in its
 *     style; a z14 tile block fetched in a median 282 ms) — the best
 *     candidate on paper, and NOT shipped: it needs MapLibre GL instead of
 *     Leaflet, which is a port of Map.tsx, not a tile-URL change. Left as a
 *     follow-up, unverified — it would not render in the automation harness,
 *     so nobody has actually LOOKED at it yet.
 *
 * Speed, since "it renders slowly" was the objection: 12 tiles (a phone
 * viewport) at z17 over six different UK high streets, browser cache cold —
 * OSM standard median 67 ms, CARTO Voyager 234 ms, CyclOSM 279 ms, Esri
 * 377-384 ms. OSM standard was the FASTEST thing tested. What it is not is
 * pretty, which is why the keyed presets below exist: one map, attractive
 * AND POI-dense, is a paid tier away.
 *
 * OSM's tile usage policy: fine for a low-volume demo like this one, not for
 * heavy commercial traffic, requires the OSM attribution, and asks that
 * clients cache — which the service worker does, via TILE_CACHE_ROUTES.
 */

/**
 * The three jobs a map does here. A call site declares which one it is and
 * gets whatever the active preset says that job should look like.
 *
 *   share    the public share screen and its previews (light, calm)
 *   console  the operator's static resolve panels (dark control room)
 *   live     the live room, on BOTH themes — where POIs matter most
 */
export type MapSurface = 'share' | 'console' | 'live';

/** Everything Leaflet needs to draw one raster style. */
interface TileStyle {
  /** Leaflet URL template. `{r}` becomes `@2x` on retina; `{key}` is
      substituted here, from VITE_TILE_KEY, before Leaflet ever sees it. */
  url: string;
  attribution: string;
  subdomains: string;
  maxZoom: number;
  /** 512px providers need both of these; 256px ones set neither. */
  tileSize?: number;
  zoomOffset?: number;
  /** Dark basemap → the tile pane gets the legibility filter in styles.css. */
  darkFilter?: boolean;
  /** `{key}` in the url; unusable without VITE_TILE_KEY. */
  keyed?: boolean;
}

/**
 * KEYED PROVIDERS ARE WIRED BUT UNEXERCISED. Both entries below were written
 * from each provider's documented Leaflet integration and have never been
 * fetched — there is no key yet. Treat the URL shape, the tile size and the
 * dark-filter choice as unverified until somebody has looked at a real tile.
 */
const TILE_STYLES = {
  'carto-voyager': {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  },
  'carto-dark': {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
    // Dark Matter is nearly black; the filter in styles.css lifts it enough
    // to read a street name off in a lit room. See `.map-tiles-dark`.
    darkFilter: true,
  },
  'osm-standard': {
    // No @2x tiles and no subdomain sharding on this host, so no `{r}` — the
    // `subdomains` value is inert here and kept only so the type is total.
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
  },
  // MapTiler serves 512px raster tiles from this endpoint, which is why it
  // takes tileSize/zoomOffset — that pair is MapTiler's own documented
  // Leaflet snippet, not a guess we made.
  'maptiler-streets': {
    url: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}',
    attribution: '&copy; MapTiler &copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
    tileSize: 512,
    zoomOffset: -1,
    keyed: true,
  },
  'maptiler-streets-dark': {
    url: 'https://api.maptiler.com/maps/streets-v2-dark/{z}/{x}/{y}.png?key={key}',
    attribution: '&copy; MapTiler &copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
    tileSize: 512,
    zoomOffset: -1,
    // No filter: this style is drawn dark by the provider rather than being
    // a near-black raster we have to rescue. UNVERIFIED — if it turns out to
    // need lifting in a lit room, set this true and re-tune `.map-tiles-dark`.
    keyed: true,
  },
  'thunderforest-atlas': {
    url: 'https://{s}.tile.thunderforest.com/atlas/{z}/{x}/{y}{r}.png?apikey={key}',
    attribution: 'Maps &copy; Thunderforest &copy; OpenStreetMap contributors',
    subdomains: 'abc',
    maxZoom: 19,
    keyed: true,
  },
} satisfies Record<string, TileStyle>;

type TileStyleName = keyof typeof TILE_STYLES;

/** Widens one entry back to the interface — `satisfies` keeps the literal
    types, which are narrower than the optional fields we read off them. */
function styleOf(name: TileStyleName): TileStyle {
  return TILE_STYLES[name];
}

/**
 * WHICH STYLE EACH SURFACE GETS, PER PROVIDER. This is the switch: change
 * DEFAULT_PROVIDER (or pass VITE_TILE_PROVIDER at build time) and every map
 * in the app moves together.
 */
const TILE_PRESETS = {
  /** What ships today. Two providers on purpose — see the header note. */
  carto: {
    share: 'carto-voyager',
    console: 'carto-dark',
    live: 'osm-standard',
  },
  /** One map everywhere, dark-rendered where the chrome is dark. */
  maptiler: {
    share: 'maptiler-streets',
    console: 'maptiler-streets-dark',
    live: 'maptiler-streets',
  },
  /**
   * One map everywhere. Atlas has no dark sibling, so the console gets the
   * light style inside dark chrome — deliberate (consistency was the ask),
   * and the alternative if it reads badly is `thunderforest-transport-dark`,
   * which would need adding to TILE_STYLES.
   */
  thunderforest: {
    share: 'thunderforest-atlas',
    console: 'thunderforest-atlas',
    live: 'thunderforest-atlas',
  },
} satisfies Record<string, Record<MapSurface, TileStyleName>>;

export type TileProvider = keyof typeof TILE_PRESETS;

/** Today's behaviour, and the fallback whenever the build says nothing. */
const DEFAULT_PROVIDER: TileProvider = 'carto';

/*
 * BUILD-TIME CONFIGURATION — both optional, both read once.
 *
 *   VITE_TILE_PROVIDER   'carto' (default) | 'maptiler' | 'thunderforest'
 *   VITE_TILE_KEY        the provider's API key. Required by every provider
 *                        except 'carto'. Never commit one; it is baked into
 *                        the bundle, so it is a usage-limited public key, not
 *                        a secret — restrict it by referrer at the provider.
 *
 * Unset, misspelt, or keyed-without-a-key all land in the same place: the
 * default preset, exactly as the app behaves today. A wrong env var must
 * never produce a grey map.
 */
const REQUESTED_PROVIDER = String(import.meta.env['VITE_TILE_PROVIDER'] ?? '');
const TILE_KEY = String(import.meta.env['VITE_TILE_KEY'] ?? '');

function activeProvider(): TileProvider {
  if (REQUESTED_PROVIDER === '') return DEFAULT_PROVIDER;
  if (!(REQUESTED_PROVIDER in TILE_PRESETS)) {
    warnOnce(`VITE_TILE_PROVIDER="${REQUESTED_PROVIDER}" is not a known provider`);
    return DEFAULT_PROVIDER;
  }
  const provider = REQUESTED_PROVIDER as TileProvider;
  const needsKey = Object.values(TILE_PRESETS[provider]).some(
    (style) => styleOf(style).keyed === true,
  );
  if (needsKey && TILE_KEY === '') {
    warnOnce(`VITE_TILE_PROVIDER="${provider}" needs VITE_TILE_KEY; falling back`);
    return DEFAULT_PROVIDER;
  }
  return provider;
}

/**
 * A misconfigured build is a developer's problem, not a user's: say it once
 * in dev, say nothing at all in production. The map still draws either way.
 */
let warned = false;
function warnOnce(message: string): void {
  if (!import.meta.env.DEV || warned) return;
  warned = true;
  console.warn(`[tiles] ${message} — using the "${DEFAULT_PROVIDER}" basemaps.`);
}

/** A tile layer, ready to hand to Leaflet. */
export interface ResolvedTiles {
  url: string;
  attribution: string;
  subdomains: string;
  maxZoom: number;
  tileSize?: number;
  zoomOffset?: number;
  /** Whether this basemap needs the `.map-tiles-dark` legibility filter. */
  darkFilter: boolean;
}

/**
 * The one place a surface turns into a basemap. Pure, so a component may
 * call it during render as happily as inside an effect.
 */
export function resolveTiles(surface: MapSurface): ResolvedTiles {
  const style = styleOf(TILE_PRESETS[activeProvider()][surface]);
  return {
    url: style.keyed === true ? style.url.replace('{key}', TILE_KEY) : style.url,
    attribution: style.attribution,
    subdomains: style.subdomains,
    maxZoom: style.maxZoom,
    ...(style.tileSize !== undefined ? { tileSize: style.tileSize } : {}),
    ...(style.zoomOffset !== undefined ? { zoomOffset: style.zoomOffset } : {}),
    darkFilter: style.darkFilter === true,
  };
}

/**
 * THE HOSTS THE SERVICE WORKER CACHES, and the cache each one fills.
 *
 * Every tile host we could ever draw from is listed, not just the active
 * provider's: a rule for a host nobody calls costs nothing, and this way
 * flipping VITE_TILE_PROVIDER cannot silently take offline tiles away with
 * it. Separate caches per provider so one provider's eviction pressure
 * cannot evict another's, and so a provider switch leaves the old tiles to
 * expire on their own rather than poisoning the new map.
 *
 * Note for the keyed providers: their URLs carry the API key in the query
 * string, so it lands in Cache Storage as part of the cache key. That is the
 * same exposure as the bundle itself (the key ships in the JS), which is why
 * these keys must be referrer-restricted rather than treated as secrets.
 *
 * Consumed by src/sw.ts. Kept as data, not code, so the worker and the app
 * cannot disagree about which hosts exist.
 */
export const TILE_CACHE_ROUTES: ReadonlyArray<{ pattern: RegExp; cacheName: string }> = [
  { pattern: /^https:\/\/[abcd]\.basemaps\.cartocdn\.com\/.*/, cacheName: 'carto-tiles' },
  { pattern: /^https:\/\/tile\.openstreetmap\.org\/.*/, cacheName: 'osm-tiles' },
  { pattern: /^https:\/\/api\.maptiler\.com\/maps\/.*/, cacheName: 'maptiler-tiles' },
  { pattern: /^https:\/\/[abc]\.tile\.thunderforest\.com\/.*/, cacheName: 'thunderforest-tiles' },
];
