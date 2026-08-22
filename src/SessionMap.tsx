import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { decodeSketch, encodeSketch } from '@whereareyou/protocol';
import type { LiveParticipant, Position, Sketch } from '@whereareyou/protocol';
import { connectLive, type LiveHandle } from './live.js';
import { Map, type MapPeer, type PlacedMarker } from './Map.jsx';
import { inferSource, timeRemaining } from './formats.js';

/**
 * The live room, as a screen. One component for both roles: the OWNER's map
 * has their own blue pin and streams their movement; a JOINER's map keeps
 * the blue pin on the owner (blue is THE caller, always) and shows
 * themselves as a slate dot like everyone else. Everyone draws; every
 * drawing is everyone's to see.
 */

export interface SessionMapProps {
  code: string;
  /** Grouped form for the pill: X7K9-P2Q4. */
  displayCode: string;
  role: 'owner' | 'joiner';
  updateToken?: string;
  /** Whether THIS device streams its position (owners always do). */
  share: boolean;
  name?: string;
  initialPosition: { lat: number; lon: number; accuracyM: number };
  initialSketch?: Sketch | null;
  /** Fires on every committed change to OUR drawing, so the parent can keep
      it when this screen closes (and persist it across reloads). */
  onSketchShared?: (sketch: Sketch | null) => void;
  onLeave: () => void;
}

export function SessionMap({
  code,
  displayCode,
  role,
  updateToken,
  share,
  name,
  initialPosition,
  initialSketch = null,
  onSketchShared,
  onLeave,
}: SessionMapProps) {
  const [participants, setParticipants] = useState<Record<string, LiveParticipant>>({});
  const [selfId, setSelfId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<'expired' | 'refused' | 'failed' | null>(null);
  const [mySketch, setMySketch] = useState<Sketch | null>(initialSketch);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  /** The point I placed — a claim about the world, never where I am. */
  const [myMarker, setMyMarker] = useState<Position | null>(null);
  const [, forceTick] = useState(0);
  const handleRef = useRef<LiveHandle | null>(null);
  const selfIdRef = useRef<string | null>(null);

  // The room takes the whole screen, like the map-first share flow.
  useEffect(() => {
    document.body.classList.add('map-first');
    return () => document.body.classList.remove('map-first');
  }, []);

  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // One socket for the lifetime of the screen.
  useEffect(() => {
    const handle = connectLive({
      code,
      share,
      ...(name !== undefined && name !== '' ? { name } : {}),
      ...(updateToken !== undefined ? { updateToken } : {}),
      handlers: {
        onWelcome: (participantId, expires, roster) => {
          selfIdRef.current = participantId;
          setSelfId(participantId);
          setExpiresAt(expires);
          setParticipants(Object.fromEntries(roster.map((entry) => [entry.id, entry])));
        },
        onParticipant: (participant) => {
          if (participant.id === selfIdRef.current) return; // our own echo, if any
          setParticipants((current) => ({ ...current, [participant.id]: participant }));
        },
        onLeft: (participantId) => {
          setParticipants((current) => {
            const { [participantId]: _gone, ...rest } = current;
            return rest;
          });
        },
        onEnded: (reason) => setEnded(reason),
        onStatus: setConnected,
      },
    });
    handleRef.current = handle;
    // A restored drawing exists only in local state until it travels once.
    if (initialSketch !== null && initialSketch.shapes.length > 0) {
      try {
        handle.sendSketch(encodeSketch(initialSketch));
      } catch {
        // Stays local.
      }
    }
    return () => {
      handleRef.current = null;
      handle.close();
    };
    // The room identity never changes for a mounted screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stream our own movement while we said we would.
  useEffect(() => {
    if (!share || !('geolocation' in navigator)) return;
    const watch = navigator.geolocation.watchPosition(
      (fix) => {
        const position: Position = {
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracyM: fix.coords.accuracy,
          source: inferSource(fix.coords.accuracy),
          takenAt: new Date(fix.timestamp).toISOString(),
        };
        setMyPosition(position);
        handleRef.current?.sendPosition(position);
      },
      undefined,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [share]);

  const placeMarker = useCallback((lat: number, lon: number) => {
    const position: Position = {
      lat,
      lon,
      accuracyM: 10,
      source: 'manual',
      takenAt: new Date().toISOString(),
    };
    setMyMarker(position);
    handleRef.current?.sendMarker(position);
  }, []);

  // The room spreads by its link — same shape as the code screen's share.
  const shareRoom = useCallback(async () => {
    const text = `Join my live location session — code ${displayCode}. Open ${window.location.origin}${import.meta.env.BASE_URL}lookup?code=${code}`;
    if ('share' in navigator) {
      try {
        await navigator.share({ title: 'Live location session', text });
        return;
      } catch {
        // Sheet dismissed — fall through to the clipboard.
      }
    }
    await navigator.clipboard.writeText(text);
  }, [code, displayCode]);

  const changeSketch = useCallback((sketch: Sketch | null) => {
    setMySketch(sketch);
    onSketchShared?.(sketch);
    // An empty sketch is announced too — clearing must clear everywhere.
    try {
      handleRef.current?.sendSketch(sketch === null ? 'AQAA' : encodeSketch(sketch));
    } catch {
      // An unencodable sketch stays local; the room just doesn't hear it.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSketchShared]);

  const roster = Object.values(participants);
  const owner = roster.find((entry) => entry.owner);

  // The blue pin: me if I am the owner, the owner's latest fix if not.
  const pin =
    role === 'owner'
      ? (myPosition ?? initialPosition)
      : (owner?.position ?? initialPosition);

  const peers = useMemo(() => {
    const dots: MapPeer[] = [];
    for (const entry of roster) {
      if (entry.owner || entry.id === selfId || entry.position === undefined) continue;
      dots.push({ id: entry.id, label: entry.name, position: entry.position });
    }
    // A sharing joiner appears to themselves too — seeing your own dot is
    // how you know the room can see you.
    if (role === 'joiner' && share && myPosition !== null) {
      dots.push({ id: 'self', label: name ?? 'Me', position: myPosition });
    }
    return dots;
  }, [roster, selfId, role, share, myPosition, name]);

  const placedMarkers = useMemo(() => {
    const points: PlacedMarker[] = [];
    for (const entry of roster) {
      if (entry.id === selfId || entry.marker === undefined) continue;
      points.push({ id: entry.id, label: entry.name, position: entry.marker });
    }
    if (myMarker !== null) points.push({ id: 'self-marker', label: name ?? 'Me', position: myMarker });
    return points;
  }, [roster, selfId, myMarker, name]);

  const remoteSketches = useMemo(() => {
    const decoded: Array<{ id: string; sketch: Sketch }> = [];
    for (const entry of roster) {
      if (entry.id === selfId || entry.sketch === undefined) continue;
      const sketch = decodeSketch(entry.sketch);
      if (sketch !== null && sketch.shapes.length > 0) decoded.push({ id: entry.id, sketch });
    }
    return decoded;
  }, [roster, selfId]);

  const others = roster.filter((entry) => entry.id !== selfId).length;
  const remaining = expiresAt !== null ? timeRemaining(expiresAt) : null;

  return (
    <div className="share-stage">
      <Map
        lat={pin.lat}
        lon={pin.lon}
        accuracyM={pin.accuracyM}
        offline={false}
        sketch={mySketch}
        onSketchChange={changeSketch}
        peers={peers}
        remoteSketches={remoteSketches}
        placedMarkers={placedMarkers}
        onPlaceMarker={placeMarker}
        fullscreenLocked
        className="map map-fill"
        fullscreenOverlay={
          <div className="map-sheet map-sheet-code live-bar">
            <div className="live-bar-code">
              <p className="map-code-line">{displayCode}</p>
              <p className="live-bar-status">
                {ended !== null
                  ? ended === 'expired'
                    ? 'Session ended'
                    : 'Connection lost'
                  : !connected
                    ? 'Reconnecting…'
                    : `${others === 0 ? 'No one else here yet' : `${others} other${others === 1 ? '' : 's'} here`}${
                        remaining !== null && remaining !== 'expired' ? ` · ${remaining} left` : ''
                      }`}
              </p>
            </div>
            <div className="live-bar-actions">
              <button type="button" className="button button-primary" onClick={() => void shareRoom()}>
                Share
              </button>
              <button type="button" className="button" onClick={onLeave}>
                {role === 'owner' ? 'Back to code' : 'Leave'}
              </button>
            </div>
          </div>
        }
      />
    </div>
  );
}
