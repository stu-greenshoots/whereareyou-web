import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

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
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

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
      onMoveRef.current?.(event.latlng.lat, event.latlng.lng, placementAccuracy(event.latlng.lat, map.getZoom()));
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onMove]);

  // Tiles are the one thing on this screen that genuinely needs the network.
  // Without a word of explanation an empty grey rectangle reads as "broken",
  // which is not what a person in trouble should be looking at — the position
  // itself is unaffected and is written out in full directly below.
  return (
    <div className="map-frame">
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
      {offline && (
        <p className="map-offline">
          Map pictures need a connection. Your position is still exact — it is written out below.
        </p>
      )}
    </div>
  );
}
