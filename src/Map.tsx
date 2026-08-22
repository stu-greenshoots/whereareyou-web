import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import L from 'leaflet';
import { MARKER_ICONS, MAX_SKETCH_CHARS, MAX_SKETCH_SHAPES, encodeSketch, sketchBounds } from '@whereareyou/protocol';
import type { MarkerIcon, Sketch, SketchColour } from '@whereareyou/protocol';
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
 * Only a small same-shape data URL may become an <img> in marker HTML.
 * Peer avatars arrive over the wire from OTHER people, and these strings are
 * interpolated into innerHTML — the base64 charset contains no quote or
 * bracket, so a string this regex passes cannot break out of the attribute.
 */
const SAFE_AVATAR = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function avatarImg(avatar: string | undefined): string | null {
  if (avatar === undefined || avatar.length > 20_000 || !SAFE_AVATAR.test(avatar)) return null;
  return `<img class="marker-avatar" src="${avatar}" alt="" />`;
}

// Leaflet's default marker icons are resolved relative to the CSS, which breaks
// under a bundler. Draw our own instead — also lets a third-party report look
// visually different from a self-report, which matters (see below).
// An avatar sits INSIDE the ring; the ring keeps its colour, because the
// colour is the information (blue = the caller) and the photo is only a face.
function pinIcon(colour: string, avatar?: string): L.DivIcon {
  const img = avatarImg(avatar);
  return L.divIcon({
    className: 'pin-icon',
    html: `<span class="pin ${img !== null ? 'pin-has-avatar' : ''}" style="--pin-colour:${colour}">${img ?? ''}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

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
}

const PEER_COLOUR = '#475569';

/**
 * Tile sources — CARTO's free basemaps (OSM data, calmer cartography than the
 * OSM standard style). `voyager` for the light public surfaces, `dark` for
 * the dispatcher console. `{r}` makes Leaflet fetch @2x tiles on retina
 * screens; CARTO requires the joint OSM+CARTO attribution below.
 */
const TILE_SOURCES = {
  voyager: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
} as const;

export type TileVariant = keyof typeof TILE_SOURCES;

/**
 * A PLACED point — a claim about the world ("the entrance is here"), never a
 * live fix. Diamond, not dot, so the two can't be confused at a glance.
 */
export interface PlacedMarker {
  id: string;
  label?: string | undefined;
  position: { lat: number; lon: number };
  /** What the spot IS; without one the diamond shows the placer's initial. */
  icon?: MarkerIcon | undefined;
  /** Tapping the diamond — how "tap your marker to change its icon" works. */
  onTap?: (() => void) | undefined;
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

function placedIcon(label: string | undefined, icon: MarkerIcon | undefined): L.DivIcon {
  let inner: string;
  if (icon !== undefined && MARKER_GLYPHS[icon] !== undefined) {
    inner = `<span class="placed-marker-glyph">${MARKER_GLYPHS[icon]}</span>`;
  } else {
    const first = (label ?? '').trim().charAt(0).toUpperCase();
    const initial = /^[A-Z0-9]$/.test(first) ? first : '•';
    inner = `<span>${initial}</span>`;
  }
  return L.divIcon({
    className: 'placed-marker-icon',
    html: `<span class="placed-marker">${inner}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function peerIcon(label: string | undefined, avatar?: string): L.DivIcon {
  const img = avatarImg(avatar);
  const first = (label ?? '').trim().charAt(0).toUpperCase();
  // One character, strictly alphanumeric — this goes into innerHTML.
  const initial = /^[A-Z0-9]$/.test(first) ? first : '•';
  return L.divIcon({
    className: 'peer-dot-icon',
    html: `<span class="peer-dot">${img ?? initial}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
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
  /**
   * Adds a place-a-point tool to the toolbar: tap the tool, tap the map, the
   * point lands there and the tool puts itself down. Fires with a placement
   * accuracy derived from the zoom, like a hand-placed pin.
   */
  onPlaceMarker?: (lat: number, lon: number, accuracyM: number) => void;
  /**
   * A plain tap (no tool active) places the marker too — the share screen's
   * "the spot I mean is here" gesture. Needs onPlaceMarker.
   */
  markerOnClick?: boolean;
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
   * The account photo of whoever this map's PIN is — shown inside the pin
   * ring. The ring keeps its meaning-colour; the photo only adds a face.
   * Never set for third-party reports: the pin is not the sharer there.
   */
  pinAvatar?: string | null;
  /** Same, for the viewer-location dot. */
  viewerAvatar?: string | null;
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
  onPlaceMarker,
  markerOnClick = false,
  moveOnClick = true,
  allowFullscreen = false,
  showViewerLocation = false,
  pinAvatar = null,
  viewerAvatar = null,
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
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerNote, setViewerNote] = useState<string | null>(null);
  const viewerMarkerRef = useRef<L.Marker | null>(null);
  const viewerCircleRef = useRef<L.Circle | null>(null);
  // Records, not Maps — the global Map is shadowed by this component's name.
  const peerLayersRef = useRef<Record<string, { marker: L.Marker; circle: L.Circle; face: string }>>({});
  const remoteSketchesRef = useRef<Record<string, SketchHandle>>({});
  const placedLayersRef = useRef<Record<string, L.Marker>>({});
  const placedTapsRef = useRef<Record<string, (() => void) | undefined>>({});
  const onPlaceMarkerRef = useRef(onPlaceMarker);
  onPlaceMarkerRef.current = onPlaceMarker;

  useEffect(() => {
    if (containerRef.current === null) return;

    const instance = L.map(containerRef.current, { zoomControl: true }).setView([lat, lon], initialZoom);
    L.tileLayer(TILE_SOURCES[tiles], {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(instance);

    // Leaflet measures the container on creation. If it was hidden or still
    // being laid out at that moment it computes a zero size and renders a grey
    // box, so re-measure once the browser has settled.
    // Cancelled on teardown: a map that is created and destroyed within the
    // same frame — StrictMode's double mount, or a phase change landing on top
    // of one — otherwise leaves this callback to run against a removed map and
    // throw out of the animation frame.
    const measure = requestAnimationFrame(() => instance.invalidateSize());

    setMap(instance);

    return () => {
      cancelAnimationFrame(measure);
      instance.remove();
      setMap(null);
      // Drop the layer handles too. They belong to the map just destroyed, and
      // leaving them set is precisely what breaks the remount.
      markerRef.current = null;
      circleRef.current = null;
      trailRef.current = null;
      sketchHandleRef.current = null;
      viewerMarkerRef.current = null;
      viewerCircleRef.current = null;
      peerLayersRef.current = {};
      remoteSketchesRef.current = {};
      placedLayersRef.current = {};
      fittedContentRef.current = false;
    };
    // Created once per mount; position changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        icon: pinIcon(colour, face),
        draggable: onMoveRef.current !== undefined,
      }).addTo(map);

      marker.on('dragend', (event) => {
        const { lat: newLat, lng } = (event.target as L.Marker).getLatLng();
        onMoveRef.current?.(newLat, lng, placementAccuracy(newLat, map.getZoom()));
      });

      markerRef.current = marker;
    } else {
      markerRef.current.setLatLng([lat, lon]);
      markerRef.current.setIcon(pinIcon(colour, face));
    }

    if (circleRef.current === null) {
      circleRef.current = L.circle([lat, lon], {
        radius: accuracyM,
        color: colour,
        fillColor: colour,
        fillOpacity: 0.12,
        weight: 1,
      }).addTo(map);
    } else {
      circleRef.current.setLatLng([lat, lon]);
      circleRef.current.setRadius(accuracyM);
      circleRef.current.setStyle({ color: colour, fillColor: colour });
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
    }
  }, [map, lat, lon, accuracyM, thirdParty, trail, hidePin, pinAvatar]);

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
      const at: [number, number] = [peer.position.lat, peer.position.lon];
      const existing = layers[peer.id];
      // Icons carry the label and avatar, so a change to either re-renders
      // the dot rather than leaving a stale face on a renamed peer.
      const face = `${peer.label ?? ''}|${peer.avatar ?? ''}`;
      if (existing === undefined) {
        layers[peer.id] = {
          face,
          marker: L.marker(at, { icon: peerIcon(peer.label, peer.avatar), interactive: false, keyboard: false }).addTo(map),
          circle: L.circle(at, {
            radius: peer.position.accuracyM,
            color: PEER_COLOUR,
            fillColor: PEER_COLOUR,
            fillOpacity: 0.08,
            weight: 1,
          }).addTo(map),
        };
      } else {
        existing.marker.setLatLng(at);
        if (existing.face !== face) {
          existing.marker.setIcon(peerIcon(peer.label, peer.avatar));
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

  // Sync the placed markers.
  useEffect(() => {
    if (map === null) return;
    const layers = placedLayersRef.current;
    const seen = new Set<string>();
    for (const placed of placedMarkers ?? []) {
      seen.add(placed.id);
      placedTapsRef.current[placed.id] = placed.onTap;
      const at: [number, number] = [placed.position.lat, placed.position.lon];
      const existing = layers[placed.id];
      if (existing === undefined) {
        const created = L.marker(at, {
          icon: placedIcon(placed.label, placed.icon),
          interactive: placed.onTap !== undefined,
          keyboard: false,
        }).addTo(map);
        if (placed.onTap !== undefined) {
          const id = placed.id;
          created.on('click', () => placedTapsRef.current[id]?.());
        }
        layers[placed.id] = created;
      } else {
        existing.setLatLng(at);
        existing.setIcon(placedIcon(placed.label, placed.icon));
      }
    }
    for (const id of Object.keys(layers)) {
      if (!seen.has(id)) {
        layers[id]!.remove();
        delete layers[id];
      }
    }
  }, [map, placedMarkers]);

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
    const measure = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(measure);
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

  // The "could not locate you" note clears itself.
  useEffect(() => {
    if (viewerNote === null) return;
    const timer = window.setTimeout(() => setViewerNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [viewerNote]);

  // The moment the wide-open start map gets its first real fix, jump to
  // street level — the view change IS the feedback that locating worked.
  useEffect(() => {
    // animate: false is load-bearing — event.latlng is unreliable while a
    // zoom animation runs, so a tap in that window would place a marker
    // somewhere absurd. A jump-cut has no such window.
    if (map !== null && !hidePin && !hadPinRef.current) map.setView([lat, lon], 17, { animate: false });
    hadPinRef.current = !hidePin;
  }, [map, hidePin, lat, lon]);

  // Keep the view on the pin when the position changes underneath us — a live
  // session that walks off the edge of the map is worse than useless.
  useEffect(() => {
    if (map === null || hidePin) return;
    const target = L.latLng(lat, lon);
    if (map.getBounds().contains(target)) return;
    // A nearby drift pans smoothly; a far jump (a searched place two counties
    // over) snaps, because animating across a country is nauseating.
    if (map.getCenter().distanceTo(target) > 5000) {
      map.setView(target, map.getZoom(), { animate: false });
    } else {
      map.panTo(target);
    }
  }, [map, lat, lon, hidePin]);

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

  // The viewer's own fix. One tap, one fix, recentre — deliberately simpler
  // than the share screen's refining watch: this is orientation, not evidence,
  // and it draws a dot rather than moving anything that matters.
  const locateViewer = () => {
    if (map === null) return;
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

  const toolButton = (tool: DrawTool, label: string, icon: JSX.Element) => (
    <button
      type="button"
      className={`map-tool ${activeTool === tool ? 'map-tool-active' : ''}`}
      aria-label={label}
      aria-pressed={activeTool === tool}
      title={label}
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
      <div ref={containerRef} className={className ?? 'map'} />
      {onLocate !== undefined && (
        <button
          type="button"
          className="map-locate"
          onClick={onLocate}
          disabled={locating}
          aria-label="Move the pin to my current location"
          title="Pin my current location"
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
          className={`map-locate ${slotClass(viewerSlot)}`}
          onClick={locateViewer}
          disabled={viewerBusy}
          aria-label="Show where I am on the map"
          title="Show where I am"
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
      {sketchFull && (
        <p className="map-tools-note">
          The sketch is full. Undo or clear a shape to draw more.
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
              {toolButton('circle', 'Draw a circle', <CircleIcon />)}
              {onPlaceMarker !== undefined && (
                <button
                  type="button"
                  className={`map-tool ${activeTool === 'marker' ? 'map-tool-active' : ''}`}
                  aria-label="Place a point"
                  aria-pressed={activeTool === 'marker'}
                  title="Place a point"
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
