import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

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
  /** When set, the pin can be dragged and this fires with the new position. */
  onMove?: (lat: number, lon: number) => void;
  /** Previous positions of a live session, oldest first. */
  trail?: Array<[number, number]>;
  className?: string;
}

export function Map({
  lat,
  lon,
  accuracyM,
  thirdParty = false,
  onMove,
  trail,
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
    requestAnimationFrame(() => instance.invalidateSize());

    setMap(instance);

    return () => {
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
        onMoveRef.current?.(newLat, lng);
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
      onMoveRef.current?.(event.latlng.lat, event.latlng.lng);
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [map, onMove]);

  return <div ref={containerRef} className={className ?? 'map'} />;
}
