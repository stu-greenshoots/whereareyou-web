import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MAX_SKETCH_CHARS, MAX_SKETCH_SHAPES, encodeSketch, sketchBounds } from '@whereareyou/protocol';
import type { Sketch, SketchColour } from '@whereareyou/protocol';
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

// Leaflet's default marker icons are resolved relative to the CSS, which breaks
// under a bundler. Draw our own instead — also lets a third-party report look
// visually different from a self-report, which matters (see below).
function pinIcon(colour: string): L.DivIcon {
  return L.divIcon({
    className: 'pin-icon',
    html: `<span class="pin" style="--pin-colour:${colour}"></span>`,
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

function viewerIcon(): L.DivIcon {
  return L.divIcon({
    className: 'viewer-dot-icon',
    html: '<span class="viewer-dot"></span>',
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
   * Fit the view to the sketch (plus the pin) once, when it first appears.
   * For read-only maps ONLY — refitting under someone's finger mid-stroke on
   * an editable map would be horrible, so editable maps never set this.
   */
  fitSketch?: boolean;
  /**
   * Adds an expand control (top-right, where the locate control would sit —
   * do not combine with onLocate) that takes the map full screen. For the
   * look-up side: its map is small, and the person who resolved a code is
   * often trying to move toward it.
   */
  allowFullscreen?: boolean;
  /**
   * Adds a control that finds the VIEWER's own position, marks it with a
   * neutral dot, and recentres on it — so whoever looked the code up can see
   * where they are relative to the caller. It NEVER moves the pin: the pin is
   * the caller, and this button must not be able to lie about that.
   */
  showViewerLocation?: boolean;
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
  onLocate,
  locating = false,
  sketch = null,
  onSketchChange,
  sketchAnchor,
  fitSketch = false,
  allowFullscreen = false,
  showViewerLocation = false,
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
  const fittedSketchRef = useRef(false);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  // Drawing state. The active tool lives in state (the toolbar renders from
  // it); everything the pointer handlers need is mirrored into refs so the
  // handlers never close over a stale sketch.
  const [activeTool, setActiveTool] = useState<DrawTool | 'none'>('none');
  const [ink, setInk] = useState<SketchColour>(0);
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
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerNote, setViewerNote] = useState<string | null>(null);
  const viewerMarkerRef = useRef<L.Marker | null>(null);
  const viewerCircleRef = useRef<L.Circle | null>(null);

  useEffect(() => {
    if (containerRef.current === null) return;

    const instance = L.map(containerRef.current, { zoomControl: true }).setView([lat, lon], 17);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
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
      fittedSketchRef.current = false;
    };
    // Created once per mount; position changes are handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync marker, accuracy circle and trail to the current position.
  useEffect(() => {
    if (map === null) return;

    // Amber for a reported (third-party) location, blue for the sharer's own.
    // A dispatcher confusing "where the caller is" with "where they say the
    // incident is" is the worst failure this UI can produce, so the two never
    // look alike.
    const colour = thirdParty ? '#d97706' : '#2563eb';

    if (markerRef.current === null) {
      const marker = L.marker([lat, lon], {
        icon: pinIcon(colour),
        draggable: onMoveRef.current !== undefined,
      }).addTo(map);

      marker.on('dragend', (event) => {
        const { lat: newLat, lng } = (event.target as L.Marker).getLatLng();
        onMoveRef.current?.(newLat, lng, placementAccuracy(newLat, map.getZoom()));
      });

      markerRef.current = marker;
    } else {
      markerRef.current.setLatLng([lat, lon]);
      markerRef.current.setIcon(pinIcon(colour));
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
  }, [map, lat, lon, accuracyM, thirdParty, trail]);

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

  // Fit the view to the sketch once, when it first arrives on a read-only
  // map. Once only, and never on editable maps — the existing auto-pan effect
  // below keeps working unchanged afterwards, and after a fit that includes
  // the pin the two cannot fight.
  useEffect(() => {
    if (map === null || !fitSketch || sketch === null || sketch.shapes.length === 0) return;
    if (fittedSketchRef.current) return;
    fittedSketchRef.current = true;
    const bounds = sketchBounds(sketch);
    if (bounds === null) return;
    map.fitBounds(L.latLngBounds(bounds).extend([lat, lon]), { padding: [32, 32], maxZoom: 18 });
  }, [map, fitSketch, sketch, lat, lon]);

  // Entering or leaving full screen resizes the container out from under
  // Leaflet, which measures once. Re-measure after the new layout applies.
  useEffect(() => {
    if (map === null) return;
    const measure = requestAnimationFrame(() => map.invalidateSize());
    return () => cancelAnimationFrame(measure);
  }, [map, fullscreen]);

  // Escape leaves full screen; the collapse button is the touch peer.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // The "could not locate you" note clears itself.
  useEffect(() => {
    if (viewerNote === null) return;
    const timer = window.setTimeout(() => setViewerNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [viewerNote]);

  // Keep the view on the pin when the position changes underneath us — a live
  // session that walks off the edge of the map is worse than useless.
  useEffect(() => {
    if (map === null) return;
    if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon]);
  }, [map, lat, lon]);

  // Allow map clicks to reposition the pin when the map is editable.
  useEffect(() => {
    if (map === null || onMove === undefined) return;

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
  }, [map, onMove]);

  // The drawing interaction: pointer events on the map container while a tool
  // is active. Panning and double-click zoom are handed back on cleanup.
  // Two-finger pinch keeps working BETWEEN strokes (Leaflet's touchZoom rides
  // touch events, which pointer capture does not intercept); a second pointer
  // arriving MID-stroke abandons the stroke, so a pinch never leaves ink.
  useEffect(() => {
    if (map === null || activeTool === 'none' || onSketchChange === undefined) return;

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
      stroke = beginStroke(activeTool, toPoint(event));
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
            icon: viewerIcon(),
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
    <div className={`map-frame ${fullscreen ? 'map-frame-full' : ''}`}>
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

      {allowFullscreen && (
        <button
          type="button"
          className="map-locate"
          onClick={() => setFullscreen((current) => !current)}
          aria-label={fullscreen ? 'Leave full screen' : 'Make the map full screen'}
          title={fullscreen ? 'Leave full screen' : 'Full screen'}
        >
          {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
        </button>
      )}

      {showViewerLocation && (
        <button
          type="button"
          className="map-locate map-viewer-locate"
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

      {onSketchChange !== undefined && (
        <div className={`map-tools ${offline ? 'map-tools-raised' : ''}`} role="toolbar" aria-label="Drawing tools">
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
                  setActiveTool('none');
                }}
              >
                <CloseIcon />
              </button>
              {toolButton('pen', 'Draw freehand', <PenIcon />)}
              {toolButton('arrow', 'Draw an arrow', <ArrowIcon />)}
              {toolButton('circle', 'Draw a circle', <CircleIcon />)}
              <span className="map-tools-rule" aria-hidden="true" />
              {SKETCH_INKS.map((hex, index) => (
                <button
                  key={hex}
                  type="button"
                  className={`map-ink ${ink === index ? 'map-ink-active' : ''}`}
                  style={{ ['--ink' as string]: hex }}
                  aria-label={`Ink ${index + 1}`}
                  aria-pressed={ink === index}
                  onClick={() => setInk(index as SketchColour)}
                />
              ))}
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

      {sketchFull && (
        <p className={`map-tools-note ${offline ? 'map-tools-raised' : ''}`}>
          The sketch is full. Undo or clear a shape to draw more.
        </p>
      )}

      {offline && (
        <p className="map-offline">
          Map pictures need a connection. Your position is still exact — it is written out below.
        </p>
      )}
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
