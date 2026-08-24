import { useEffect, useMemo, useRef, useState } from 'react';
import type { MarkerIcon } from '@whereareyou/protocol';
import { MARKER_GLYPHS, isSafeAvatar } from './Map.jsx';

/**
 * The compass view: everyone and everything in the session, as bearings from
 * where I stand. A map answers "where are they?"; this answers "which way do
 * I walk?" — the question a person actually has once they put the phone up.
 *
 * The rose rotates against the device heading, so up on the screen is the
 * way the phone points. Every participant and placed marker sits at its
 * bearing, distance underneath; anything past the distance scale clamps to
 * the rim. Positions of others come from the room and are never sent
 * anywhere from here.
 *
 * Heading sources, in order of trust: webkitCompassHeading (iOS — true
 * heading) where present, else `deviceorientationabsolute` alpha (magnetic
 * north, not true — a few degrees off in the UK, fine for a POC). No events
 * at all (a desktop) renders the rose fixed north-up with a note.
 */

export type HeadingPermission = 'granted' | 'denied' | 'unneeded';

/**
 * iOS gates orientation events behind a permission that MUST be requested
 * inside a user gesture — call this straight from the tap that opens the
 * compass, never from an effect.
 */
export function requestHeadingPermission(): Promise<HeadingPermission> {
  if (typeof DeviceOrientationEvent === 'undefined') return Promise.resolve('unneeded');
  const ctor = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  if (typeof ctor.requestPermission !== 'function') return Promise.resolve('unneeded');
  return ctor
    .requestPermission()
    .then((outcome): HeadingPermission => (outcome === 'granted' ? 'granted' : 'denied'))
    .catch((): HeadingPermission => 'denied');
}

export type CompassTarget =
  | {
      kind: 'person';
      id: string;
      label: string;
      avatar: string | null;
      /** The sharer keeps their blue everywhere; everyone else is slate. */
      owner: boolean;
      /**
       * Their connection dropped — the bearing points at the last position
       * they sent. Muted the same way the map ghosts them, so the rose never
       * implies a live person at the other end of it.
       */
      disconnected: boolean;
      position: { lat: number; lon: number };
    }
  | {
      kind: 'marker';
      id: string;
      icon: MarkerIcon;
      name?: string;
      position: { lat: number; lon: number };
    };

// Spherical trig, locally: geodesy is in the deps but only its OSGB module
// carries an ambient declaration here (vendor.d.ts), and ten lines beat
// widening that surface.
const EARTH_RADIUS_M = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

type LatLon = { lat: number; lon: number };

export function distanceM(a: LatLon, b: LatLon): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const dPhi = toRadians(b.lat - a.lat);
  const dLambda = toRadians(b.lon - a.lon);
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing a → b, degrees clockwise from north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = toRadians(a.lat);
  const phi2 = toRadians(b.lat);
  const dLambda = toRadians(b.lon - a.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

/** Metres under a km, km over — read at arm's length while walking. */
function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km < 10 ? km.toFixed(1) : String(Math.round(km))} km`;
}

/** Low-pass factor: enough to kill sensor jitter without feeling laggy. */
const SMOOTHING = 0.25;
/** iOS compass accuracy (degrees of error) beyond which we suggest calibrating. */
const LOW_ACCURACY_DEG = 25;
/** Radial band targets occupy: fraction of the rose radius. */
const RING_INNER = 0.2;
const RING_SPAN = 0.58;
/** Distances at/beyond this always clamp to the rim. */
const SCALE_MAX_M = 10_000;
/** The whole scale when everything is close — stops two targets 30m apart
    being flung to opposite edges of the rose. */
const SCALE_MIN_M = 100;

/** Position on the rose (percent offsets) for a bearing and radius fraction. */
function roseXY(bearing: number, f: number): { left: string; top: string } {
  return {
    left: `${50 + f * 50 * Math.sin(toRadians(bearing))}%`,
    top: `${50 - f * 50 * Math.cos(toRadians(bearing))}%`,
  };
}

const CARDINALS: Array<[number, string]> = [
  [0, 'N'],
  [90, 'E'],
  [180, 'S'],
  [270, 'W'],
];

export function Compass({
  targets,
  initialSelf,
  headingPermission,
  onClose,
}: {
  targets: CompassTarget[];
  /** Seed for MY position; the overlay runs its own watch while open. */
  initialSelf: LatLon | null;
  headingPermission: HeadingPermission;
  onClose: () => void;
}) {
  const [self, setSelf] = useState<LatLon | null>(initialSelf);
  const [heading, setHeading] = useState<number | null>(null);
  const [lowAccuracy, setLowAccuracy] = useState(false);
  const smoothedRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  // Bearings are FROM ME, so my fix must stay fresh while I walk. The
  // overlay owns its own watch — a watcher (share: false) has no stream
  // running, and this is the one screen that needs one.
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const watch = navigator.geolocation.watchPosition(
      (fix) => setSelf({ lat: fix.coords.latitude, lon: fix.coords.longitude }),
      undefined,
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, []);

  useEffect(() => {
    if (headingPermission === 'denied') return;

    // Smooth on the shortest angular path, publish at most once a frame —
    // orientation events arrive far faster than the screen can usefully move.
    const push = (raw: number): void => {
      const previous = smoothedRef.current;
      let next = raw;
      if (previous !== null) {
        const delta = ((raw - previous + 540) % 360) - 180;
        next = (previous + delta * SMOOTHING + 360) % 360;
      }
      smoothedRef.current = next;
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          setHeading(smoothedRef.current);
        });
      }
    };

    // iOS: true heading plus an accuracy figure, on the plain event.
    const onOrientation = (event: DeviceOrientationEvent): void => {
      const webkit = event as DeviceOrientationEvent & {
        webkitCompassHeading?: number;
        webkitCompassAccuracy?: number;
      };
      if (typeof webkit.webkitCompassHeading === 'number' && Number.isFinite(webkit.webkitCompassHeading)) {
        push(webkit.webkitCompassHeading);
        if (typeof webkit.webkitCompassAccuracy === 'number') {
          setLowAccuracy(
            webkit.webkitCompassAccuracy < 0 || webkit.webkitCompassAccuracy > LOW_ACCURACY_DEG,
          );
        }
      }
    };
    // Everyone else: absolute alpha. Magnetic north, which is honest enough
    // for pointing a person down a street.
    const onAbsolute = (event: DeviceOrientationEvent): void => {
      if (event.alpha !== null) push((360 - event.alpha) % 360);
    };

    window.addEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientationabsolute', onAbsolute as EventListener);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('deviceorientationabsolute', onAbsolute as EventListener);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [headingPermission]);

  // Distance → radius: linear against the farthest live target (bounded), so
  // the rose always uses its space; anything past the bound sits on the rim.
  const resolved = useMemo(() => {
    if (self === null) return [];
    const measured = targets.map((target) => ({
      target,
      d: distanceM(self, target.position),
      b: bearingDeg(self, target.position),
    }));
    const farthest = measured.reduce((max, entry) => Math.max(max, entry.d), 0);
    const scale = Math.min(SCALE_MAX_M, Math.max(SCALE_MIN_M, farthest));
    return measured.map((entry) => ({
      ...entry,
      f: RING_INNER + RING_SPAN * Math.min(1, entry.d / scale),
    }));
  }, [self, targets]);

  const rotation = heading ?? 0;
  const hasHeading = heading !== null;

  return (
    <div className="compass-overlay" role="dialog" aria-label="Compass">
      <div className="compass-head">
        <span className="label">Compass</span>
        {hasHeading && <span className="compass-readout">{Math.round(rotation)}°</span>}
        <button type="button" className="button" onClick={onClose}>
          Back to map
        </button>
      </div>

      <div className="compass-stage">
        <div className="compass-rose" style={{ transform: `rotate(${-rotation}deg)` }}>
          {Array.from({ length: 12 }, (_, index) => index * 30).map((angle) => (
            <span
              key={angle}
              className={`compass-tick ${angle % 90 === 0 ? 'compass-tick-major' : ''}`}
              style={{ transform: `rotate(${angle}deg)` }}
            />
          ))}

          {CARDINALS.map(([angle, letter]) => (
            <span
              key={letter}
              className={`compass-cardinal ${letter === 'N' ? 'compass-cardinal-n' : ''}`}
              style={{
                ...roseXY(angle, 0.9),
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
            >
              {letter}
            </span>
          ))}

          {resolved.map(({ target, d, b, f }) => (
            <div
              key={`${target.kind}-${target.id}`}
              className="compass-target"
              style={{
                ...roseXY(b, f),
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
              }}
            >
              {target.kind === 'person' ? (
                <span
                  className={`compass-person ${target.owner ? 'compass-person-owner' : ''} ${
                    target.disconnected ? 'marker-gone' : ''
                  }`}
                >
                  {target.avatar !== null && isSafeAvatar(target.avatar) ? (
                    <img src={target.avatar} alt="" />
                  ) : (
                    (target.label.trim().charAt(0) || '•').toUpperCase()
                  )}
                </span>
              ) : (
                <span
                  className="compass-mark"
                  // Same inline-SVG glyph set the map diamonds use.
                  dangerouslySetInnerHTML={{ __html: MARKER_GLYPHS[target.icon] ?? MARKER_GLYPHS.spot }}
                />
              )}
              <span className="compass-target-name">
                {target.kind === 'person'
                  ? target.label
                  : ((target.name ?? '').trim() !== '' ? (target.name ?? '').trim() : target.icon)}
              </span>
              <span className="compass-target-dist">{formatDistance(d)}</span>
            </div>
          ))}

          <span className="compass-self-dot" aria-hidden="true" />
        </div>
      </div>

      <div className="compass-notes">
        {self === null && (
          <p className="compass-note">Waiting for your position — bearings start from you.</p>
        )}
        {self !== null && targets.length === 0 && (
          <p className="compass-note">
            No one else and nothing marked yet. People and spots appear here as bearings once
            they are in the session.
          </p>
        )}
        {headingPermission === 'denied' && (
          <p className="compass-note">
            Compass access was refused, so north is up. You can still read each bearing off the
            rose.
          </p>
        )}
        {headingPermission !== 'denied' && !hasHeading && (
          <p className="compass-note">
            This device reports no heading, so north is up — point your phone and turn yourself
            until the rose matches the world.
          </p>
        )}
        {hasHeading && lowAccuracy && (
          <p className="compass-note">
            The compass reads low accuracy — move your phone in a figure of eight to calibrate.
          </p>
        )}
      </div>
    </div>
  );
}
