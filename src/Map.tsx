import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import L from 'leaflet';
import {
  MARKER_ICONS,
  MAX_SESSION_MARKERS,
  MAX_SESSION_ZONES,
  MAX_SKETCH_CHARS,
  MAX_SKETCH_SHAPES,
  encodeSketch,
  sketchBounds,
} from '@whereareyou/protocol';
import type { MarkerIcon, Sketch, SketchColour } from '@whereareyou/protocol';
import {
  attachOffscreenIndicators,
  type OffscreenIndicatorsHandle,
  type OffscreenTarget,
} from './offscreen-indicators.js';
import { PlaceSearch, placeShortName } from './PlaceSearch.jsx';
import { SKETCH_INKS, attachSketch, type SketchHandle } from './sketch-layer.js';
import {
  beginStroke,
  commitShape,
  extendStroke,
  previewShape,
  type DrawTool,
  type StrokeInProgress,
} from './sketch-geometry.js';

/**
 * Accuracy of a hand-placed pin, from the map's zoom.
 *
 * Unlike a GNSS fix, a placed pin has no sensor uncertainty — its precision is
 * just how finely the caller could point, which is set by how far the map is
 * zoomed in. A pin dropped at street level is a few metres; one dropped while
 * zoomed out is honestly coarser. Clamped so it never claims sub-grid precision
 * or an absurdly large radius.
 */
function placementAccuracy(lat: number, zoom: number): number {
  const metresPerPixel = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8);
  const TOLERANCE_PX = 6; // how close a human can realistically tap
  return Math.round(Math.min(300, Math.max(3, metresPerPixel * TOLERANCE_PX)));
}

/**
 * Follow-mode plumbing. Surfaces that opt in (`followSelf`) register their
 * disengage hook here, keyed by the live Leaflet map, so the two module-level
 * camera movers — `centreOnPlacement` and `releaseFollow`, both called by
 * parents holding only the raw map — can put follow down without threading
 * React state across files. A map that never opted in simply has no entry.
 */
const followHooksByMap = new WeakMap<L.Map, { release: () => void }>();

/**
 * Put follow-mode down on this map: from here on, position fixes move the
 * pins and rings but never the viewport, until the locate control re-engages
 * it. For parents opening a sheet over the map (a marker's naming sheet, an
 * icon picker) — anything mid-read that a snapping camera would ruin.
 * A no-op on maps without follow-mode.
 */
export function releaseFollow(map: L.Map): void {
  followHooksByMap.get(map)?.release();
}

/**
 * Centre the view on a point somebody deliberately chose. NO LONGER CALLED
 * BY ANY PLACEMENT FLOW: placements stopped moving the camera (2026-08-23)
 * once the off-screen edge pills guaranteed a marker out of view still shows
 * itself — the recentre had become churn, not help, and made the place-a-spot
 * moment hard to navigate. Kept because the machinery is right for any
 * future deliberate-navigation move (the edge pills' tap-to-fly uses its own
 * inline copy of the same discipline below).
 *
 * "Centre" means the middle of the map the person can SEE: the bottom
 * overlay stack is measured (after a deferred tick, letting any sheet the
 * action opens reach the DOM) and the point lands in the middle of what it
 * leaves visible.
 *
 * Always a jump-cut, never a glide: event.latlng is unreliable while a pan
 * or zoom animation runs (the same reasoning as the first-fix jump below),
 * so an animated recentre would send the very next tap somewhere absurd.
 *
 * `minZoom` is for picks from a list, which need a street-level view to mean
 * anything; a tap already happened at whatever zoom the person chose.
 */
export function centreOnPlacement(map: L.Map, lat: number, lon: number, minZoom = 0): void {
  setTimeout(() => {
    const container = map.getContainer();
    if (!container.isConnected) return; // the map went away mid-defer
    const size = map.getSize();
    const stack = container.parentElement?.querySelector('.map-bottom-stack');
    const covered = stack instanceof HTMLElement ? Math.min(stack.offsetHeight, size.y) : 0;
    const zoom = Math.max(map.getZoom(), minZoom);
    // Shift the centre so the target lands halfway down the UNCOVERED strip —
    // clamped so however tall the sheet, the point stays clear of the top
    // edge (and its controls) rather than being pushed off the map.
    const offset = Math.max(0, Math.min(covered / 2, size.y / 2 - 44));
    const centre = map.unproject(
      map.project(L.latLng(lat, lon), zoom).add(L.point(0, Math.round(offset))),
      zoom,
    );
    // A placement takes the camera over: follow-mode goes down and STAYS
    // down, so the next streaming fix cannot yank the view off the spot the
    // person just placed — the locate control is the way back.
    releaseFollow(map);
    map.setView(centre, zoom, { animate: false });
  }, 0);
}

/**
 * Same plumbing for the place-a-point tool. Parents own the marker strip
 * that fronts the tool, so they need to hear the tool arm and disarm
 * (`onMarkerToolChange`) and to put it down themselves when their own
 * placement path fires without a map tap — a pre-placement search pick.
 */
const markerToolHooksByMap = new WeakMap<L.Map, { disarm: () => void }>();

/**
 * Put the place-a-point tool down on this map. For parents whose placement
 * just happened OFF the map — a search pick from the pre-placement strip —
 * and for a strip's Done while the tool is still up. A no-op on maps
 * without the tool, or with it already down.
 */
export function disarmPointTool(map: L.Map): void {
  markerToolHooksByMap.get(map)?.disarm();
}

/**
 * Only a small same-shape data URL may become an <img> in marker HTML.
 * Peer avatars arrive over the wire from OTHER people, and these strings are
 * interpolated into innerHTML — the base64 charset contains no quote or
 * bracket, so a string this regex passes cannot break out of the attribute.
 */
const SAFE_AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

/** Marker names, zone names and chat arrive over the wire from other people;
    anything of theirs that lands in divIcon/popup HTML goes through here. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function avatarImg(avatar: string | undefined): string | null {
  if (!isSafeAvatar(avatar)) return null;
  return `<img class="marker-avatar" src="${avatar}" alt="" />`;
}

/** The same gate, for React-rendered faces (chat rows, roster, cards). */
export function isSafeAvatar(avatar: string | undefined): avatar is string {
  return avatar !== undefined && avatar.length <= 20_000 && SAFE_AVATAR.test(avatar);
}

// Leaflet's default marker icons are resolved relative to the CSS, which breaks
// under a bundler. Draw our own instead — also lets a third-party report look
// visually different from a self-report, which matters (see below).
// An avatar sits INSIDE the ring; the ring keeps its colour, because the
// colour is the information (blue = the caller) and the photo is only a face.
/**
 * Path colours are ours, not the room's — but they land in a `style`
 * attribute built by string concatenation, so they go through the same gate
 * every other interpolated value on this map does. Plain hex only.
 */
function safeColour(colour: string | null | undefined): string | null {
  return colour != null && /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : null;
}

function pinIcon(
  colour: string,
  avatar?: string,
  disconnected = false,
  trailColour?: string | null,
): L.DivIcon {
  const img = avatarImg(avatar);
  const trail = safeColour(trailColour);
  const classes = ['pin'];
  if (img !== null) classes.push('pin-has-avatar');
  if (disconnected) classes.push('marker-gone');
  // The pinned-path ring: this marker is the near end of a dotted line
  // somewhere on the map, and this is how you tell WHICH line.
  if (trail !== null) classes.push('marker-trailed');
  return L.divIcon({
    className: 'pin-icon',
    html: `<span class="${classes.join(' ')}" style="--pin-colour:${colour}${trail !== null ? `;--trail-colour:${trail}` : ''}">${img ?? ''}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/**
 * How a position whose owner has DROPPED OFF is drawn — the last thing they
 * sent, not where they are. The cue is a broken white ring plus a drained
 * fill: pattern first, colour second, so it survives colour blindness and
 * reads on both Voyager and Dark Matter. Dashed already means "not a hard
 * fact" everywhere else on this map (zones, trails), so it carries over.
 */
const GONE_CIRCLE: L.PathOptions = { dashArray: '4 5', opacity: 0.45, fillOpacity: 0.04 };
const LIVE_CIRCLE: L.PathOptions = { dashArray: undefined, opacity: 1 };

/** The whole sketch the next shape would produce, or null if it won't fit. */
function withShapeIfItFits(base: Sketch, shape: Sketch['shapes'][number]): Sketch | null {
  const next: Sketch = { ...base, shapes: [...base.shapes, shape] };
  if (next.shapes.length > MAX_SKETCH_SHAPES) return null;
  try {
    if (encodeSketch(next).length > MAX_SKETCH_CHARS) return null;
  } catch {
    return null;
  }
  return next;
}

/**
 * The viewer's own position — neutral slate, and a DOT, not a pin. Blue and
 * amber pins mean "the caller" and "a report"; the person merely looking at
 * this map must never be mistakable for either.
 */
const VIEWER_COLOUR = '#475569';

/**
 * Other people in a live room. Neutral slate DOTS with an initial — never a
 * pin. Blue means THE caller and amber means a third-party report; someone
 * who merely joined the room must not be mistakable for either.
 */
export interface MapPeer {
  id: string;
  label?: string | undefined;
  /** Small data-URL photo shown inside the dot, when they have one. */
  avatar?: string | undefined;
  position: { lat: number; lon: number; accuracyM: number };
  /** Tapping the dot — opens that participant's card in the live room. */
  onTap?: (() => void) | undefined;
  /**
   * Their socket has closed, but the room still holds them: draw the LAST
   * position they sent, ghosted, never remove it. Disconnecting is not
   * leaving — a vanished friend is worse than a stale one.
   */
  disconnected?: boolean | undefined;
  /**
   * Their path is pinned on the map right now, in this colour — the dot wears
   * a ring of it so the line and the person can be matched by eye.
   */
  trailColour?: string | null | undefined;
}

/**
 * A named zone from the live room — a shared, first-class circle, drawn
 * dashed and neutral so it can never be mistaken for sketch ink (solid,
 * white-cased) or for an accuracy circle.
 */
export interface MapZone {
  id: string;
  name: string;
  center: { lat: number; lon: number };
  radiusM: number;
  /**
   * When set, the label chip grows a small ×. The parent only sets this on
   * zones this participant is ALLOWED to remove — the server honours a
   * remove from the zone's creator (same connection) or the session owner
   * and silently drops everyone else's, so offering the affordance more
   * widely would be a button that lies.
   */
  onRemove?: (() => void) | undefined;
}

/**
 * One participant's recent path, PINNED on the map by the person reading it —
 * it outlives the card that put it there, so the card can be closed without
 * taking the path with it (the card used to sit right on top of the path it
 * had just drawn).
 *
 * Dotted, because a path is history, not a live position or a claim. The
 * colour is assigned by the parent, one per pinned path, and is echoed on
 * that person's dot as a ring — colour alone would be a riddle with several
 * paths up, so the map says whose is whose at both ends of the line.
 */
export interface MapTrail {
  /** The participant this path belongs to — also the layer key. */
  id: string;
  points: Array<[number, number]>;
  colour: string;
  /** Their connection dropped: the path is doubly historical, and fades to
      match the ghosted dot at the end of it. */
  ghost?: boolean | undefined;
}

/**
 * A transient "X said something" bubble over a participant's position.
 * The parent owns the lifetime (a few seconds); tapping any bubble opens
 * the chat panel.
 */
export interface MapChatFlag {
  id: string;
  position: { lat: number; lon: number };
}

const PEER_COLOUR = '#475569';

/**
 * Tile sources. Three, because two different jobs want two different maps.
 *
 * CARTO's basemaps (`voyager`, `dark`) are calm, restrained cartography —
 * right for a surface whose job is "here is the position", where anything
 * else on the map is noise. `{r}` fetches @2x tiles on retina screens; CARTO
 * requires the joint OSM+CARTO attribution.
 *
 * `street` is the OSM standard style, and it is on the LIVE room for one
 * reason: CARTO renders no business names at all. Measured 24 Aug over Soho,
 * London (51.5133, -0.1310), Voyager against OSM standard at z16/17/18:
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
 * property of the STYLE — not the zoom, not the theme, not the label variant.
 * No CARTO variant (`voyager_labels_under`, `_nolabels`, `dark_all`) adds
 * POIs the style never rendered. So the live room, where people find each
 * other by landmark ("outside the Pret"), uses `street`; the share screen and
 * the operator's resolve panels keep CARTO, where calm beats dense.
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
 *     Leaflet, which is a port of this file, not a tile-URL change. Left as
 *     a follow-up, unverified — it would not render in the automation
 *     harness, so nobody has actually LOOKED at it yet.
 *
 * Speed, since "it renders slowly" was the objection: 12 tiles (a phone
 * viewport) at z17 over six different UK high streets, browser cache cold —
 * OSM standard median 67 ms, CARTO Voyager 234 ms, CyclOSM 279 ms, Esri
 * 377-384 ms. OSM standard was the FASTEST thing tested, not the slowest.
 * What it is not is pretty: it is a reference map, denser and busier than
 * Voyager. That trade is deliberate and is the open question, not the speed.
 *
 * OSM's tile usage policy: fine for a low-volume demo like this one, not for
 * heavy commercial traffic, requires the OSM attribution below, and asks that
 * clients cache — which the service worker does (see sw.ts). There are no
 * @2x tiles and no subdomain sharding on that host, so no `{r}` and no `{s}`.
 */
const TILE_SOURCES = {
  voyager: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
  },
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    subdomains: 'abc',
  },
} as const;

export type TileVariant = keyof typeof TILE_SOURCES;

/**
 * A PLACED point — a claim about the world ("the entrance is here"), never a
 * live fix. Diamond, not dot, so the two can't be confused at a glance.
 */
export interface PlacedMarker {
  id: string;
  /** The PLACER — used for the initial fallback when there is no icon. */
  label?: string | undefined;
  /** The marker's own short name, shown as a chip under the diamond. */
  name?: string | undefined;
  position: { lat: number; lon: number };
  /** What the spot IS; without one the diamond shows the placer's initial. */
  icon?: MarkerIcon | undefined;
  /** Tapping the diamond — how "tap your marker to change its icon" works. */
  onTap?: (() => void) | undefined;
  /** Popup content (pre-escaped HTML) — the "open in maps" affordance for
      markers that are not ours to edit. Mutually exclusive with onTap. */
  popupHtml?: string | undefined;
}

/**
 * The glyph inside a placed diamond, per icon. Inline SVG strings because
 * they go through Leaflet's divIcon html; each must read at 12px outdoors.
 */
export const MARKER_GLYPHS: Record<MarkerIcon, string> = {
  spot: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3" fill="currentColor"/></svg>',
  warning:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.2 11 10.5H1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><line x1="6" y1="4.6" x2="6" y2="7.2" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="8.9" r="0.9" fill="currentColor"/></svg>',
  flag: '<svg viewBox="0 0 12 12" aria-hidden="true"><line x1="3" y1="1.5" x2="3" y2="10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M3 2h6L7.2 4 9 6H3Z" fill="currentColor"/></svg>',
  cross:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.8 1.5h2.4v3.3h3.3v2.4H7.2v3.3H4.8V7.2H1.5V4.8h3.3Z" fill="currentColor"/></svg>',
  car: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 7l1.2-3h5.6L10 7v2.3H2Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="4" cy="9.6" r="1" fill="currentColor"/><circle cx="8" cy="9.6" r="1" fill="currentColor"/></svg>',
  house:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6l4-4 4 4v4.5H2Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  // The live-v2 additions — outdoors and rendezvous vocabulary. Same rules
  // as the first six: geometric strokes, legible at 12px on a phone outdoors.
  tent: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 10.5 6 2l4.5 8.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 5.5v5" stroke="currentColor" stroke-width="1.2"/></svg>',
  water:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5C7.8 4 9.5 6 9.5 8a3.5 3.5 0 0 1-7 0c0-2 1.7-4 3.5-6.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  danger:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 1 3 6.5h2.5L4.5 11 9 5.5H6.5Z" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round"/></svg>',
  meet: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="4" cy="4" r="1.8" fill="currentColor"/><circle cx="8.6" cy="4.6" r="1.5" fill="currentColor"/><path d="M1.5 10.5c0-1.8 1.1-3 2.7-3s2.6 1.2 2.6 3Z" fill="currentColor"/><path d="M7.2 10.5c.1-1.5 1-2.5 2.2-2.5 1 0 1.8.9 1.9 2.5Z" fill="currentColor"/></svg>',
  dog: '<svg viewBox="0 0 12 12" aria-hidden="true"><ellipse cx="6" cy="8.4" rx="2.4" ry="1.9" fill="currentColor"/><circle cx="2.6" cy="5.4" r="1.1" fill="currentColor"/><circle cx="4.9" cy="3.4" r="1.1" fill="currentColor"/><circle cx="7.4" cy="3.4" r="1.1" fill="currentColor"/><circle cx="9.6" cy="5.4" r="1.1" fill="currentColor"/></svg>',
  camera:
    '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="3.5" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.2 3.5 5 2h2l.8 1.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><circle cx="6" cy="6.7" r="1.7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  boat: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 7.5h9L9 10.2H3Z" fill="currentColor"/><path d="M6.2 1.5v6M6.2 2.2 9.4 6.5H6.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
  tree: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1 3.2 4.8h1.2L2.5 7.8h2.6v2.7h1.8V7.8h2.6L7.6 4.8h1.2Z" fill="currentColor" stroke-linejoin="round"/></svg>',
};

/** The icon chooser — shared by the share sheet and the live room. */
export function MarkerIconPicker({
  current,
  onPick,
}: {
  current: MarkerIcon;
  onPick: (icon: MarkerIcon) => void;
}) {
  return (
    <div className="icon-pick" role="menu" aria-label="What is this spot?">
      {MARKER_ICONS.map((name) => (
        <button
          key={name}
          type="button"
          className={`sheet-icon ${current === name ? 'sheet-icon-active' : ''}`}
          aria-label={name}
          title={name}
          onClick={() => onPick(name)}
          dangerouslySetInnerHTML={{ __html: MARKER_GLYPHS[name] }}
        />
      ))}
    </div>
  );
}

function placedIcon(
  label: string | undefined,
  icon: MarkerIcon | undefined,
  name: string | undefined,
): L.DivIcon {
  let inner: string;
  if (icon !== undefined) {
    // A newer sender may name an icon this build has never heard of; the
    // contract's fallback is a plain spot, never a broken diamond.
    inner = `<span class="placed-marker-glyph">${MARKER_GLYPHS[icon] ?? MARKER_GLYPHS.spot}</span>`;
  } else {
    const first = (label ?? '').trim().charAt(0).toUpperCase();
    const initial = /^[A-Z0-9]$/.test(first) ? first : '•';
    inner = `<span>${initial}</span>`;
  }
  const trimmedName = (name ?? '').trim();
  const chip = trimmedName !== '' ? `<span class="marker-name">${escapeHtml(trimmedName)}</span>` : '';
  return L.divIcon({
    className: 'placed-marker-icon',
    html: `<span class="placed-wrap"><span class="placed-marker">${inner}</span>${chip}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/** The label chip at a zone's centre — name plus, when removable, a ×. */
function zoneChipIcon(name: string, removable: boolean): L.DivIcon {
  const x = removable
    ? '<button type="button" class="zone-x" aria-label="Remove this zone">&#215;</button>'
    : '';
  return L.divIcon({
    className: 'zone-chip-icon',
    html: `<span class="zone-chip">${escapeHtml(name)}${x}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/**
 * Wire the × inside a zone chip to its remove callback. Runs after the chip
 * is added (or re-iconed) — setIcon replaces the DOM element, so the wiring
 * has to chase it. Clicks on the chip must never fall through to the map,
 * where they would place a marker or move the pin.
 */
function wireZoneChip(
  chip: L.Marker,
  id: string,
  removes: { current: Record<string, (() => void) | undefined> },
): void {
  const element = chip.getElement();
  if (element === undefined) return;
  L.DomEvent.disableClickPropagation(element);
  const x = element.querySelector('.zone-x');
  if (x !== null) {
    L.DomEvent.on(x as HTMLElement, 'click', (event) => {
      L.DomEvent.stop(event);
      removes.current[id]?.();
    });
  }
}

/** The transient "said something" bubble, anchored just above a dot. */
function chatFlagIcon(): L.DivIcon {
  return L.divIcon({
    className: 'chat-flag-icon',
    html: '<span class="chat-flag"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-4 4v-4H4Z" fill="currentColor"/></svg></span>',
    iconSize: [24, 24],
    iconAnchor: [12, 34],
  });
}

function peerIcon(
  label: string | undefined,
  avatar?: string,
  disconnected = false,
  trailColour?: string | null,
): L.DivIcon {
  const img = avatarImg(avatar);
  const trail = safeColour(trailColour);
  const first = (label ?? '').trim().charAt(0).toUpperCase();
  // One character, strictly alphanumeric — this goes into innerHTML.
  const initial = /^[A-Z0-9]$/.test(first) ? first : '•';
  const classes = `peer-dot${disconnected ? ' marker-gone' : ''}${trail !== null ? ' marker-trailed' : ''}`;
  return L.divIcon({
    className: 'peer-dot-icon',
    html: `<span class="${classes}"${trail !== null ? ` style="--trail-colour:${trail}"` : ''}>${img ?? initial}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function viewerIcon(avatar?: string): L.DivIcon {
  const img = avatarImg(avatar);
  return L.divIcon({
    className: 'viewer-dot-icon',
    html: `<span class="viewer-dot ${img !== null ? 'viewer-has-avatar' : ''}">${img ?? ''}</span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

export interface MapProps {
  lat: number;
  lon: number;
  accuracyM: number;
  /** Third-party reports are drawn differently — see note below. */
  thirdParty?: boolean;
  /**
   * When set, the pin can be dragged/placed and this fires with the new
   * position plus a placement accuracy derived from the current map zoom — a
   * hand-placed pin is only as precise as how far in the map is zoomed.
   */
  onMove?: (lat: number, lon: number, accuracyM: number) => void;
  /** Previous positions of a live session, oldest first. */
  trail?: Array<[number, number]>;
  /** Tiles come from the network. When there is none, say so. */
  offline?: boolean;
  /**
   * Which basemap to draw: `voyager` (light — the public surfaces) or `dark`
   * (the console). Read once at creation — a mounted map never changes
   * surface.
   */
  tiles?: TileVariant;
  /**
   * Shows the place-search control: a persistent map control, top-left under
   * the zoom buttons, on every surface that sets it. It belongs to the MAP,
   * not to any marker flow — picking a result moves the VIEW there and does
   * nothing else (no marker is placed, nothing is renamed); whoever wants a
   * spot marked places one themselves with the point tool.
   *
   * Surfaces pass their own connectivity here and withhold it while offline,
   * quietly: a field that cannot answer is worse than none. `offline` hides
   * it too — a map with no tiles has no search either.
   */
  placeSearch?: boolean;
  /** When set, shows a "locate me" control that re-fetches the live position. */
  onLocate?: () => void;
  /** Whether a locate request is in flight — the control shows a busy state. */
  locating?: boolean;
  /** The caller's drawing, rendered over the tiles. */
  sketch?: Sketch | null;
  /**
   * When set, the drawing toolbar appears and the map becomes drawable. Fires
   * with the new sketch after each committed shape, undo, or clear (null when
   * the last shape goes). The map owns the gesture; the parent owns the state.
   */
  onSketchChange?: (sketch: Sketch | null) => void;
  /** Where a brand-new sketch is anchored. Defaults to the pin position. */
  sketchAnchor?: { lat: number; lon: number };
  /**
   * Fit the view once to everything the caller put on the map — sketch and
   * placed markers, plus the pin — when it first appears. For read-only maps
   * ONLY — refitting under someone's finger mid-stroke on an editable map
   * would be horrible, so editable maps never set this.
   */
  fitContent?: boolean;
  /** Tiles only — no pin, no accuracy circle. The pre-location start map. */
  hidePin?: boolean;
  /** Zoom for the initial view (default 17). The start map opens wide. */
  initialZoom?: number;
  /**
   * The map fills its parent and stays that way — no expand control, and
   * `fullscreenOverlay` is always shown. Unlike the expand toggle (which
   * fixes to the viewport), this fills whatever box the parent gives it, so
   * the app header above stays reachable.
   */
  fullscreenLocked?: boolean;
  /**
   * Rendered at the bottom of the map whenever it is full screen — the
   * share sheet, the start overlay, the code pill. Sits above the toolbar
   * in the same bottom stack.
   */
  fullscreenOverlay?: ReactNode;
  /** Other live-room participants, drawn as initial-dots. */
  peers?: MapPeer[];
  /** Other participants' drawings, one handle per participant. */
  remoteSketches?: Array<{ id: string; sketch: Sketch }>;
  /** Placed points from the live room, drawn as initialled diamonds. */
  placedMarkers?: PlacedMarker[];
  /** Named zones from the live room — dashed circles with a label chip. */
  zones?: MapZone[];
  /** Transient chat bubbles over participants who just said something. */
  chatFlags?: MapChatFlag[];
  /** Tapping any chat bubble — opens the chat panel. */
  onChatFlagTap?: () => void;
  /** The participant paths currently pinned on this map — see MapTrail. */
  focusTrails?: MapTrail[] | undefined;
  /** Tapping the blue pin — the pin is a participant too, in a live room. */
  onPinTap?: () => void;
  /**
   * When set, the circle tool draws ZONES instead of sketch ink: a committed
   * circle is handed here (with a zoom-derived placement accuracy) rather
   * than added to the sketch, and the parent prompts for a name.
   */
  onZoneDraw?: (center: { lat: number; lon: number }, radiusM: number, accuracyM: number) => void;
  /** The session is at its zone cap — the circle tool disables, quietly. */
  zonesFull?: boolean;
  /** This participant is at their marker cap — the point tool disables. */
  markersFull?: boolean;
  /**
   * Adds a place-a-point tool to the toolbar: tap the tool, tap the map, the
   * point lands there and the tool puts itself down. Fires with a placement
   * accuracy derived from the zoom, like a hand-placed pin.
   */
  onPlaceMarker?: (lat: number, lon: number, accuracyM: number) => void;
  /**
   * A plain tap (no tool active) places the marker too — the share screen's
   * "the spot I mean is here" gesture, and every surface's move-the-marker
   * gesture while its edit strip is open. Needs onPlaceMarker.
   */
  markerOnClick?: boolean;
  /**
   * Fires when the place-a-point tool is picked up or put down — how the
   * parent shows its pre-placement marker strip (search before the first
   * placement) the moment the tool arms, and folds it away when the tool
   * goes down. Transitions only, never the initial state; the tool putting
   * itself down after a placement fires it too.
   */
  onMarkerToolChange?: (armed: boolean) => void;
  /**
   * Whether a plain click may move the PIN. Off wherever a click means
   * "mark a spot" instead — the pin is a person, and it stays one.
   */
  moveOnClick?: boolean;
  /**
   * Adds an expand control that takes the map full screen — for the look-up
   * side, whose map is small, and for drawing, where a 280px strip is a
   * cramped canvas. The top-right controls stack in order: locate, expand,
   * viewer-locate, whichever of them are present.
   */
  allowFullscreen?: boolean;
  /**
   * Adds a control that finds the VIEWER's own position, marks it with a
   * neutral dot, and recentres on it — so whoever looked the code up can see
   * where they are relative to the caller. It NEVER moves the pin: the pin is
   * the caller, and this button must not be able to lie about that.
   */
  showViewerLocation?: boolean;
  /**
   * Where this viewer ALREADY is on the map — a live surface that draws us
   * (the owner's blue pin, a sharing joiner's dot). When set, the
   * viewer-location control recentres on it instead of fetching a fresh fix
   * and drawing a second, instantly-stale dot for the same person.
   */
  selfPosition?: { lat: number; lon: number } | null;
  /**
   * Follow-mode, for surfaces where streaming fixes move a SELF the camera
   * could track (`selfPosition` when the surface streams one, otherwise the
   * pin). Following is a per-map MODE, like every phone map app:
   *
   * `'on'`  — engaged from the start: the view opens centred on self, and
   *           fixes keep it there (the owner's share and live maps).
   * `'off'` — available but disengaged: the view opens on something that is
   *           NOT this viewer (a joiner arriving on the sharer's pin), so
   *           nothing moves the camera until the locate control engages it.
   *
   * Any user pan or zoom, any placement, and any sheet a parent announces
   * via `releaseFollow` DISENGAGES it: fixes then update
   * pins and accuracy rings only — the viewport never moves. The locate
   * control is the ONLY way back in (it recentres on self and re-engages),
   * and it wears an active state while following so the mode is visible.
   *
   * Left unset, the map keeps the legacy framing — the pin is nudged back
   * into view whenever an update walks it out — which is what the read-only
   * console and watcher surfaces want.
   */
  followSelf?: 'on' | 'off';
  /**
   * The account photo of whoever this map's PIN is — shown inside the pin
   * ring. The ring keeps its meaning-colour; the photo only adds a face.
   * Never set for third-party reports: the pin is not the sharer there.
   */
  pinAvatar?: string | null;
  /**
   * Whoever the pin belongs to has dropped their connection. The pin stays
   * put — this is the last position they sent — and ghosts, the same cue the
   * peer dots use. Only ever set on a live room's view of somebody ELSE.
   */
  pinDisconnected?: boolean;
  /**
   * The pin's own path is pinned on the map, in this colour — the same ring
   * the peer dots wear, for the same reason.
   */
  pinTrailColour?: string | null;
  /** Same, for the viewer-location dot. */
  viewerAvatar?: string | null;
  /**
   * Hands the parent the live Leaflet map (and null on teardown) — for
   * surfaces that anchor their own overlays to map positions, like the
   * participant popover. The parent must treat it as read-only.
   */
  onMapReady?: (map: L.Map | null) => void;
  className?: string;
}

export function Map({
  lat,
  lon,
  accuracyM,
  thirdParty = false,
  onMove,
  trail,
  offline = false,
  tiles = 'voyager',
  placeSearch = false,
  onLocate,
  locating = false,
  sketch = null,
  onSketchChange,
  sketchAnchor,
  fitContent = false,
  hidePin = false,
  initialZoom = 17,
  fullscreenLocked = false,
  fullscreenOverlay,
  peers,
  remoteSketches,
  placedMarkers,
  zones,
  chatFlags,
  onChatFlagTap,
  focusTrails,
  onPinTap,
  onZoneDraw,
  zonesFull = false,
  markersFull = false,
  onPlaceMarker,
  markerOnClick = false,
  onMarkerToolChange,
  moveOnClick = true,
  allowFullscreen = false,
  showViewerLocation = false,
  selfPosition = null,
  followSelf,
  pinAvatar = null,
  pinDisconnected = false,
  pinTrailColour = null,
  viewerAvatar = null,
  onMapReady,
  className,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // The map lives in STATE, not a ref, so the layer effect below genuinely
  // depends on it and re-runs when the map is recreated.
  //
  // This matters because React StrictMode mounts, tears down, then remounts in
  // development. With the map in a ref, the layer effect would re-run while
  // still holding a marker belonging to the destroyed first map, take its
  // "already exists" branch, and never attach anything to the second map — so
  // tiles would render but the pin and accuracy circle would silently vanish.
  const [map, setMap] = useState<L.Map | null>(null);

  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const sketchHandleRef = useRef<SketchHandle | null>(null);
  const fittedContentRef = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // Drawing state. The active tool lives in state (the toolbar renders from
  // it); everything the pointer handlers need is mirrored into refs so the
  // handlers never close over a stale sketch.
  const [activeTool, setActiveTool] = useState<DrawTool | 'none' | 'marker'>('none');
  const [ink, setInk] = useState<SketchColour>(0);
  const [inkOpen, setInkOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [sketchFull, setSketchFull] = useState(false);
  const activeToolRef = useRef(activeTool);
  activeToolRef.current = activeTool;
  const inkRef = useRef(ink);
  inkRef.current = ink;
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;
  const onSketchChangeRef = useRef(onSketchChange);
  onSketchChangeRef.current = onSketchChange;
  const anchorRef = useRef({ lat, lon });
  anchorRef.current = sketchAnchor ?? { lat, lon };

  const [fullscreen, setFullscreen] = useState(false);
  const hadPinRef = useRef(!hidePin);

  // Follow-mode. The mode lives in state (the locate control renders its
  // active face from it) with a ref mirror kept in step synchronously, so a
  // fix landing between a gesture and the re-render can never sneak one last
  // camera move in. `programmaticMovesRef` brackets our own setView/panTo
  // calls — Leaflet fires the same movestart/zoomstart for those as for a
  // finger, and only the finger may disengage.
  const followAvailable = followSelf !== undefined;
  const [following, setFollowing] = useState(followSelf === 'on');
  const followingRef = useRef(following);
  const programmaticMovesRef = useRef(0);
  const setFollow = (on: boolean) => {
    followingRef.current = on;
    setFollowing(on);
  };
  /** Run one of our own camera moves without it reading as the user's. */
  const moveCamera = (run: () => void) => {
    programmaticMovesRef.current += 1;
    try {
      run();
    } finally {
      programmaticMovesRef.current -= 1;
    }
  };

  // The place-search control. Collapsed it is one glyph; open it is a field
  // and its results. `flewTo` is the receipt for a camera move that has
  // already happened — see flyToPlace.
  const [searchOpen, setSearchOpen] = useState(false);
  const [flewTo, setFlewTo] = useState<string | null>(null);

  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerNote, setViewerNote] = useState<string | null>(null);
  const viewerMarkerRef = useRef<L.Marker | null>(null);
  const viewerCircleRef = useRef<L.Circle | null>(null);
  // Records, not Maps — the global Map is shadowed by this component's name.
  const peerLayersRef = useRef<Record<string, { marker: L.Marker; circle: L.Circle; face: string }>>({});
  const peerTapsRef = useRef<Record<string, (() => void) | undefined>>({});
  const remoteSketchesRef = useRef<Record<string, SketchHandle>>({});
  const placedLayersRef = useRef<Record<string, { marker: L.Marker; key: string; popup: string }>>({});
  const placedTapsRef = useRef<Record<string, (() => void) | undefined>>({});
  const zoneLayersRef = useRef<Record<string, { circle: L.Circle; chip: L.Marker; key: string }>>({});
  const offscreenRef = useRef<OffscreenIndicatorsHandle | null>(null);
  const zoneRemovesRef = useRef<Record<string, (() => void) | undefined>>({});
  const chatFlagLayersRef = useRef<Record<string, L.Marker>>({});
  /** id → the polyline drawing that person's pinned path. */
  const focusTrailLayersRef = useRef<Record<string, L.Polyline>>({});
  const onPlaceMarkerRef = useRef(onPlaceMarker);
  onPlaceMarkerRef.current = onPlaceMarker;
  const onMarkerToolChangeRef = useRef(onMarkerToolChange);
  onMarkerToolChangeRef.current = onMarkerToolChange;
  const onZoneDrawRef = useRef(onZoneDraw);
  onZoneDrawRef.current = onZoneDraw;
  const onPinTapRef = useRef(onPinTap);
  onPinTapRef.current = onPinTap;
  const onChatFlagTapRef = useRef(onChatFlagTap);
  onChatFlagTapRef.current = onChatFlagTap;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;

  useEffect(() => {
    if (containerRef.current === null) return;

    const instance = L.map(containerRef.current, { zoomControl: true }).setView([lat, lon], initialZoom);
    const source = TILE_SOURCES[tiles];
    L.tileLayer(source.url, {
      attribution: source.attribution,
      subdomains: source.subdomains,
      maxZoom: 19,
    }).addTo(instance);

    // Leaflet measures the container on creation. If it was hidden or still
    // being laid out at that moment it computes a zero size and renders a grey
    // box, so re-measure once the browser has settled.
    // Cancelled on teardown: a map that is created and destroyed within the
    // same frame — StrictMode's double mount, or a phase change landing on top
    // of one — otherwise leaves this callback to run against a removed map and
    // throw out of the animation frame.
    const measure = requestAnimationFrame(() => moveCamera(() => instance.invalidateSize()));

    setMap(instance);
    onMapReadyRef.current?.(instance);
    // Dev builds only (dead-code-eliminated from production): the newest
    // Leaflet map is reachable from the console — same idiom as SessionMap's
    // __liveHandlers — so the camera can be driven and the view healed
    // (invalidateSize) when exercising the UI headlessly. A hidden page gets
    // no animation frames, so the re-measure above never runs there; this is
    // the hook that let the off-screen indicators be verified regardless.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>)['__devMap'] = instance;
    }

    return () => {
      cancelAnimationFrame(measure);
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>)['__devMap'];
      }
      onMapReadyRef.current?.(null);
      instance.remove();
      setMap(null);
      // Drop the layer handles too. They belong to the map just destroyed, and
      // leaving them set is precisely what breaks the remount.
      markerRef.current = null;
      circleRef.current = null;
      trailRef.current = null;
      focusTrailLayersRef.current = {};
      sketchHandleRef.current = null;
      viewerMarkerRef.current = null;
      viewerCircleRef.current = null;
      peerLayersRef.current = {};
      remoteSketchesRef.current = {};
      placedLayersRef.current = {};
      zoneLayersRef.current = {};
      chatFlagLayersRef.current = {};
      fittedContentRef.current = false;
    };
    // Created once per mount; position changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow-mode disengagement: the user taking hold of the camera puts the
  // mode down. `dragstart` is only ever a finger; `zoomstart` and `movestart`
  // fire for our own setView/panTo too, so both are gated on the bracket
  // around every programmatic move (`movestart` is what catches keyboard
  // pans and anything else Leaflet moves without a drag). Registering the
  // release hook here is what lets `centreOnPlacement` and `releaseFollow`
  // reach this map's mode from a parent holding only the Leaflet instance.
  useEffect(() => {
    if (map === null || !followAvailable) return;
    followHooksByMap.set(map, { release: () => setFollow(false) });
    const onUserMove = () => {
      if (programmaticMovesRef.current === 0) setFollow(false);
    };
    map.on('dragstart', onUserMove);
    map.on('zoomstart', onUserMove);
    map.on('movestart', onUserMove);
    return () => {
      map.off('dragstart', onUserMove);
      map.off('zoomstart', onUserMove);
      map.off('movestart', onUserMove);
      followHooksByMap.delete(map);
    };
    // setFollow only writes state; it cannot go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, followAvailable]);

  // The point tool's parent-facing plumbing. The disarm hook mirrors the
  // follow hooks above: a parent holding only the Leaflet map can put the
  // tool down when its own placement path (a pre-placement search pick)
  // fires without a map tap.
  useEffect(() => {
    if (map === null) return;
    markerToolHooksByMap.set(map, {
      disarm: () => setActiveTool((current) => (current === 'marker' ? 'none' : current)),
    });
    return () => {
      markerToolHooksByMap.delete(map);
    };
  }, [map]);

  // Tell the parent when the tool arms or disarms — transitions only, so a
  // mount (or a StrictMode remount) can never fold away a strip the parent
  // legitimately has open.
  const markerToolArmed = activeTool === 'marker';
  const markerToolWasArmedRef = useRef(false);
  useEffect(() => {
    if (markerToolWasArmedRef.current === markerToolArmed) return;
    markerToolWasArmedRef.current = markerToolArmed;
    onMarkerToolChangeRef.current?.(markerToolArmed);
  }, [markerToolArmed]);

  // The surface can change its stance (report-elsewhere drops the self pin
  // entirely); follow stands down or re-arms with it.
  useEffect(() => {
    setFollow(followSelf === 'on');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followSelf]);

  // Sync marker, accuracy circle and trail to the current position.
  useEffect(() => {
    if (map === null) return;
    // The start map has no position yet — tiles only, nothing to sync.
    if (hidePin) return;

    // Amber for a reported (third-party) location, blue for the sharer's own.
    // A dispatcher confusing "where the caller is" with "where they say the
    // incident is" is the worst failure this UI can produce, so the two never
    // look alike.
    const colour = thirdParty ? '#d97706' : '#2563eb';
    // A third-party pin is not the sharer, so it never wears their face.
    const face = thirdParty ? undefined : (pinAvatar ?? undefined);

    if (markerRef.current === null) {
      const marker = L.marker([lat, lon], {
        icon: pinIcon(colour, face, pinDisconnected, pinTrailColour),
        draggable: onMoveRef.current !== undefined,
      }).addTo(map);

      marker.on('dragend', (event) => {
        const { lat: newLat, lng } = (event.target as L.Marker).getLatLng();
        onMoveRef.current?.(newLat, lng, placementAccuracy(newLat, map.getZoom()));
      });

      // The pin is a participant too in a live room — tapping it opens their
      // card, exactly like tapping a peer dot.
      marker.on('click', () => onPinTapRef.current?.());

      markerRef.current = marker;
    } else {
      markerRef.current.setLatLng([lat, lon]);
      markerRef.current.setIcon(pinIcon(colour, face, pinDisconnected, pinTrailColour));
    }

    if (circleRef.current === null) {
      circleRef.current = L.circle([lat, lon], {
        radius: accuracyM,
        color: colour,
        fillColor: colour,
        fillOpacity: 0.12,
        weight: 1,
        ...(pinDisconnected ? GONE_CIRCLE : {}),
      }).addTo(map);
    } else {
      circleRef.current.setLatLng([lat, lon]);
      circleRef.current.setRadius(accuracyM);
      circleRef.current.setStyle({
        color: colour,
        fillColor: colour,
        ...(pinDisconnected ? GONE_CIRCLE : { ...LIVE_CIRCLE, fillOpacity: 0.12 }),
      });
    }

    if (trail !== undefined && trail.length > 1) {
      if (trailRef.current === null) {
        trailRef.current = L.polyline(trail, {
          color: colour,
          weight: 2,
          dashArray: '4 4',
        }).addTo(map);
      } else {
        trailRef.current.setLatLngs(trail);
      }
    } else if (trailRef.current !== null) {
      // A trail that empties must leave the map — without this branch the
      // last polyline lingered forever once drawn.
      trailRef.current.remove();
      trailRef.current = null;
    }
  }, [map, lat, lon, accuracyM, thirdParty, trail, hidePin, pinAvatar, pinDisconnected, pinTrailColour]);

  // The pinned participant paths — add, restyle, extend and remove to match
  // the list, exactly like the peer dots. Dotted and semi-transparent: a path
  // is history, never a live position or a claim.
  //
  // The removal side is the half that has bitten before (a single trail that
  // emptied used to linger forever). With several paths up it matters more,
  // not less: an id that leaves the list must take its polyline with it, or a
  // path stays drawn for someone who has left the room.
  useEffect(() => {
    if (map === null) return;
    const layers = focusTrailLayersRef.current;
    const seen = new Set<string>();
    for (const trail of focusTrails ?? []) {
      if (trail.points.length < 2) continue; // one fix is a position, not a path
      seen.add(trail.id);
      const style = {
        color: trail.colour,
        weight: 3,
        opacity: trail.ghost === true ? 0.32 : 0.75,
        dashArray: '1 7',
        lineCap: 'round' as const,
      };
      const existing = layers[trail.id];
      if (existing === undefined) {
        layers[trail.id] = L.polyline(trail.points, style).addTo(map);
      } else {
        existing.setLatLngs(trail.points);
        existing.setStyle(style);
      }
    }
    for (const [id, layer] of Object.entries(layers)) {
      if (seen.has(id)) continue;
      layer.remove();
      delete layers[id];
    }
  }, [map, focusTrails]);

  // Sync the committed sketch. Same shape as the marker effect above, and its
  // handle is nulled in the same teardown, for the same StrictMode reason.
  useEffect(() => {
    if (map === null) return;
    if (sketchHandleRef.current === null) {
      sketchHandleRef.current = attachSketch(map, sketch);
    } else {
      sketchHandleRef.current.update(sketch);
    }
  }, [map, sketch]);

  // Fit the view to the caller's content once, when it first arrives on a
  // read-only map — a marked spot centred off-screen might as well not exist.
  // Once only, and never on editable maps — the existing auto-pan effect
  // below keeps working unchanged afterwards, and after a fit that includes
  // the pin the two cannot fight.
  useEffect(() => {
    if (map === null || !fitContent) return;
    const hasSketch = sketch !== null && sketch.shapes.length > 0;
    const placed = placedMarkers ?? [];
    if (!hasSketch && placed.length === 0) return;
    if (fittedContentRef.current) return;
    fittedContentRef.current = true;
    const bounds = L.latLngBounds([[lat, lon]]);
    if (hasSketch) {
      const sketched = sketchBounds(sketch);
      if (sketched !== null) bounds.extend(L.latLngBounds(sketched));
    }
    for (const marker of placed) bounds.extend([marker.position.lat, marker.position.lon]);
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 18 });
  }, [map, fitContent, sketch, placedMarkers, lat, lon]);

  // Sync the peer dots — add, move, and remove to match the roster.
  useEffect(() => {
    if (map === null) return;
    const layers = peerLayersRef.current;
    const seen = new Set<string>();
    for (const peer of peers ?? []) {
      seen.add(peer.id);
      peerTapsRef.current[peer.id] = peer.onTap;
      const at: [number, number] = [peer.position.lat, peer.position.lon];
      const existing = layers[peer.id];
      // Icons carry the label, avatar and connected-ness, so a change to any
      // of them re-renders the dot rather than leaving a stale face on a
      // renamed peer — or a live-looking dot on someone who has dropped off.
      const gone = peer.disconnected ?? false;
      const trailColour = peer.trailColour ?? null;
      const face = `${peer.label ?? ''}|${peer.avatar ?? ''}|${gone ? 'gone' : 'live'}|${trailColour ?? ''}`;
      if (existing === undefined) {
        const created = L.marker(at, {
          icon: peerIcon(peer.label, peer.avatar, gone, trailColour),
          // A ghosted dot is still THEIR last position — tapping it must open
          // their card, which is where "last connected …" is said out loud.
          interactive: peer.onTap !== undefined,
          keyboard: false,
        }).addTo(map);
        if (peer.onTap !== undefined) {
          const id = peer.id;
          created.on('click', () => peerTapsRef.current[id]?.());
        }
        layers[peer.id] = {
          face,
          marker: created,
          circle: L.circle(at, {
            radius: peer.position.accuracyM,
            color: PEER_COLOUR,
            fillColor: PEER_COLOUR,
            fillOpacity: 0.08,
            weight: 1,
            ...(gone ? GONE_CIRCLE : {}),
          }).addTo(map),
        };
      } else {
        existing.marker.setLatLng(at);
        if (existing.face !== face) {
          existing.marker.setIcon(peerIcon(peer.label, peer.avatar, gone, trailColour));
          existing.circle.setStyle(gone ? GONE_CIRCLE : { ...LIVE_CIRCLE, fillOpacity: 0.08 });
          existing.face = face;
        }
        existing.circle.setLatLng(at);
        existing.circle.setRadius(peer.position.accuracyM);
      }
    }
    for (const id of Object.keys(layers)) {
      if (!seen.has(id)) {
        layers[id]!.marker.remove();
        layers[id]!.circle.remove();
        delete layers[id];
      }
    }
  }, [map, peers]);

  // Sync other participants' drawings — one renderer handle each.
  useEffect(() => {
    if (map === null) return;
    const handles = remoteSketchesRef.current;
    const seen = new Set<string>();
    for (const remote of remoteSketches ?? []) {
      seen.add(remote.id);
      const existing = handles[remote.id];
      if (existing === undefined) handles[remote.id] = attachSketch(map, remote.sketch);
      else existing.update(remote.sketch);
    }
    for (const id of Object.keys(handles)) {
      if (!seen.has(id)) {
        handles[id]!.remove();
        delete handles[id];
      }
    }
  }, [map, remoteSketches]);

  // Sync the placed markers. Icons and popups are only rebuilt when their
  // content changes — the list identity churns on every roster frame, and
  // re-binding a popup would slam it shut under the reader.
  useEffect(() => {
    if (map === null) return;
    const layers = placedLayersRef.current;
    const seen = new Set<string>();
    for (const placed of placedMarkers ?? []) {
      seen.add(placed.id);
      placedTapsRef.current[placed.id] = placed.onTap;
      const at: [number, number] = [placed.position.lat, placed.position.lon];
      const key = `${placed.label ?? ''}|${placed.icon ?? ''}|${placed.name ?? ''}`;
      const popup = placed.popupHtml ?? '';
      const existing = layers[placed.id];
      if (existing === undefined) {
        const created = L.marker(at, {
          icon: placedIcon(placed.label, placed.icon, placed.name),
          interactive: placed.onTap !== undefined || popup !== '',
          keyboard: false,
        }).addTo(map);
        if (placed.onTap !== undefined) {
          const id = placed.id;
          created.on('click', () => placedTapsRef.current[id]?.());
        }
        if (popup !== '') created.bindPopup(popup);
        layers[placed.id] = { marker: created, key, popup };
      } else {
        existing.marker.setLatLng(at);
        if (existing.key !== key) {
          existing.marker.setIcon(placedIcon(placed.label, placed.icon, placed.name));
          existing.key = key;
        }
        if (existing.popup !== popup) {
          existing.marker.unbindPopup();
          if (popup !== '') existing.marker.bindPopup(popup);
          existing.popup = popup;
        }
      }
    }
    for (const id of Object.keys(layers)) {
      if (!seen.has(id)) {
        layers[id]!.marker.remove();
        delete layers[id];
      }
    }
  }, [map, placedMarkers]);

  // Sync the zones — dashed neutral circles with a label chip at the centre.
  useEffect(() => {
    if (map === null) return;
    const layers = zoneLayersRef.current;
    const seen = new Set<string>();
    for (const zone of zones ?? []) {
      seen.add(zone.id);
      zoneRemovesRef.current[zone.id] = zone.onRemove;
      const at: [number, number] = [zone.center.lat, zone.center.lon];
      const key = `${zone.name}|${zone.onRemove !== undefined ? 'x' : ''}`;
      const existing = layers[zone.id];
      if (existing === undefined) {
        const circle = L.circle(at, {
          radius: zone.radiusM,
          color: '#475569',
          weight: 2.5,
          dashArray: '7 7',
          fillColor: '#475569',
          fillOpacity: 0.06,
          interactive: false,
        }).addTo(map);
        const chip = L.marker(at, {
          icon: zoneChipIcon(zone.name, zone.onRemove !== undefined),
          interactive: true,
          keyboard: false,
        }).addTo(map);
        wireZoneChip(chip, zone.id, zoneRemovesRef);
        layers[zone.id] = { circle, chip, key };
      } else {
        existing.circle.setLatLng(at);
        existing.circle.setRadius(zone.radiusM);
        existing.chip.setLatLng(at);
        if (existing.key !== key) {
          existing.chip.setIcon(zoneChipIcon(zone.name, zone.onRemove !== undefined));
          wireZoneChip(existing.chip, zone.id, zoneRemovesRef);
          existing.key = key;
        }
      }
    }
    for (const id of Object.keys(layers)) {
      if (!seen.has(id)) {
        layers[id]!.circle.remove();
        layers[id]!.chip.remove();
        delete layers[id];
      }
    }
  }, [map, zones]);

  // Off-screen indicators: markers and zones that pan or zoom out of the
  // viewport get an edge pill pointing back at them. Markers and zones ONLY
  // — never people, never the self pin (see offscreen-indicators.ts for the
  // reasoning). Tapping one is deliberate navigation: follow-mode goes down
  // exactly like a manual pan (via releaseFollow), and the move is a
  // jump-cut, never a glide — event.latlng is unreliable mid-animation, and
  // the next tap is likely. Deliberately NOT coupled to any placement
  // behaviour: this is the indicators' own camera move.
  useEffect(() => {
    if (map === null) return;
    // Centre the tapped object in the part of the map the person can SEE —
    // the bottom overlay stack (toolbar, sheets, the live bar) covers the
    // foot of the map, and a target centred underneath it might as well
    // still be off-screen.
    const centreOnTarget = (lat: number, lon: number) => {
      const size = map.getSize();
      const stack = map.getContainer().parentElement?.querySelector('.map-bottom-stack');
      const covered = stack instanceof HTMLElement ? Math.min(stack.offsetHeight, size.y) : 0;
      const zoom = map.getZoom();
      const offset = Math.max(0, Math.min(covered / 2, size.y / 2 - 44));
      const centre = map.unproject(
        map.project(L.latLng(lat, lon), zoom).add(L.point(0, Math.round(offset))),
        zoom,
      );
      releaseFollow(map);
      map.setView(centre, zoom, { animate: false });
    };
    const handle = attachOffscreenIndicators(map, {
      onTap: (target) => centreOnTarget(target.lat, target.lon),
      onTapCluster: (list) => {
        if (list.length === 0) return;
        // Bringing a crowd into view is still deliberate navigation: follow
        // goes down first, and the move is a jump-cut for the same
        // tap-mid-animation reason as centreOnPlacement. Never zooms IN —
        // the person chose their zoom; this only widens until the lot fits.
        releaseFollow(map);
        const bounds = L.latLngBounds(list.map((t) => [t.lat, t.lon] as [number, number]));
        const stack = map.getContainer().parentElement?.querySelector('.map-bottom-stack');
        const covered =
          stack instanceof HTMLElement ? Math.min(stack.offsetHeight, map.getSize().y / 2) : 0;
        map.fitBounds(bounds, {
          paddingTopLeft: L.point(48, 48),
          paddingBottomRight: L.point(48, 48 + covered),
          maxZoom: map.getZoom(),
          animate: false,
        });
      },
    });
    offscreenRef.current = handle;
    return () => {
      offscreenRef.current = null;
      handle.remove();
    };
  }, [map]);

  // Feed the indicators the current object list. The marker glyph reuses the
  // diamond's own table (falling back to the placer's vetted initial, exactly
  // like placedIcon); a zone is its dashed-circle motif, built in the module.
  useEffect(() => {
    const handle = offscreenRef.current;
    if (handle === null) return;
    const list: OffscreenTarget[] = [];
    for (const placed of placedMarkers ?? []) {
      let glyphHtml: string;
      if (placed.icon !== undefined) {
        glyphHtml = MARKER_GLYPHS[placed.icon] ?? MARKER_GLYPHS.spot;
      } else {
        const first = (placed.label ?? '').trim().charAt(0).toUpperCase();
        glyphHtml = `<span>${/^[A-Z0-9]$/.test(first) ? first : '•'}</span>`;
      }
      list.push({
        id: `marker:${placed.id}`,
        kind: 'marker',
        lat: placed.position.lat,
        lon: placed.position.lon,
        glyphHtml,
        name: (placed.name ?? '').trim(),
      });
    }
    for (const zone of zones ?? []) {
      list.push({
        id: `zone:${zone.id}`,
        kind: 'zone',
        lat: zone.center.lat,
        lon: zone.center.lon,
        name: zone.name.trim(),
      });
    }
    handle.update(list);
  }, [map, placedMarkers, zones]);

  // Sync the transient chat bubbles. Their lifetime belongs to the parent;
  // this effect only mirrors the list.
  useEffect(() => {
    if (map === null) return;
    const layers = chatFlagLayersRef.current;
    const seen = new Set<string>();
    for (const flag of chatFlags ?? []) {
      seen.add(flag.id);
      const at: [number, number] = [flag.position.lat, flag.position.lon];
      const existing = layers[flag.id];
      if (existing === undefined) {
        const created = L.marker(at, { icon: chatFlagIcon(), keyboard: false }).addTo(map);
        created.on('click', () => onChatFlagTapRef.current?.());
        layers[flag.id] = created;
      } else {
        existing.setLatLng(at);
      }
    }
    for (const id of Object.keys(layers)) {
      if (!seen.has(id)) {
        layers[id]!.remove();
        delete layers[id];
      }
    }
  }, [map, chatFlags]);

  // The marker tool — and, where markerOnClick says so, the plain tap: the
  // point lands, the tool (if one was up) puts itself down.
  useEffect(() => {
    if (map === null || onPlaceMarker === undefined) return;
    const handler = (event: L.LeafletMouseEvent) => {
      const tool = activeToolRef.current;
      const viaTool = tool === 'marker';
      if (!viaTool && !(markerOnClick && tool === 'none')) return;
      onPlaceMarkerRef.current?.(
        event.latlng.lat,
        event.latlng.lng,
        placementAccuracy(event.latlng.lat, map.getZoom()),
      );
      // The camera does NOT move — the marker drops exactly where the finger
      // is, and it is on screen by construction. But a placement is still
      // user intent: follow-mode goes down so the next streaming fix cannot
      // snap the view back to self and off the spot just placed.
      releaseFollow(map);
      if (viaTool) setActiveTool('none');
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onPlaceMarker, markerOnClick]);

  // Entering or leaving full screen resizes the container out from under
  // Leaflet, which measures once. Re-measure after the new layout applies.
  useEffect(() => {
    if (map === null) return;
    const measure = requestAnimationFrame(() => moveCamera(() => map.invalidateSize()));
    return () => cancelAnimationFrame(measure);
    // moveCamera is a stable pass-through around a ref counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fullscreen]);

  // Full screen is a history entry, so the phone's Back button closes it —
  // every close path (pill, Escape, Back itself) goes through one pop.
  const openFullscreen = () => {
    window.history.pushState({ shareUi: 'mapfull' }, '');
    setFullscreen(true);
  };
  const closeFullscreen = () => window.history.back();
  useEffect(() => {
    if (!fullscreen) return;
    const onPop = () => setFullscreen(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeFullscreen();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  // How tall the bottom overlay stack is right now, published to CSS as
  // `--map-bottom-h`. The search panel hangs from the TOP of the map and must
  // not grow down into the toolbar, the marker strips and the live bar — and
  // only the DOM knows how tall those are from moment to moment (the toolbar
  // wraps to two rows at 320px; a strip appears and disappears). This is the
  // same measurement `centreOnPlacement` takes for the camera, kept live.
  useEffect(() => {
    if (map === null) return;
    const frame = map.getContainer().parentElement;
    if (frame === null) return;
    const stack = frame.querySelector('.map-bottom-stack');
    if (!(stack instanceof HTMLElement)) return;
    const publish = () => frame.style.setProperty('--map-bottom-h', `${stack.offsetHeight}px`);
    // Measured outright every time the panel opens, as well as watched while
    // it is: a ResizeObserver only delivers during the rendering lifecycle,
    // which a hidden page never runs (the same trap the creation effect's
    // invalidateSize falls into), and the height has to be right at the
    // moment the panel appears.
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [map, searchOpen]);

  // The "could not locate you" note clears itself.
  useEffect(() => {
    if (viewerNote === null) return;
    const timer = window.setTimeout(() => setViewerNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [viewerNote]);

  // So does the "moved to X" one: it is a receipt for a camera move that has
  // already happened, not a state the map is in.
  useEffect(() => {
    if (flewTo === null) return;
    const timer = window.setTimeout(() => setFlewTo(null), 4000);
    return () => window.clearTimeout(timer);
  }, [flewTo]);

  // Signal dies with the field open: fold it away rather than leaving a box
  // that cannot answer, and do not spring it open again when signal returns.
  const searchAvailable = placeSearch && !offline;
  useEffect(() => {
    if (searchAvailable) return;
    setSearchOpen(false);
    setFlewTo(null);
  }, [searchAvailable]);

  // The moment the wide-open start map gets its first real fix, jump to
  // street level — the view change IS the feedback that locating worked.
  useEffect(() => {
    // animate: false is load-bearing — event.latlng is unreliable while a
    // zoom animation runs, so a tap in that window would place a marker
    // somewhere absurd. A jump-cut has no such window.
    if (map !== null && !hidePin && !hadPinRef.current) {
      // This is the view opening centred on self — the moment follow-mode
      // engages, exactly as the locate control would (browsing the wide
      // start map beforehand must not leave the located view unmoored).
      if (followAvailable) setFollow(true);
      moveCamera(() => map.setView([lat, lon], 17, { animate: false }));
    }
    hadPinRef.current = !hidePin;
    // setFollow/moveCamera only write refs and state; they cannot go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, hidePin, lat, lon]);

  // Keep the view on the followed position when it changes underneath us — a
  // live session that walks off the edge of the map is worse than useless.
  // On follow-mode surfaces this IS the mode: while disengaged (a pan, a
  // zoom, a placement, a sheet), fixes update the pin and its ring but the
  // viewport never moves. Legacy surfaces (the console, a watcher) keep the
  // always-on nudge. Never while a drawing tool is up — the same
  // no-refit-mid-gesture rule the fit effect documents.
  useEffect(() => {
    if (map === null) return;
    if (followAvailable && !followingRef.current) return;
    if (activeTool !== 'none') return;
    const at = followAvailable && selfPosition !== null ? selfPosition : hidePin ? null : { lat, lon };
    if (at === null) return;
    const target = L.latLng(at.lat, at.lon);
    if (map.getBounds().contains(target)) return;
    moveCamera(() => {
      // A nearby drift pans smoothly; a far jump (a searched place two
      // counties over) snaps, because animating across a country is
      // nauseating.
      if (map.getCenter().distanceTo(target) > 5000) {
        map.setView(target, map.getZoom(), { animate: false });
      } else {
        map.panTo(target);
      }
    });
    // moveCamera is a stable pass-through around a ref counter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lat, lon, hidePin, selfPosition, following, followAvailable, activeTool]);

  // Allow map clicks to reposition the pin when the map is editable.
  useEffect(() => {
    if (map === null || onMove === undefined || !moveOnClick) return;

    const handler = (event: L.LeafletMouseEvent) => {
      // While a draw tool is active a tap is a stroke, not a pin move — the
      // browser still synthesises a click after pointerup, and without this
      // the first stroke would also teleport the pin.
      if (activeToolRef.current !== 'none') return;
      onMoveRef.current?.(event.latlng.lat, event.latlng.lng, placementAccuracy(event.latlng.lat, map.getZoom()));
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onMove, moveOnClick]);

  // The drawing interaction: pointer events on the map container while a tool
  // is active. Panning and double-click zoom are handed back on cleanup.
  // Two-finger pinch keeps working BETWEEN strokes (Leaflet's touchZoom rides
  // touch events, which pointer capture does not intercept); a second pointer
  // arriving MID-stroke abandons the stroke, so a pinch never leaves ink.
  useEffect(() => {
    if (map === null || activeTool === 'none' || activeTool === 'marker' || onSketchChange === undefined) return;

    const container = map.getContainer();
    const previousTouchAction = container.style.touchAction;
    container.style.touchAction = 'none'; // a stroke must not scroll the page
    map.dragging.disable();
    map.doubleClickZoom.disable();
    const markerWasDraggable = markerRef.current?.dragging?.enabled() ?? false;
    markerRef.current?.dragging?.disable(); // grabbing the pin mid-sketch is a stroke too

    // The in-progress stroke previews through the same renderer as committed
    // shapes, so what the caller sees while drawing is exactly what will land.
    const preview = attachSketch(map, null);
    let stroke: StrokeInProgress | null = null;
    let pointerId: number | null = null;

    const toPoint = (event: PointerEvent) => {
      const latlng = map.mouseEventToLatLng(event as unknown as MouseEvent);
      return { lat: latlng.lat, lon: latlng.lng };
    };
    const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
      map.distance([a.lat, a.lon], [b.lat, b.lon]);
    const abandon = () => {
      stroke = null;
      pointerId = null;
      preview.update(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (pointerId !== null) {
        // Second finger down: this is a pinch, not a drawing. Abandon rather
        // than committing half a stroke the caller did not mean.
        abandon();
        return;
      }
      pointerId = event.pointerId;
      container.setPointerCapture(event.pointerId);
      stroke = beginStroke(activeTool as DrawTool, toPoint(event));
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (stroke === null || event.pointerId !== pointerId) return;
      stroke = extendStroke(stroke, toPoint(event));
      const shape = previewShape(stroke, inkRef.current, metres);
      preview.update(shape === null ? null : { anchor: anchorRef.current, shapes: [shape] });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (stroke === null || event.pointerId !== pointerId) return;
      const finished = extendStroke(stroke, toPoint(event));
      abandon();

      const shape = commitShape(finished, inkRef.current, metres);
      if (shape === null) return; // a tap, a twitch — not a drawing

      // In a live room a circle is a ZONE, not ink — hand it to the parent
      // to be named. The circle's own radius is its extent; the accuracy is
      // how finely the centre could be pointed at this zoom.
      if (shape.kind === 'circle' && onZoneDrawRef.current !== undefined) {
        // The naming sheet is about to open over this zone — follow goes
        // down so a fix cannot drag the map out from under it.
        setFollow(false);
        onZoneDrawRef.current(
          { lat: shape.centre.lat, lon: shape.centre.lon },
          shape.radiusM,
          placementAccuracy(shape.centre.lat, map.getZoom()),
        );
        setActiveTool('none');
        return;
      }

      const base = sketchRef.current ?? { anchor: anchorRef.current, shapes: [] };
      const next = withShapeIfItFits(base, shape);
      if (next === null) {
        setSketchFull(true);
        return;
      }
      setSketchFull(false);
      onSketchChangeRef.current?.(next);
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) abandon();
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
      container.style.touchAction = previousTouchAction;
      map.dragging.enable();
      map.doubleClickZoom.enable();
      if (markerWasDraggable) markerRef.current?.dragging?.enable();
      preview.remove();
    };
  }, [map, activeTool, onSketchChange]);

  // Snap the camera home to self — what both locate controls do when they
  // re-engage follow-mode. Same near-pan/far-snap discipline as the follow
  // effect, for the same nausea reason.
  const returnToSelf = () => {
    if (map === null) return;
    const at = selfPosition ?? { lat, lon };
    const target = L.latLng(at.lat, at.lon);
    moveCamera(() => {
      if (map.getCenter().distanceTo(target) > 5000) {
        map.setView(target, map.getZoom(), { animate: false });
      } else {
        map.panTo(target);
      }
    });
  };

  /**
   * A picked search result. This is NAVIGATION and nothing else: the view
   * moves to the place, no marker is dropped, nothing is renamed. Searching
   * used to BE marking — it fronted every placement flow and named the
   * marker after the place. It no longer does: the search belongs to the
   * map, and the point tool is the only thing here that makes a claim about
   * the world.
   *
   * Follow-mode goes down through the same `releaseFollow` path a finger-pan
   * uses, because deliberately going to look somewhere else is exactly the
   * gesture that means "stop tracking me" — without it the next streaming fix
   * would yank the view straight back off the place just asked for.
   *
   * Always a jump-cut, never a glide, for the reason `centreOnPlacement`
   * gives: `event.latlng` is unreliable while an animation runs, and arriving
   * somewhere is often followed immediately by a tap.
   */
  const flyToPlace = (lat: number, lon: number, accuracyM: number, label: string) => {
    if (map === null) return;
    setSearchOpen(false);
    releaseFollow(map);
    const size = map.getSize();
    const stack = map.getContainer().parentElement?.querySelector('.map-bottom-stack');
    const covered = stack instanceof HTMLElement ? Math.min(stack.offsetHeight, size.y) : 0;
    // Frame the PLACE at its own scale — a named building arrives at street
    // level, a whole town opens out — rather than pretending every result
    // deserves the same zoom. The result carries its own honest extent (half
    // its bounding-box diagonal); clamped both ways so a coarse answer never
    // flings the map to county scale and a fine one never claims more
    // precision than a hand placement could.
    //
    // Only when the container has actually been measured, though. Leaflet
    // caches the size it read at creation, and a map laid out while hidden
    // keeps a zero until something calls invalidateSize — a real state on
    // this map, which re-measures from an animation frame a hidden page never
    // gets (see the creation effect). Framing off a zero size makes
    // getBoundsZoom return 0, which would silently fling every search to the
    // widest zoom this allows. Measured: `{x: 350, y: 0}` → zoom 12 for a
    // cathedral. Keep the zoom the person is already on instead — going to
    // the right place at the wrong scale is recoverable; the guess is not.
    const measured = size.x > 0 && size.y > 0;
    const span = L.latLng(lat, lon).toBounds(Math.max(120, accuracyM * 6));
    const zoom = measured
      ? Math.min(17, Math.max(12, map.getBoundsZoom(span, false)))
      : map.getZoom();
    // Land in the middle of what the person can SEE: the bottom overlay stack
    // (toolbar, strips, the live bar) covers the foot of the map.
    const offset = Math.max(0, Math.min(covered / 2, size.y / 2 - 44));
    const centre = map.unproject(
      map.project(L.latLng(lat, lon), zoom).add(L.point(0, Math.round(offset))),
      zoom,
    );
    moveCamera(() => map.setView(centre, zoom, { animate: false }));
    // Say where it went. A map that jumps without a word is disorienting, and
    // this is also where the person can see that nothing was marked.
    const name = placeShortName(label, 40);
    setFlewTo(name !== '' ? name : null);
  };

  // The pin-locate control. On follow surfaces it is also the ONE way back
  // into follow-mode: recentre on self now, resume following, then let the
  // parent refresh the fix.
  const handleLocate = () => {
    if (followAvailable) {
      setFollow(true);
      returnToSelf();
    }
    onLocate?.();
  };

  // The viewer's own fix. One tap, one fix, recentre — deliberately simpler
  // than the share screen's refining watch: this is orientation, not evidence,
  // and it draws a dot rather than moving anything that matters.
  const locateViewer = () => {
    if (map === null) return;
    // A live surface already draws this viewer — recentring on that is the
    // whole job, and cheaper and truer than a second one-shot fix. On follow
    // surfaces it is also the re-engage gesture: snap home, follow again.
    if (selfPosition !== null) {
      if (followAvailable) setFollow(true);
      returnToSelf();
      return;
    }
    if (!('geolocation' in navigator)) {
      setViewerNote('This device cannot provide a location.');
      return;
    }
    setViewerBusy(true);
    navigator.geolocation.getCurrentPosition(
      (fix) => {
        setViewerBusy(false);
        const at: [number, number] = [fix.coords.latitude, fix.coords.longitude];
        if (viewerMarkerRef.current === null) {
          viewerMarkerRef.current = L.marker(at, {
            icon: viewerIcon(viewerAvatar ?? undefined),
            interactive: false,
            keyboard: false,
          }).addTo(map);
          viewerCircleRef.current = L.circle(at, {
            radius: fix.coords.accuracy,
            color: VIEWER_COLOUR,
            fillColor: VIEWER_COLOUR,
            fillOpacity: 0.1,
            weight: 1,
          }).addTo(map);
        } else {
          viewerMarkerRef.current.setLatLng(at);
          viewerCircleRef.current?.setLatLng(at);
          viewerCircleRef.current?.setRadius(fix.coords.accuracy);
        }
        map.panTo(at);
      },
      () => {
        setViewerBusy(false);
        setViewerNote('Could not get your location. The pin is unaffected.');
      },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
  };

  // The top-right controls stack downward in a fixed order; each one's
  // offset depends only on which controls precede it.
  const isFull = fullscreen || fullscreenLocked;
  const expandSlot = onLocate !== undefined ? 2 : 1;
  const viewerSlot = (onLocate !== undefined ? 1 : 0) + (allowFullscreen ? 1 : 0) + 1;
  const slotClass = (slot: number) => (slot === 2 ? 'map-stack-2' : slot === 3 ? 'map-stack-3' : '');

  const shapeCount = sketch?.shapes.length ?? 0;

  const undoShape = () => {
    const current = sketchRef.current;
    if (current === null || current.shapes.length === 0) return;
    setSketchFull(false);
    const shapes = current.shapes.slice(0, -1);
    onSketchChange?.(shapes.length === 0 ? null : { ...current, shapes });
  };

  const clearSketch = () => {
    // The toolbar stays open and the tool stays in hand — clearing is
    // "start the drawing over", not "stop drawing".
    setSketchFull(false);
    onSketchChange?.(null);
  };

  const pickTool = (tool: DrawTool) => {
    // Tapping the active tool again puts it down — the map goes back to
    // panning without needing to find the pan button.
    setInkOpen(false);
    setActiveTool((current) => (current === tool ? 'none' : tool));
  };

  const toolButton = (tool: DrawTool, label: string, icon: JSX.Element, disabled = false) => (
    <button
      type="button"
      className={`map-tool ${activeTool === tool ? 'map-tool-active' : ''}`}
      aria-label={label}
      aria-pressed={activeTool === tool}
      title={label}
      disabled={disabled}
      onClick={() => pickTool(tool)}
    >
      {icon}
    </button>
  );

  // Tiles are the one thing on this screen that genuinely needs the network.
  // Without a word of explanation an empty grey rectangle reads as "broken",
  // which is not what a person in trouble should be looking at — the position
  // itself is unaffected and is written out in full directly below.
  return (
    <div className={`map-frame ${fullscreen ? 'map-frame-full' : ''} ${fullscreenLocked ? 'map-frame-locked' : ''}`}>
      {/* `map-tiles-dark` scopes the legibility filter to the tile pane of
          dark basemaps only — see styles.css for why Dark Matter needs it. */}
      <div ref={containerRef} className={`${className ?? 'map'}${tiles === 'dark' ? ' map-tiles-dark' : ''}`} />

      {/* Place search — top-LEFT, tucked under Leaflet's zoom buttons. The
          right-hand column is spoken for on every surface (the account
          control, then locate, then the viewer's own locate), the foot of the
          map belongs to the tools and the live bar, and the top centre
          carries the wordmark on the share screen. This is the one edge that
          is free everywhere, so the control sits in the same place on all of
          them. */}
      {searchAvailable && (
        <>
          <button
            type="button"
            className={`map-search-toggle ${searchOpen ? 'map-search-open' : ''}`}
            aria-label="Search for a place"
            aria-expanded={searchOpen}
            title="Search for a place"
            onClick={() => {
              setFlewTo(null);
              setSearchOpen((open) => !open);
            }}
          >
            <SearchIcon />
          </button>
          {searchOpen && (
            <div className="map-search-panel">
              <PlaceSearch
                onPick={flyToPlace}
                failText="Search did not respond — you can still pan and zoom the map yourself."
                emptyText="Nothing found for that. Try adding a town."
              />
            </div>
          )}
          {!searchOpen && flewTo !== null && <p className="map-search-note">Moved to {flewTo}</p>}
        </>
      )}

      {onLocate !== undefined && (
        <button
          type="button"
          className={`map-locate ${followAvailable && following ? 'map-locate-following' : ''}`}
          onClick={handleLocate}
          disabled={locating}
          aria-label="Move the pin to my current location"
          title={followAvailable && following ? 'Following your position' : 'Pin my current location'}
          {...(followAvailable ? { 'aria-pressed': following } : {})}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={locating ? 'locating' : ''}>
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="12" y1="1" x2="12" y2="4.5" stroke="currentColor" strokeWidth="1.6" />
            <line x1="12" y1="19.5" x2="12" y2="23" stroke="currentColor" strokeWidth="1.6" />
            <line x1="1" y1="12" x2="4.5" y2="12" stroke="currentColor" strokeWidth="1.6" />
            <line x1="19.5" y1="12" x2="23" y2="12" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      )}

      {allowFullscreen && !fullscreenLocked && !fullscreen && (
        <button
          type="button"
          className={`map-locate ${slotClass(expandSlot)}`}
          onClick={openFullscreen}
          aria-label="Make the map full screen"
          title="Full screen"
        >
          <ExpandIcon />
        </button>
      )}

      {fullscreen && (
        <button type="button" className="map-close-pill" onClick={closeFullscreen}>
          <CloseIcon /> Close map
        </button>
      )}

      {showViewerLocation && (
        <button
          type="button"
          className={`map-locate ${slotClass(viewerSlot)} ${followAvailable && following ? 'map-locate-following' : ''}`}
          onClick={locateViewer}
          disabled={viewerBusy}
          aria-label="Show where I am on the map"
          title={followAvailable && following ? 'Following your position' : 'Show where I am'}
          {...(followAvailable ? { 'aria-pressed': following } : {})}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className={viewerBusy ? 'locating' : ''}>
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="12" y1="1" x2="12" y2="4.5" stroke="currentColor" strokeWidth="1.6" />
            <line x1="12" y1="19.5" x2="12" y2="23" stroke="currentColor" strokeWidth="1.6" />
            <line x1="1" y1="12" x2="4.5" y2="12" stroke="currentColor" strokeWidth="1.6" />
            <line x1="19.5" y1="12" x2="23" y2="12" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      )}

      {viewerNote !== null && <p className="map-viewer-note">{viewerNote}</p>}

      <div className="map-bottom-stack">
      {/* The armed point tool gets no note of its own: arming it makes the
          parent mount the pre-placement marker strip (onMarkerToolChange),
          and that strip carries the hint and the place search. */}
      {sketchFull && (
        <p className="map-tools-note">
          The sketch is full. Undo or clear a shape to draw more.
        </p>
      )}

      {toolsOpen && onZoneDraw !== undefined && zonesFull && (
        <p className="map-tools-note">
          This session has all {MAX_SESSION_ZONES} zones. Remove one to draw another.
        </p>
      )}

      {toolsOpen && onPlaceMarker !== undefined && markersFull && (
        <p className="map-tools-note">
          You have placed all {MAX_SESSION_MARKERS} of your markers. Remove one to place another.
        </p>
      )}

      {onSketchChange !== undefined && (
        <div className="map-tools" role="toolbar" aria-label="Drawing tools">
          {!toolsOpen ? (
            <button
              type="button"
              className="map-tool"
              aria-label="Draw on the map"
              title="Draw on the map"
              onClick={() => {
                setToolsOpen(true);
                setActiveTool('pen');
              }}
            >
              <PenIcon />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="map-tool"
                aria-label="Stop drawing"
                title="Stop drawing"
                onClick={() => {
                  setToolsOpen(false);
                  setInkOpen(false);
                  setActiveTool('none');
                }}
              >
                <CloseIcon />
              </button>
              {toolButton('pen', 'Draw freehand', <PenIcon />)}
              {toolButton('arrow', 'Draw an arrow', <ArrowIcon />)}
              {toolButton(
                'circle',
                onZoneDraw !== undefined ? 'Draw a zone' : 'Draw a circle',
                <CircleIcon />,
                onZoneDraw !== undefined && zonesFull,
              )}
              {onPlaceMarker !== undefined && (
                <button
                  type="button"
                  className={`map-tool ${activeTool === 'marker' ? 'map-tool-active' : ''}`}
                  aria-label="Place a point"
                  aria-pressed={activeTool === 'marker'}
                  title="Place a point"
                  disabled={markersFull}
                  onClick={() => {
                    setInkOpen(false);
                    setActiveTool((current) => (current === 'marker' ? 'none' : 'marker'));
                  }}
                >
                  <PointIcon />
                </button>
              )}
              <span className="map-tools-rule" aria-hidden="true" />
              {/* One swatch; the palette pops UPWARD so the toolbar stays
                  one row and the map keeps the screen. */}
              <span className="map-ink-wrap">
                <button
                  type="button"
                  className="map-ink"
                  style={{ ['--ink' as string]: SKETCH_INKS[ink] }}
                  aria-label="Change ink colour"
                  aria-expanded={inkOpen}
                  onClick={() => setInkOpen((open) => !open)}
                />
                {inkOpen && (
                  <span className="map-ink-pop">
                    {SKETCH_INKS.map((hex, index) => (
                      <button
                        key={hex}
                        type="button"
                        className={`map-ink ${ink === index ? 'map-ink-active' : ''}`}
                        style={{ ['--ink' as string]: hex }}
                        aria-label={`Ink ${index + 1}`}
                        aria-pressed={ink === index}
                        onClick={() => {
                          setInk(index as SketchColour);
                          setInkOpen(false);
                        }}
                      />
                    ))}
                  </span>
                )}
              </span>
              <span className="map-tools-rule" aria-hidden="true" />
              <button
                type="button"
                className="map-tool"
                aria-label="Undo the last shape"
                title="Undo the last shape"
                disabled={shapeCount === 0}
                onClick={undoShape}
              >
                <UndoIcon />
              </button>
              <button
                type="button"
                className="map-tool"
                aria-label="Clear the drawing"
                title="Clear the drawing"
                disabled={shapeCount === 0}
                onClick={clearSketch}
              >
                <ClearIcon />
              </button>
            </>
          )}
        </div>
      )}

      {offline && (
        <p className="map-offline">
          Map pictures need a connection. Your position is still exact — it is written out below.
        </p>
      )}

      {isFull && fullscreenOverlay}
      </div>
    </div>
  );
}

// Toolbar glyphs. Geometric strokes in currentColor, sized like .map-locate's
// icon — no emoji, per the design system.
function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20l1.2-4.2L16.4 4.6a2 2 0 0 1 2.8 0l0.2 0.2a2 2 0 0 1 0 2.8L8.2 18.8Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="5" y1="19" x2="17" y2="7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M11 5.5h7.5V13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CircleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 6L3.5 9.5 7 13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 9.5h10a6 6 0 0 1 0 12h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A plain magnifier — geometric strokes in currentColor, like every other
    functional glyph on the map chrome. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <line
        x1="15.4"
        y1="15.4"
        x2="21"
        y2="21"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PointIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s-6.5-6.2-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 14.8 12 21 12 21Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="12" cy="10.4" r="2.2" fill="currentColor" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="10.5" y1="10.5" x2="10.5" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <line x1="13.5" y1="10.5" x2="13.5" y2="16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
