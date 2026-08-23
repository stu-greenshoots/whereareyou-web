import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { MAX_MARKER_NAME_CHARS, decodeSketch, encodeOffline, encodeSketch, formatCode, formatOfflineCode, phoneticFor, toPhonetic } from '@whereareyou/protocol';
import type { CreateSessionResponse, MarkerIcon, Position, SessionMarker, SessionMode, Sketch } from '@whereareyou/protocol';
import { extendSession, mintSession, revokeSession, upgradeToLive } from './api.js';
import { useAccount } from './AccountContext.jsx';
import { ProfileMenu } from './ProfileMenu.jsx';
import { SaveMapButton } from './SaveMap.jsx';
import { useSharedConnectivity } from './connectivity.js';
import { Map, MarkerIconPicker } from './Map.jsx';
import { Brand } from './Brand.jsx';
import { SessionMap, panelFromFragment, type LivePanel } from './SessionMap.jsx';
import { loadActiveShare, persistActiveShare, type ActiveShare } from './local-session.js';
import { connectLive, newLiveId } from './live.js';
import { NotifyControl } from './Notify.jsx';
import { CopyRow } from './CopyRow.jsx';
import { allFormats, describeSource, inferSource, timeRemaining } from './formats.js';

/** Why we ended up handing out a permanent code instead of a session. */
type OfflineCause =
  /** The browser says the link is down. */
  | 'no-link'
  /** We tried and nothing on the network answered. */
  | 'no-network'
  /** Something answered, and refused. */
  | 'service';

type Phase =
  | { name: 'idle' }
  | { name: 'locating' }
  | { name: 'located'; position: Position }
  /**
   * `spokenOfflineCode` is carried through minting and into the shared phase:
   * once a caller has read a code down the phone it exists in the world, and
   * every later screen has to keep telling the truth about it.
   */
  | { name: 'minting'; position: Position; spokenOfflineCode: string | null }
  | {
      name: 'shared';
      position: Position;
      session: CreateSessionResponse;
      spokenOfflineCode: string | null;
    }
  | {
      name: 'offline-shared';
      position: Position;
      code: string;
      cause: OfflineCause;
      detail: string | null;
    }
  | { name: 'error'; message: string; recoverable: boolean };

/** Somewhere recognisable to fall back to when there is no usable fix. */
const DEMO_POSITION: Position = {
  lat: 51.50809,
  lon: -0.12789,
  accuracyM: 12,
  source: 'manual',
  takenAt: new Date().toISOString(),
};

/** Where the start map opens when this device has never shared anything. */
const UK_CENTRE = { lat: 54.3, lon: -3.4 };

/** A satellite-grade fix. Stop refining once we reach it. */
const ACCURACY_GOOD_M = 20;
/** Below this quality, prompt the sender to try for a better fix. */
const ACCURACY_POOR_M = 50;
/** How long to keep refining a fix before settling for the best so far. */
const ACQUIRE_MAX_MS = 20_000;

/** The durations on offer. The server clamps to 60s–4h regardless. */
const TTL_CHOICES: Array<[number, string]> = [
  [1800, '30 min'],
  [3600, '1 hour'],
  [7200, '2 hours'],
  [14_400, '4 hours'],
];

/**
 * Extensions on offer, in minutes. All within the api's per-call schema cap
 * (EXTEND_MAX_MINUTES, 180); the server additionally clamps cumulative
 * lifetime to 24h from mint, and we render whatever expiry it returns.
 */
const EXTEND_CHOICES: Array<[number, string]> = [
  [30, '+30 min'],
  [60, '+1 hour'],
  [180, '+3 hours'],
];

/**
 * Past shares, kept ON THIS DEVICE ONLY so a spot can be shared again without
 * hunting for it — never sent anywhere, capped short, and clearable from the
 * same screen it appears on. Re-sharing goes through the normal located
 * screen: the caller sees the pin and presses the button themselves, so a
 * stale spot cannot be sent by accident.
 */
interface PastShare {
  lat: number;
  lon: number;
  accuracyM: number;
  /** Local-only label for the history list. Never sent anywhere — the NOTE
      is what the dispatcher sees; this is for the caller's own phone. */
  name: string;
  note: string;
  /** Encoded sketch payload, restored onto the map when reused. */
  sketch: string | null;
  marker: Position | null;
  markerIcon?: MarkerIcon;
  thirdParty: boolean;
  at: number;
}

/* The ActiveShare record and its load/persist moved to local-session.ts:
   the look-up screen's self-rejoin guard needs to ask "is this code mine?"
   without importing this whole screen. */

/** The marker list of a stored share, however old the entry. */
function activeShareMarkers(entry: ActiveShare): SessionMarker[] {
  if (Array.isArray(entry.markers)) return entry.markers;
  return entry.marker !== null && entry.marker !== undefined
    ? [{ id: newLiveId(), position: entry.marker, icon: entry.markerIcon ?? 'spot' }]
    : [];
}

const HISTORY_KEY = 'shareHistory';
const HISTORY_MAX = 8;

function loadHistory(): PastShare[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as PastShare[];
    return Array.isArray(parsed)
      ? parsed.filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
      : [];
  } catch {
    return [];
  }
}

function persistHistory(entries: PastShare[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or blocked — the history is a convenience, not a record.
  }
}

/** Roughly the same spot under the same name: replace, don't pile up. */
function samePlace(a: PastShare, b: PastShare): boolean {
  const east = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  const north = (a.lat - b.lat) * 111_320;
  return Math.hypot(east, north) < 50 && a.name === b.name;
}

function geolocationErrorMessage(error: GeolocationPositionError): {
  message: string;
  recoverable: boolean;
} {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return {
        message:
          'Location permission was refused. You can still place a pin on the map manually.',
        recoverable: true,
      };
    case error.POSITION_UNAVAILABLE:
      return {
        message: 'No position fix available. Move somewhere with a clearer view of the sky, or place a pin manually.',
        recoverable: true,
      };
    case error.TIMEOUT:
      return { message: 'Timed out waiting for a fix. Try again, or place a pin manually.', recoverable: true };
    default:
      return { message: 'Could not get a location.', recoverable: true };
  }
}

export function Share() {
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const [thirdParty, setThirdParty] = useState(false);
  const [mode, setMode] = useState<SessionMode>('static');
  const [note, setNote] = useState('');
  /** The caller's drawing. Anchored at the pin when the first shape lands. */
  const [sketch, setSketch] = useState<Sketch | null>(null);
  /** The spots the caller MARKED — "it's here" — never where they are.
      Pre-mint the flow places at most one; a live room can grow it to the
      protocol cap, and this list is what rides the mint and the resume. */
  const [markers, setMarkers] = useState<SessionMarker[]>([]);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  /** Requested lifetime of the code. The server clamps it regardless. */
  const [ttl, setTtl] = useState(1800);
  /** Local-only label for the history list — see PastShare.name. */
  const [shareName, setShareName] = useState('');
  /** The owner's live map is open over the code screen. */
  const [liveOpen, setLiveOpen] = useState(false);
  /** Markers placed IN the live map survive leaving it and reloading. */
  const adoptLiveMarkers = useCallback((next: SessionMarker[]) => {
    setMarkers(next);
    setResumable((current) => {
      if (current === null) return current;
      // The legacy mirror rides along so an older build can still restore.
      const updated: ActiveShare = {
        ...current,
        markers: next,
        marker: next[0]?.position ?? null,
        markerIcon: next[0]?.icon ?? 'spot',
      };
      persistActiveShare(updated);
      return updated;
    });
  }, []);

  /** Drawings made IN the live map survive leaving it and reloading. */
  const adoptLiveSketch = useCallback((next: Sketch | null) => {
    setSketch(next);
    setResumable((current) => {
      if (current === null) return current;
      let encoded: string | null = null;
      if (next !== null && next.shapes.length > 0) {
        try {
          encoded = encodeSketch(next);
        } catch {
          encoded = null;
        }
      }
      const updated = { ...current, sketch: encoded };
      persistActiveShare(updated);
      return updated;
    });
  }, []);
  const [liveError, setLiveError] = useState<string | null>(null);
  /** Which sheet panel is open. Hoisted here so browser Back can close it. */
  const [sheetPanel, setSheetPanel] = useState<'none' | 'options' | 'fallback'>('none');
  const sheetPanelRef = useRef(sheetPanel);
  sheetPanelRef.current = sheetPanel;
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  /** Where the flow is, coarsely — drives what Back means right now. */
  const phaseGroupRef = useRef<'start' | 'placed' | 'done'>('start');
  const [history, setHistory] = useState<PastShare[]>(loadHistory);
  const [resumable, setResumable] = useState<ActiveShare | null>(loadActiveShare);
  const { account, openMapRequest, consumeOpenMapRequest, requestOpenMap } = useAccount();
  const [, forceTick] = useState(0);
  const watchRef = useRef<number | null>(null);
  const { online, linkUp, reportReachable, reportUnreachable } = useSharedConnectivity();

  /** Set when the caller has declined the offer of an expiring code. */
  const [keepingOfflineCode, setKeepingOfflineCode] = useState(false);
  /** Quiet explanation shown after the look-up screen bounced our own code
      back here (the self-rejoin guard) — cleared on any fresh start. */
  const [ownCodeNote, setOwnCodeNote] = useState<string | null>(null);
  /** Panel a push deep link asked the live map to open, consumed once. */
  const [pendingPanel, setPendingPanel] = useState<LivePanel | null>(null);
  /** An extend request is in flight. */
  const [extendBusy, setExtendBusy] = useState(false);
  /** Outcome worth telling the owner about (the 24h cap, a failure). */
  const [extendNote, setExtendNote] = useState<string | null>(null);
  /** Set when "stop sharing" could not reach the server. */
  const [stopFailure, setStopFailure] = useState<string | null>(null);
  /** A fix is being acquired/refined (initial locate, or the map's locate button). */
  const [acquiring, setAcquiring] = useState(false);
  /** The located map's Leaflet instance, so a search pick in the
      report-elsewhere flow can fly the view to the marker it just placed —
      with the person-pin hidden there, nothing else moves the camera. */
  const locatedMapRef = useRef<LeafletMap | null>(null);
  const acquireWatchRef = useRef<number | null>(null);
  const acquireTimerRef = useRef<number | null>(null);
  const bestAccuracyRef = useRef<number>(Infinity);

  // Everything before a code exists is map-first: the map IS the screen and
  // the controls float over it. Once a code exists the code is the product
  // and the page becomes the issued document again.
  // Two related flags, deliberately separate — conflating them once sent
  // "Make this a live session" back to the start screen: preMint picks the
  // RENDER branch (start/located screens); mapFirst only drives the body
  // class, and must stay on while the owner's live map is up so this toggle
  // doesn't strip the class out from under SessionMap (parent effects run
  // after child effects).
  const preMint = phase.name !== 'shared' && phase.name !== 'offline-shared';
  const mapFirst = preMint || liveOpen;

  useEffect(() => {
    document.body.classList.toggle('map-first', mapFirst);
    return () => document.body.classList.remove('map-first');
  }, [mapFirst]);

  /**
   * Open/close a sheet panel THROUGH the history stack, so the browser Back
   * button means what a phone user expects: opening a panel pushes an entry,
   * Back (or tapping the icon again) pops it and the pop closes the panel.
   */
  const openSheetPanel = useCallback((which: 'options' | 'fallback', force = false) => {
    // Side effects stay OUT of the setState updater — React may run updaters
    // more than once (StrictMode does), and a doubled history.back() pops the
    // panel entry AND the located entry, dumping the user on the start screen.
    const current = sheetPanelRef.current;
    if (current === which) {
      if (!force) window.history.back(); // the popstate handler closes it
      return;
    }
    if (current === 'none') window.history.pushState({ shareUi: 'panel' }, '');
    setSheetPanel(which);
  }, []);

  // No connection: the fallback formats ARE the product — force them open.
  useEffect(() => {
    if (!online && (phase.name === 'located' || phase.name === 'minting')) {
      openSheetPanel('fallback', true);
    }
  }, [online, phase.name, openSheetPanel]);

  // Reaching the located screen from the start screen is also a history
  // entry, so Back from the map returns to the start screen rather than
  // leaving the app.
  useEffect(() => {
    const group =
      phase.name === 'located' || phase.name === 'minting'
        ? 'placed'
        : phase.name === 'shared' || phase.name === 'offline-shared'
          ? 'done'
          : 'start';
    if (group === 'placed' && phaseGroupRef.current === 'start') {
      window.history.pushState({ shareUi: 'located' }, '');
    }
    phaseGroupRef.current = group;
  }, [phase.name]);

  useEffect(() => {
    const onPop = () => {
      // Closest thing open closes first; otherwise a pop on the located
      // screen steps back to the start. Anywhere else, Back is just Back.
      if (sheetPanelRef.current !== 'none') {
        setSheetPanel('none');
        return;
      }
      if (phaseGroupRef.current === 'placed') {
        stopAcquire();
        setPhase({ name: 'idle' });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the expiry countdown.
  useEffect(() => {
    if (phase.name !== 'shared') return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [phase.name]);

  // When a code appears, jump back to the top — the button that minted it may
  // be well down the page, and the code itself is the thing to read now.
  useEffect(() => {
    if (phase.name === 'shared' || phase.name === 'offline-shared') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [phase.name]);

  // A redirect from the look-up screen: the code entered there is OUR OWN
  // running share (the self-rejoin guard), so resume the owner screen
  // directly instead of joining our own room as a stranger. A push deep
  // link's fragment names a live panel — open the live map straight onto it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const resume = params.get('resume');
    if (resume === null) return;
    const panel = panelFromFragment(window.location.hash);
    // Consumed either way — a reload must not replay a spent request.
    window.history.replaceState({}, '', import.meta.env.BASE_URL);
    const entry = loadActiveShare();
    if (entry === null || entry.code !== resume || timeRemaining(entry.expiresAt) === 'expired') {
      return; // Not ours any more — the ordinary start screen is the truth.
    }
    setMode(entry.mode);
    setThirdParty(entry.thirdParty ?? false);
    setSketch(entry.sketch !== null ? decodeSketch(entry.sketch) : null);
    setMarkers(activeShareMarkers(entry));
    setOwnCodeNote(
      'That code is yours, so you are back on its owner screen — you never need to join your own session.',
    );
    setPhase({
      name: 'shared',
      position: entry.position,
      session: {
        code: entry.code,
        display: formatCode(entry.code),
        phonetic: toPhonetic(entry.code),
        expiresAt: entry.expiresAt,
        updateToken: entry.updateToken,
      },
      spokenOfflineCode: null,
    });
    if (panel !== null && entry.mode === 'live') {
      setPendingPanel(panel);
      setLiveOpen(true);
    }
    // Once, on mount — the URL that carried the request is rewritten above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recordShare = useCallback(
    (position: Position) => {
      const entry: PastShare = {
        lat: position.lat,
        lon: position.lon,
        accuracyM: position.accuracyM,
        name: shareName.trim(),
        note: note.trim(),
        sketch: sketch !== null && sketch.shapes.length > 0 ? encodeSketch(sketch) : null,
        marker: markers[0]?.position ?? null,
        ...(markers[0] !== undefined ? { markerIcon: markers[0].icon } : {}),
        thirdParty,
        at: Date.now(),
      };
      setHistory((previous) => {
        const next = [entry, ...previous.filter((e) => !samePlace(e, entry))].slice(0, HISTORY_MAX);
        persistHistory(next);
        return next;
      });
    },
    [note, sketch, markers, thirdParty, shareName],
  );

  const clearHistory = useCallback(() => {
    setHistory([]);
    persistHistory([]);
  }, []);

  const stopAcquire = useCallback(() => {
    if (acquireWatchRef.current !== null) navigator.geolocation.clearWatch(acquireWatchRef.current);
    if (acquireTimerRef.current !== null) window.clearTimeout(acquireTimerRef.current);
    acquireWatchRef.current = null;
    acquireTimerRef.current = null;
    setAcquiring(false);
  }, []);

  /**
   * Acquire a position and keep refining it until it is good enough.
   *
   * getCurrentPosition returns a single, usually coarse, first fix — the cell or
   * WiFi guess the device has before the GNSS chip has locked. watchPosition
   * streams updates as it settles, so we take each improvement and stop once the
   * fix is satellite-grade (or a timeout hits). That is the difference between
   * "±45m and stuck" and "watch it tighten to ±8m".
   *
   * `initial` distinguishes the first locate (idle → map) from the map's
   * locate-again button, which refines in place without leaving the view.
   */
  const startAcquire = useCallback(
    (initial: boolean) => {
      if (!('geolocation' in navigator)) {
        if (initial) {
          setPhase({
            name: 'error',
            message: 'This browser cannot provide a location. Place a pin manually instead.',
            recoverable: true,
          });
        }
        return;
      }
      stopAcquire();
      if (initial) setPhase({ name: 'locating' });
      setAcquiring(true);
      setThirdParty(false);
      bestAccuracyRef.current = Infinity;

      acquireWatchRef.current = navigator.geolocation.watchPosition(
        (fix) => {
          // Only accept an improvement, so a momentary worse reading never bumps
          // the pin back outward.
          if (fix.coords.accuracy > bestAccuracyRef.current) return;
          bestAccuracyRef.current = fix.coords.accuracy;
          setPhase({
            name: 'located',
            position: {
              lat: fix.coords.latitude,
              lon: fix.coords.longitude,
              accuracyM: fix.coords.accuracy,
              source: inferSource(fix.coords.accuracy),
              takenAt: new Date(fix.timestamp).toISOString(),
            },
          });
          if (fix.coords.accuracy <= ACCURACY_GOOD_M) stopAcquire();
        },
        (error) => {
          stopAcquire();
          // Only surface an error if we never got a usable fix at all.
          if (initial && bestAccuracyRef.current === Infinity) {
            setPhase({ name: 'error', ...geolocationErrorMessage(error) });
          }
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: ACQUIRE_MAX_MS },
      );
      acquireTimerRef.current = window.setTimeout(stopAcquire, ACQUIRE_MAX_MS);
    },
    [stopAcquire],
  );

  const locate = useCallback(() => startAcquire(true), [startAcquire]);
  const relocate = useCallback(() => startAcquire(false), [startAcquire]);

  // Stop refining if the component goes away mid-acquire.
  useEffect(() => stopAcquire, [stopAcquire]);

  const useManualPin = useCallback(() => {
    stopAcquire();
    setThirdParty(true);
    setPhase({ name: 'located', position: { ...DEMO_POSITION, takenAt: new Date().toISOString() } });
  }, [stopAcquire]);

  /** Reuse a past share: back onto the located screen with everything set. */
  const reuseShare = useCallback(
    (entry: PastShare) => {
      stopAcquire();
      setThirdParty(entry.thirdParty);
      setShareName(entry.name ?? '');
      setNote(entry.note);
      setSketch(entry.sketch !== null ? decodeSketch(entry.sketch) : null);
      setMarkers(
        entry.marker !== null && entry.marker !== undefined
          ? [{ id: newLiveId(), position: entry.marker, icon: entry.markerIcon ?? 'spot' }]
          : [],
      );
      setPhase({
        name: 'located',
        position: {
          lat: entry.lat,
          lon: entry.lon,
          accuracyM: entry.accuracyM,
          source: 'manual',
          takenAt: new Date().toISOString(),
        },
      });
    },
    [stopAcquire],
  );

  // A saved map opened from the profile drawer: same move as reusing a past
  // share — back onto the located screen with everything restored, and the
  // caller presses the button themselves. Nothing is ever re-shared silently.
  useEffect(() => {
    if (openMapRequest === null) return;
    const saved = openMapRequest;
    consumeOpenMapRequest();
    stopAcquire();
    // The drawer is reachable from the live map now — leaving for a saved
    // map must also put the live view down, or the stale flag would fling
    // the next minted code straight onto the map.
    setLiveOpen(false);
    setThirdParty(saved.thirdParty);
    setShareName(saved.name);
    setNote(saved.note);
    setSketch(saved.sketch !== null ? decodeSketch(saved.sketch) : null);
    setMarkers(
      saved.marker !== null && saved.marker !== undefined
        ? [{ id: newLiveId(), position: saved.marker, icon: saved.markerIcon ?? 'spot' }]
        : [],
    );
    setPhase({
      name: 'located',
      position: {
        lat: saved.lat,
        lon: saved.lon,
        accuracyM: saved.accuracyM,
        source: 'manual',
        takenAt: new Date().toISOString(),
      },
    });
  }, [openMapRequest, consumeOpenMapRequest, stopAcquire]);

  /**
   * Hand the caller a permanent, self-contained code.
   *
   * No network is involved: the position is inside the code. This is the whole
   * point of the offline codec, and it is why losing signal degrades the
   * product rather than breaking it.
   */
  const fallToOfflineCode = useCallback(
    (position: Position, cause: OfflineCause, detail: string | null, existingCode?: string) => {
      setKeepingOfflineCode(false);
      recordShare(position);
      setPhase({
        name: 'offline-shared',
        position,
        code: existingCode ?? encodeOffline(position.lat, position.lon),
        cause,
        detail,
      });
    },
    [recordShare],
  );

  const mint = useCallback(
    async (rawPosition: Position, spokenOfflineCode: string | null) => {
      // A marker-share ("share a different location") points its code AT the
      // marked spot: the session position IS the marker's coordinates, so an
      // old console and the Location panel tell the same story the named
      // diamond does. The flow keeps the two in step already; this is the
      // invariant, enforced at the door.
      const position =
        thirdParty && markers[0] !== undefined ? markers[0].position : rawPosition;

      setPhase({ name: 'minting', position, spokenOfflineCode });

      // A live share moves the pin to wherever the caller really is. A pin
      // that was placed BY HAND is a claim about somewhere else, so it must
      // survive as its own marked spot — without this, the first live fix
      // replaces the one place the caller chose to share. Since live v2 that
      // promoted pin is simply markers[0]. (A marker-share never lands here:
      // it cannot mint without a marker.)
      let mintMarkers = markers;
      if (mode === 'live' && markers.length === 0 && position.source === 'manual') {
        mintMarkers = [{ id: newLiveId(), position, icon: 'spot' }];
        setMarkers(mintMarkers);
      }

      // The drawing rides the mint, but must never cost it: if encoding
      // fails for any reason the session is minted without the sketch.
      let sketchPayload: string | undefined;
      if (sketch !== null && sketch.shapes.length > 0) {
        try {
          sketchPayload = encodeSketch(sketch);
        } catch {
          sketchPayload = undefined;
        }
      }

      // `markers` is authoritative; the legacy single-marker mirror rides
      // beside it so a v1 server (which ignores unknown fields) still gets
      // the marked spot. A v2 server ignores the mirror, per the contract.
      // Subject tells the console what `position` IS. Static marker-share:
      // the reported spot — 'third-party'. But a LIVE mint starts streaming
      // the sharer's own fix within seconds, so 'third-party' would mislabel
      // it; the marker carries the reported place either way.
      const result = await mintSession({
        position,
        mode,
        subject: thirdParty && mode !== 'live' ? 'third-party' : 'self',
        ttlSeconds: ttl,
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
        ...(sketchPayload !== undefined ? { sketch: sketchPayload } : {}),
        ...(mintMarkers.length > 0
          ? { markers: mintMarkers, marker: mintMarkers[0]!.position, markerIcon: mintMarkers[0]!.icon }
          : {}),
      });

      if (!result.ok) {
        // A thrown fetch or a 5xx means the route is the problem; a 4xx means
        // we got through and were refused, which says nothing about the link.
        if (result.status === 0 || result.status >= 500) reportUnreachable();
        else reportReachable();

        // Never a dead end. We cannot mint a session, but we can always give
        // the caller something they can read down a phone right now.
        fallToOfflineCode(
          position,
          result.status === 0 ? 'no-network' : 'service',
          result.message,
          spokenOfflineCode ?? undefined,
        );
        return;
      }

      reportReachable();
      recordShare(position);
      const active: ActiveShare = {
        code: result.data.code,
        updateToken: result.data.updateToken,
        expiresAt: result.data.expiresAt,
        mode,
        position,
        sketch: sketchPayload ?? null,
        marker: mintMarkers[0]?.position ?? null,
        markerIcon: mintMarkers[0]?.icon ?? 'spot',
        markers: mintMarkers,
        thirdParty,
      };
      setResumable(active);
      persistActiveShare(active);
      setPhase({ name: 'shared', position, session: result.data, spokenOfflineCode });
    },
    [mode, thirdParty, note, sketch, markers, ttl, fallToOfflineCode, recordShare, reportReachable, reportUnreachable],
  );

  /**
   * The session's expiry moved — an extend response, or the room's `expiry`
   * fanout. The screen and the stored resume entry must both learn, or a
   * reload would resurrect the old countdown.
   */
  const adoptExpiry = useCallback((expiresAt: string) => {
    setPhase((current) =>
      current.name === 'shared'
        ? { ...current, session: { ...current.session, expiresAt } }
        : current,
    );
    setResumable((current) => {
      if (current === null) return current;
      const updated = { ...current, expiresAt };
      persistActiveShare(updated);
      return updated;
    });
  }, []);

  const extend = useCallback(
    async (addMinutes: number) => {
      if (phase.name !== 'shared') return;
      setExtendBusy(true);
      setExtendNote(null);
      const result = await extendSession(phase.session.code, phase.session.updateToken, addMinutes);
      setExtendBusy(false);
      if (!result.ok) {
        if (result.status === 0) reportUnreachable();
        setExtendNote(`Could not extend the code. ${result.message}`);
        return;
      }
      reportReachable();
      // At the 24h cumulative cap the server returns the expiry unchanged —
      // the response is the truth, so render it and say so quietly.
      if (result.data.expiresAt === phase.session.expiresAt) {
        setExtendNote('This code has reached its 24-hour limit and cannot run longer.');
      }
      adoptExpiry(result.data.expiresAt);
    },
    [phase, adoptExpiry, reportReachable, reportUnreachable],
  );

  const share = useCallback(() => {
    if (phase.name !== 'located') return;
    // A marker-share without a marker has nothing to point a code at — the
    // button is disabled in that state, and this is the backstop.
    if (thirdParty && markers.length === 0) return;
    stopAcquire();

    // In the report-elsewhere flow the marked spot IS the location the code
    // hands over — including the offline code, which encodes it directly.
    const target = thirdParty && markers[0] !== undefined ? markers[0].position : phase.position;

    // When the browser says the link is down it is telling the truth, and a
    // request that cannot succeed is not worth a frightened person's seconds.
    if (!linkUp) {
      fallToOfflineCode(target, 'no-link', null);
      return;
    }
    void mint(target, null);
  }, [phase, thirdParty, markers, linkUp, mint, fallToOfflineCode, stopAcquire]);

  // Live mode with the code screen up: the owner holds a HEADLESS room
  // connection — in the room, streaming, roster ignored — so anyone who has
  // joined sees the live pin without the owner needing the map open. The
  // socket also persists the owner's position to the store, so a plain
  // resolve stays truthful too (this replaced the old PATCH loop). Opening
  // the live map closes this connection and opens its own; viewers see the
  // owner blink out and back in — a known, harmless POC seam.
  useEffect(() => {
    if (phase.name !== 'shared' || phase.session === undefined || mode !== 'live') return;
    if (liveOpen) return;
    if (!('geolocation' in navigator)) return;

    // Same identity the live map presents (account name first, share name as
    // fallback, the account photo) — otherwise the owner's pin drops its face
    // and name on everyone's map whenever they sit on the code screen.
    const trimmedName = account.name !== '' ? account.name : shareName.trim();
    const handle = connectLive({
      code: phase.session.code,
      updateToken: phase.session.updateToken,
      share: true,
      ...(trimmedName !== '' ? { name: trimmedName } : {}),
      ...(account.avatar !== null ? { avatar: account.avatar } : {}),
      handlers: {
        onWelcome: () => {},
        onParticipant: () => {},
        onLeft: () => {},
        onEnded: () => {},
        onStatus: () => {},
        // An extend confirms over REST, but the room's fanout also lands
        // here — either way the countdown moves.
        onExpiry: adoptExpiry,
      },
    });
    // Joiners only see what travels the wire — after a reload the drawing
    // exists only in restored local state, so announce it once.
    const current = sketchRef.current;
    if (current !== null && current.shapes.length > 0) {
      try {
        handle.sendSketch(encodeSketch(current));
      } catch {
        // An unencodable sketch stays local.
      }
    }
    if (markersRef.current.length > 0) handle.sendMarkers(markersRef.current);
    watchRef.current = navigator.geolocation.watchPosition(
      (fix) => {
        handle.sendPosition({
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracyM: fix.coords.accuracy,
          source: inferSource(fix.coords.accuracy),
          takenAt: new Date(fix.timestamp).toISOString(),
        });
      },
      undefined,
      // Throttle by distance rather than time so a stationary phone stops
      // transmitting instead of burning battery repeating itself.
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );

    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      handle.close();
    };
    // shareName is read once at connect on purpose — renaming mid-session
    // must not blip the owner out of their own room.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mode, liveOpen]);

  const startAgain = useCallback(() => {
    setStopFailure(null);
    setKeepingOfflineCode(false);
    setExtendNote(null);
    setOwnCodeNote(null);
    setPendingPanel(null);
    setSketch(null);
    setMarkers([]);
    setIconPickerOpen(false);
    setLiveOpen(false);
    setLiveError(null);
    setPhase({ name: 'idle' });
  }, []);

  const revoke = useCallback(async () => {
    if (phase.name !== 'shared') return;

    const result = await revokeSession(phase.session.code, phase.session.updateToken);
    if (result.ok) {
      setResumable(null);
      persistActiveShare(null);
    }
    if (!result.ok) {
      if (result.status === 0) reportUnreachable();
      // Silently returning to the start screen here would tell the caller their
      // location had stopped being shared when it had not. Being wrong about
      // that is the worst thing this screen can do.
      setStopFailure(result.message);
      return;
    }
    startAgain();
  }, [phase, reportUnreachable, startAgain]);

  const nativeShare = useCallback(async () => {
    let text: string;
    if (phase.name === 'shared') {
      const { display, phonetic } = phase.session;
      // The link carries the code, so for anyone who can tap it the lookup
      // is one click — the spoken form stays in the text for everyone else.
      text = `My location code is ${display} — spoken: ${phonetic}. See it at ${location.origin}${import.meta.env.BASE_URL}lookup?code=${phase.session.code}`;
    } else if (phase.name === 'offline-shared') {
      // Spelled out as an offline code, because it behaves differently from a
      // session code at the other end and the recipient needs to know that.
      text = `My offline location code is ${formatOfflineCode(phase.code)} — spoken: ${[...phase.code]
        .map((char) => phoneticFor(char))
        .join(' ')}. It does not expire. See it at ${location.origin}${import.meta.env.BASE_URL}lookup?code=${phase.code}`;
    } else {
      return;
    }

    if ('share' in navigator) {
      try {
        await navigator.share({ title: 'My location code', text });
        return;
      } catch {
        // User dismissed the sheet, or the platform refused. Fall through.
      }
    }
    await navigator.clipboard.writeText(text);
  }, [phase]);

  // ---- Render -----------------------------------------------------------

  if (liveOpen && phase.name === 'shared') {
    const { session } = phase;
    return (
      /* share-stage-account: the profile float below claims top-right, and
         that class is what shifts the map's own locate control down a slot
         so the two never overlap. */
      <div className="share-stage share-stage-account">
        <SessionMap
          code={session.code}
          displayCode={formatCode(session.code)}
          role="owner"
          updateToken={session.updateToken}
          share
          {...(account.name !== ''
            ? { name: account.name }
            : shareName.trim() !== ''
              ? { name: shareName.trim() }
              : {})}
          {...(account.avatar !== null ? { avatar: account.avatar } : {})}
          {...(pendingPanel !== null ? { initialPanel: pendingPanel } : {})}
          initialPosition={phase.position}
          initialSketch={sketch}
          initialMarkers={markers}
          onSketchShared={adoptLiveSketch}
          onMarkersShared={adoptLiveMarkers}
          onLeave={() => {
            setLiveOpen(false);
            // The deep link is spent — reopening the map by hand must not
            // keep flinging the same panel open.
            setPendingPanel(null);
          }}
        />
        {/* The same floating account control the other map-first screens get.
            Top-right is free on the live map — zoom keeps to the top-left,
            the live bar and drawing tools to the bottom. */}
        <div className="profile-float">
          <ProfileMenu onOpenSavedMap={requestOpenMap} />
        </div>
      </div>
    );
  }

  if (preMint) {
    const located = phase.name === 'located' || phase.name === 'minting';
    const centre = located
      ? phase.position
      : history.length > 0
        ? { lat: history[0]!.lat, lon: history[0]!.lon }
        : UK_CENTRE;

    return (
      <div className="share-stage share-stage-account">
        <div className="map-brand" aria-hidden="true">
          <Brand />
        </div>
        {/* The header is gone in map-first mode, so the account gets its own
            floating control — top-right, above the map's stacked controls. */}
        <div className="profile-float">
          <ProfileMenu onOpenSavedMap={requestOpenMap} />
        </div>
        <Map
          lat={centre.lat}
          lon={centre.lon}
          accuracyM={located ? phase.position.accuracyM : 0}
          /* Reporting somewhere else places a NAMED MARKER, never a
             person-style pin — there is no person to point at yet, and a pin
             that looks like one would be a claim nobody made. */
          hidePin={!located || thirdParty}
          initialZoom={located ? 17 : history.length > 0 ? 13 : 5}
          thirdParty={thirdParty}
          pinAvatar={thirdParty ? null : account.avatar}
          offline={!online}
          locating={acquiring}
          sketch={located ? sketch : null}
          fullscreenLocked
          className="map map-fill"
          moveOnClick={false}
          onMapReady={(instance) => {
            locatedMapRef.current = instance;
          }}
          {...(located && markers.length > 0
            ? {
                placedMarkers: markers.map((m) => ({
                  id: m.id,
                  label: shareName.trim() !== '' ? shareName.trim() : 'Spot',
                  name: m.name,
                  position: m.position,
                  icon: m.icon,
                  onTap: () => setIconPickerOpen(true),
                })),
              }
            : {})}
          {...(located
            ? {
                onLocate: relocate,
                onSketchChange: setSketch,
                markerOnClick: true,
                onPlaceMarker: (lat: number, lon: number, accuracyM: number) => {
                  // A tap is "the spot I mean is HERE" — the pin is a person
                  // and taps never move people. Pre-mint the flow keeps ONE
                  // spot (a moved tap replaces it, keeping its id); a live
                  // room is where the list grows.
                  const spot: Position = {
                    lat,
                    lon,
                    accuracyM,
                    source: 'manual',
                    takenAt: new Date().toISOString(),
                  };
                  setMarkers((current) => [
                    {
                      id: current[0]?.id ?? newLiveId(),
                      position: spot,
                      icon: current[0]?.icon ?? 'spot',
                      ...(current[0]?.name !== undefined ? { name: current[0].name } : {}),
                    },
                  ]);
                  // In the report-elsewhere flow the code points AT the
                  // marker, so the session position follows it everywhere.
                  if (thirdParty) setPhase({ name: 'located', position: spot });
                  // Placing IS the moment to say what the spot is — the
                  // icon-and-name step opens right away, one step, optional.
                  setIconPickerOpen(true);
                },
                // A hand-placed pin is a deliberate choice, not a sensor
                // guess — its accuracy comes from the zoom, which the Map
                // computes. Stop any GNSS refinement so it can't drag the
                // pin back off the spot the caller just chose. No pin exists
                // in the report-elsewhere flow, so no drag to accept there.
                ...(!thirdParty
                  ? {
                      onMove: (lat: number, lon: number, accuracyM: number) => {
                        stopAcquire();
                        setPhase({
                          name: 'located',
                          position: {
                            ...phase.position,
                            lat,
                            lon,
                            accuracyM,
                            source: 'manual',
                            takenAt: new Date().toISOString(),
                          },
                        });
                      },
                    }
                  : {}),
              }
            : {})}
          fullscreenOverlay={
            located ? (
              <LocatedSheet
                position={phase.position}
                marker={markers[0]?.position ?? null}
                markerIcon={markers[0]?.icon ?? 'spot'}
                markerName={markers[0]?.name ?? ''}
                iconPickerOpen={iconPickerOpen}
                onPickIcon={(icon) => {
                  // Picking no longer closes the panel — the name field sits
                  // beside the icons and Done commits the pair together.
                  setMarkers((current) =>
                    current.length > 0 ? [{ ...current[0]!, icon }, ...current.slice(1)] : current,
                  );
                }}
                onNameMarker={(value) => {
                  setMarkers((current) => {
                    if (current.length === 0) return current;
                    const { name: _dropped, ...rest } = current[0]!;
                    const sliced = value.slice(0, MAX_MARKER_NAME_CHARS);
                    return [sliced === '' ? rest : { ...rest, name: sliced }, ...current.slice(1)];
                  });
                }}
                onCloseIconPicker={() => {
                  // Normalise the name on the way out, like the live room.
                  setMarkers((current) => {
                    if (current.length === 0) return current;
                    const { name: _dropped, ...rest } = current[0]!;
                    const trimmed = (current[0]!.name ?? '').trim();
                    return [trimmed === '' ? rest : { ...rest, name: trimmed }, ...current.slice(1)];
                  });
                  setIconPickerOpen(false);
                }}
                onRemoveMarker={() => {
                  setMarkers([]);
                  setIconPickerOpen(false);
                }}
                minting={phase.name === 'minting'}
                acquiring={acquiring}
                online={online}
                sketch={sketch}
                thirdParty={thirdParty}
                onSearchPick={(lat, lon, accuracyM, label) => {
                  stopAcquire();
                  // A picked place is a handy default name for the history.
                  const placeName = label.split(',')[0]?.trim() ?? '';
                  if (shareName.trim() === '') setShareName(placeName);
                  const spot: Position = {
                    lat,
                    lon,
                    accuracyM,
                    source: 'manual',
                    takenAt: new Date().toISOString(),
                  };
                  // Searching IS marking: the result lands as the named
                  // diamond (the place's name as the default, still
                  // editable), the what-is-this-spot sheet opens, and the
                  // view flies there — the hidden person-pin no longer
                  // drives the camera. Search renders only in the
                  // report-elsewhere flow, so this is that flow.
                  setMarkers((current) => [
                    {
                      id: current[0]?.id ?? newLiveId(),
                      position: spot,
                      icon: current[0]?.icon ?? 'spot',
                      ...((current[0]?.name ?? placeName) !== ''
                        ? { name: current[0]?.name ?? placeName }
                        : {}),
                    },
                  ]);
                  setIconPickerOpen(true);
                  locatedMapRef.current?.setView([lat, lon], 17, { animate: false });
                  setPhase({ name: 'located', position: spot });
                }}
                note={note}
                setNote={setNote}
                name={shareName}
                setName={setShareName}
                mode={mode}
                setMode={setMode}
                ttl={ttl}
                setTtl={setTtl}
                panel={sheetPanel}
                onTogglePanel={openSheetPanel}
                onRelocate={relocate}
                onShare={share}
              />
            ) : (
              <div className="map-sheet map-sheet-start">
                {!online && <NoSignalNotice linkUp={linkUp} />}

                {phase.name === 'error' && (
                  <div className="notice notice-warn">
                    <p>{phase.message}</p>
                    {phase.recoverable && (
                      <button className="link-button" onClick={useManualPin}>
                        Place a pin on the map instead
                      </button>
                    )}
                  </div>
                )}

                {phase.name === 'idle' &&
                  resumable !== null &&
                  timeRemaining(resumable.expiresAt) !== 'expired' && (
                    <button
                      className="button button-primary resume-chip"
                      onClick={() => {
                        setMode(resumable.mode);
                        setThirdParty(resumable.thirdParty ?? false);
                        setSketch(resumable.sketch !== null ? decodeSketch(resumable.sketch) : null);
                        setMarkers(activeShareMarkers(resumable));
                        setPhase({
                          name: 'shared',
                          position: resumable.position,
                          session: {
                            code: resumable.code,
                            display: formatCode(resumable.code),
                            phonetic: toPhonetic(resumable.code),
                            expiresAt: resumable.expiresAt,
                            updateToken: resumable.updateToken,
                          },
                          spokenOfflineCode: null,
                        });
                      }}
                    >
                      Back to your code {formatCode(resumable.code)} —{' '}
                      {timeRemaining(resumable.expiresAt)} left
                    </button>
                  )}

                <button className="big-button" onClick={locate} disabled={phase.name === 'locating'}>
                  {phase.name === 'locating' ? 'Getting your location…' : 'Share my location'}
                </button>

                {phase.name === 'idle' && (
                  <div className="start-links">
                    <button className="link-button start-alt" onClick={useManualPin}>
                      Report a different location instead
                    </button>
                    {/* The header is gone in map-first mode; this is the way
                        to the console. A plain link — the full reload it
                        causes is free at the start screen. */}
                    <a className="link-button start-alt" href={`${import.meta.env.BASE_URL}lookup`}>
                      Look up a code
                    </a>
                  </div>
                )}

                {phase.name === 'idle' && history.length > 0 && (
                  <details className="panel panel-concertina start-history">
                    <summary className="panel-title">Share a previous spot again</summary>
                    <div className="history-list">
                      {history.map((entry) => (
                        <button key={entry.at} className="history-row" onClick={() => reuseShare(entry)}>
                          <strong>
                            {(entry.name ?? '') !== ''
                              ? entry.name
                              : entry.note !== ''
                                ? entry.note
                                : `${entry.lat.toFixed(4)}, ${entry.lon.toFixed(4)}`}
                          </strong>
                          <span>
                            {new Date(entry.at).toLocaleString([], {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                            {entry.sketch !== null ? ' · has a drawing' : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                    {/* This list lives on this phone only. Still, a borrowed
                        phone shouldn't advertise where its owner has been. */}
                    <button className="link-button" onClick={clearHistory}>
                      Clear this list
                    </button>
                  </details>
                )}
              </div>
            )
          }
        />
      </div>
    );
  }

  const position = phase.position;
  const formats = allFormats(position.lat, position.lon);

  if (phase.name === 'offline-shared') {
    return (
      <OfflineShared
        phase={phase}
        formats={formats}
        sketch={sketch}
        thirdParty={thirdParty}
        pinAvatar={thirdParty ? null : account.avatar}
        liveWanted={mode === 'live'}
        online={online}
        keeping={keepingOfflineCode}
        onKeep={() => setKeepingOfflineCode(true)}
        onUpgrade={() => void mint(phase.position, phase.code)}
        onShare={() => void nativeShare()}
        onStartAgain={startAgain}
        saveSlot={
          <SaveMapButton
            suggestedName={shareName.trim() !== '' ? shareName.trim() : note.trim()}
            data={() => ({
              lat: phase.position.lat,
              lon: phase.position.lon,
              accuracyM: phase.position.accuracyM,
              note: note.trim(),
              sketch: sketch !== null && sketch.shapes.length > 0 ? encodeSketch(sketch) : null,
              marker: markers[0]?.position ?? null,
              ...(markers[0] !== undefined ? { markerIcon: markers[0].icon } : {}),
              thirdParty,
              source: 'share',
              code: phase.code,
            })}
          />
        }
      />
    );
  }

  // phase.name === 'shared'
  const { session } = phase;
  const remaining = timeRemaining(session.expiresAt);
  const expired = remaining === 'expired';
  /** The map preview doubles as the door to the live map — only while the
      code is alive and there is a connection to hold a room open. */
  const canOpenLive = !expired && online;

  /**
   * One tap on the preview opens the live map, upgrading a static session on
   * the way (one-way — the room needs a live session behind it). Same move
   * the old standalone button made; the label on the preview says which of
   * the two the tap will do.
   */
  const openLiveMap = () => {
    void (async () => {
      setLiveError(null);
      if (mode !== 'live') {
        // Going live starts streaming the sharer's OWN position, so a
        // third-party marker-share flips its stored subject to 'self' on the
        // same request — the marker keeps carrying the reported spot, and
        // the console's REPORTED banner stops mislabelling the caller's own
        // moving fix. The server accepts the flip only with this upgrade.
        const result = await upgradeToLive(
          session.code,
          session.updateToken,
          thirdParty ? { subject: 'self' } : {},
        );
        if (!result.ok) {
          setLiveError(result.message);
          return;
        }
        setMode('live');
        if (resumable !== null && resumable.code === session.code) {
          const upgraded = { ...resumable, mode: 'live' as const };
          setResumable(upgraded);
          persistActiveShare(upgraded);
        }
        // Same promotion as a live mint: the pin is about to start
        // following the caller, so a hand-placed spot becomes
        // markers[0] before the first fix can replace it.
        if (markers.length === 0 && phase.position.source === 'manual') {
          adoptLiveMarkers([{ id: newLiveId(), position: phase.position, icon: 'spot' }]);
        }
      }
      setLiveOpen(true);
    })();
  };

  return (
    <div className="stack">
      <div className={`code-doc ${expired ? 'code-expired' : ''}`}>
        <div className="code-doc-head">
          <span className="label">Location code</span>
          <span className="code-expiry">{expired ? 'Expired' : remaining}</span>
        </div>

        <div className="code-doc-body">
          <p className="code">{formatCode(session.code)}</p>

          <div className="read-aloud">
            <PhoneticGrid code={session.code} />
          </div>
        </div>
      </div>

      {/* The self-rejoin guard sent them here from the look-up screen —
          say why quietly, once. */}
      {ownCodeNote !== null && <div className="notice">{ownCodeNote}</div>}

      {/* The caller already read this one aloud. It is out in the world and
          permanent, and quietly replacing it with the code above would leave
          them believing something untrue about their own privacy. */}
      {phase.spokenOfflineCode !== null && (
        <div className="notice notice-offline">
          <strong>You already read out {formatOfflineCode(phase.spokenOfflineCode)}.</strong>
          <span>
            That one still works, and it still never expires — stopping the code above does not
            take it back. Tell the operator to use the new code if you can.
          </span>
        </div>
      )}

      {/* The session lives on the server, so the code keeps resolving even
          though this phone has gone quiet. Saying so is the difference between
          a calm screen and a caller reading out a code they think is dead. */}
      {!online && !expired && (
        <div className="notice notice-warn">
          <strong>You've lost your connection.</strong>
          <span>
            The code above still works — it was handed to the server before the signal went.
            {mode === 'live' && ' Your position has stopped updating, though.'} If the operator
            cannot find it, read out the offline code below instead: that one needs no network at
            either end.
          </span>
        </div>
      )}

      {/* A marker-share's code points at the SPOT, not at the sharer — the
          screen says so in the marker's own name, so reading the code down
          the phone and watching the operator go somewhere else can't
          surprise anyone. */}
      {thirdParty && !expired && (
        <div className="notice notice-thirdparty">
          <strong>
            This code marks{' '}
            {(markers[0]?.name ?? '').trim() !== ''
              ? <>“{markers[0]!.name!.trim()}”</>
              : 'the spot on the map'}{' '}
            — not where you are.
          </strong>
          <span>
            {mode === 'live'
              ? 'The marked spot stays where you put it. Your own position is now shared live alongside it.'
              : 'The operator sees the named marker at that spot. Your own position is not shared.'}
          </span>
        </div>
      )}

      {mode === 'live' && !expired && online && (
        <div className="notice notice-live">
          <span className="live-dot" /> Your position is being shared live
        </div>
      )}

      {/* The preview IS the door to the live map: the whole thing is one tap,
          with a labelled corner affordance so it never reads as mystery meat.
          Offline or expired it falls back to the plain expandable preview —
          a door to a room that cannot open is worse than no door. */}
      {canOpenLive ? (
        <div className="map-preview">
          <Map
            lat={position.lat}
            lon={position.lon}
            accuracyM={position.accuracyM}
            thirdParty={thirdParty}
            /* A marker-share preview shows the named diamond, never a
               person-style pin — the position IS the marker, and two symbols
               on one spot would invite exactly the confusion the model
               removes. */
            hidePin={thirdParty}
            pinAvatar={thirdParty ? null : account.avatar}
            offline={!online}
            sketch={sketch}
            fitContent
            {...(markers.length > 0
              ? {
                  placedMarkers: markers.map((m) => ({
                    id: m.id,
                    label: 'Spot',
                    name: m.name,
                    position: m.position,
                    icon: m.icon,
                  })),
                }
              : {})}
          />
          <button
            type="button"
            className="map-preview-open"
            onClick={openLiveMap}
            aria-label={
              mode === 'live'
                ? 'Open the live map'
                : 'Make this a live session and open the live map'
            }
          >
            <span className="map-preview-cta">
              <ExpandIcon />
              {mode === 'live' ? 'Open live map' : 'Make this live'}
            </span>
          </button>
        </div>
      ) : (
        <Map
          lat={position.lat}
          lon={position.lon}
          accuracyM={position.accuracyM}
          thirdParty={thirdParty}
          hidePin={thirdParty}
          pinAvatar={thirdParty ? null : account.avatar}
          offline={!online}
          sketch={sketch}
          fitContent
          allowFullscreen
          {...(markers.length > 0
            ? {
                placedMarkers: markers.map((m) => ({
                  id: m.id,
                  label: 'Spot',
                  name: m.name,
                  position: m.position,
                  icon: m.icon,
                })),
              }
            : {})}
          fullscreenOverlay={
            <div className="map-sheet map-sheet-code">
              <p className="map-code-line">{formatCode(session.code)}</p>
              <button className="button button-primary" onClick={nativeShare}>
                Share code
              </button>
            </div>
          }
        />
      )}

      {liveError !== null && (
        <div className="notice notice-warn">
          <p>Could not make this live: {liveError}</p>
        </div>
      )}

      {/* One quiet cluster for the code's housekeeping — countdown, extend,
          notify — so nothing in it competes with the code or the map.
          Extending is the owner's call and needs the resolver; the server
          clamps cumulative lifetime at 24h and the countdowns render
          whatever expiry it actually granted. */}
      {!expired && online && (
        <div className="code-utility">
          <div className="utility-extend" role="group" aria-label="Keep the code running longer">
            <span className="utility-remaining">{remaining} left</span>
            <div className="seg-row">
              {EXTEND_CHOICES.map(([minutes, label]) => (
                <button
                  key={minutes}
                  type="button"
                  className="seg"
                  disabled={extendBusy}
                  onClick={() => void extend(minutes)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {extendNote !== null && <p className="extend-note">{extendNote}</p>}
          {/* Quiet, tap-only: no permission prompt until asked, and nothing
              at all on platforms that cannot deliver a push. */}
          <NotifyControl code={session.code} variant="document" />
        </div>
      )}

      {/* Offline, the online-only controls (extend, notifications, the live
          map) are withheld rather than offered-and-failing; this one quiet
          line stands in for all of them. */}
      {!expired && !online && (
        <p className="offline-gate">
          Extending the code, notifications and the live map need a connection. They come back
          when you do.
        </p>
      )}

      <div className="row">
        <button className="button button-primary" onClick={nativeShare}>
          Share code
        </button>
        <button
          className="button button-danger"
          onClick={expired ? startAgain : () => void revoke()}
        >
          {expired ? 'Start again' : 'Stop sharing'}
        </button>
      </div>

      {stopFailure !== null && (
        <div className="notice notice-warn">
          <strong>Could not stop the sharing.</strong>
          <span>
            {stopFailure} The code above is still live and will stop on its own in {remaining}.
          </span>
          <div className="notice-actions">
            <button className="button" onClick={() => void revoke()}>
              Try again
            </button>
            <button className="link-button" onClick={startAgain}>
              Leave it running and start over
            </button>
          </div>
        </div>
      )}

      <SaveMapButton
        suggestedName={shareName.trim() !== '' ? shareName.trim() : note.trim()}
        data={() => ({
          lat: position.lat,
          lon: position.lon,
          accuracyM: position.accuracyM,
          note: note.trim(),
          sketch: sketch !== null && sketch.shapes.length > 0 ? encodeSketch(sketch) : null,
          marker: markers[0]?.position ?? null,
          ...(markers[0] !== undefined ? { markerIcon: markers[0].icon } : {}),
          thirdParty,
          source: 'share',
          code: session.code,
        })}
      />

      <CoordinatePanel formats={formats} position={position} online={online} />
    </div>
  );
}

/**
 * The floating controls over the located map: how good the fix is, the one
 * button that matters, and everything else folded away until asked for.
 */
function LocatedSheet({
  position,
  marker,
  markerIcon,
  markerName,
  iconPickerOpen,
  onPickIcon,
  onNameMarker,
  onCloseIconPicker,
  onRemoveMarker,
  minting,
  acquiring,
  online,
  sketch,
  thirdParty,
  onSearchPick,
  note,
  setNote,
  name,
  setName,
  mode,
  setMode,
  ttl,
  setTtl,
  panel,
  onTogglePanel,
  onRelocate,
  onShare,
}: {
  position: Position;
  marker: Position | null;
  markerIcon: MarkerIcon;
  markerName: string;
  iconPickerOpen: boolean;
  onPickIcon: (icon: MarkerIcon) => void;
  onNameMarker: (value: string) => void;
  onCloseIconPicker: () => void;
  onRemoveMarker: () => void;
  minting: boolean;
  acquiring: boolean;
  online: boolean;
  sketch: Sketch | null;
  thirdParty: boolean;
  onSearchPick: (lat: number, lon: number, accuracyM: number, label: string) => void;
  note: string;
  setNote: (value: string) => void;
  name: string;
  setName: (value: string) => void;
  mode: SessionMode;
  setMode: (value: SessionMode) => void;
  ttl: number;
  setTtl: (value: number) => void;
  panel: 'none' | 'options' | 'fallback';
  onTogglePanel: (which: 'options' | 'fallback') => void;
  onRelocate: () => void;
  onShare: () => void;
}) {
  const formats = allFormats(position.lat, position.lon);
  const togglePanel = onTogglePanel;

  return (
    <div className="map-sheet">
      {/* Reporting somewhere else usually starts with a name, not a drag —
          search appears only in that flow, and only with a connection. */}
      {thirdParty && online && <PlaceSearch onPick={onSearchPick} />}
      {thirdParty && !online && (
        <p className="offline-gate">
          Place search needs a connection — you can still tap the map to mark the spot instead.
        </p>
      )}

      {!online && ((sketch !== null && sketch.shapes.length > 0) || marker !== null) && (
        <div className="notice notice-offline">
          {thirdParty ? (
            <>
              {/* The offline code encodes the marked spot itself, so the
                  PLACE travels — the name, icon and drawing do not. */}
              <strong>The marker's name and your drawing stay on this phone.</strong>
              <span>
                An offline code still points at the marked spot, but it carries the position and
                nothing else. Say the name out loud instead, or get an expiring code when you
                have signal.
              </span>
            </>
          ) : (
            <>
              <strong>Your drawing and marked spot stay on this phone.</strong>
              <span>
                An offline code carries a position and nothing else — there is no server to hold
                them. Describe them out loud instead, or get an expiring code when you have
                signal.
              </span>
            </>
          )}
        </div>
      )}

      {iconPickerOpen && marker !== null && (
        <div className="sheet-panel sheet-panel-marker">
          <span className="panel-title">What is this spot?</span>
          <MarkerIconPicker current={markerIcon} onPick={onPickIcon} />
          <input
            className="note-input"
            placeholder="Name this spot — the operator sees it"
            maxLength={MAX_MARKER_NAME_CHARS}
            value={markerName}
            onChange={(event) => onNameMarker(event.target.value)}
          />
          <div className="row marker-edit-row">
            <button type="button" className="button button-danger" onClick={onRemoveMarker}>
              Remove
            </button>
            <button type="button" className="button button-primary" onClick={onCloseIconPicker}>
              Done
            </button>
          </div>
        </div>
      )}

      {marker !== null && !iconPickerOpen && (
        <p className="marker-row">
          {thirdParty
            ? 'Your code will point to this spot. Tap the map to move it; tap the diamond to name it.'
            : 'A spot is marked. Tap the map to move it; tap the diamond to name it.'}
          <span className="marker-row-actions">
            <button className="link-button" onClick={onRemoveMarker}>
              Remove it
            </button>
          </span>
        </p>
      )}

      {/* No marker yet in the report-elsewhere flow: the way forward is the
          whole message, because nothing can be shared until a spot exists. */}
      {thirdParty && marker === null && !iconPickerOpen && (
        <p className="marker-row">Search for a place, or tap the map to mark the spot you mean.</p>
      )}

      {/* A GNSS fix that settled poor. Manual pins are excluded — they are as
          precise as the placement, and re-locating would move them. */}
      {!acquiring && position.source !== 'manual' && position.accuracyM > ACCURACY_POOR_M && (
        <div className="notice notice-warn">
          <p>
            This fix is only accurate to about ±{Math.round(position.accuracyM)}m. On a phone,
            move to open sky or near a window and try again. On a laptop it's WiFi-based and
            won't get much tighter — a phone outdoors is far more precise.
          </p>
          <button className="link-button" onClick={onRelocate}>
            Try for a better fix
          </button>
        </div>
      )}

      {panel === 'options' && (
        <div className="sheet-panel">
          <div className="seg-block">
            <span className="seg-label">Code lasts for</span>
            <div className="seg-row" role="radiogroup" aria-label="How long the code lasts">
              {TTL_CHOICES.map(([seconds, label]) => (
                <button
                  key={seconds}
                  type="button"
                  className={`seg ${ttl === seconds ? 'seg-active' : ''}`}
                  aria-pressed={ttl === seconds}
                  onClick={() => setTtl(seconds)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={mode === 'live' && online}
              disabled={!online}
              onChange={(event) => setMode(event.target.checked ? 'live' : 'static')}
            />
            <span>
              <strong>Live session</strong>
              <small>
                {online
                  ? 'Others can join from your link, see you move, and draw with you.'
                  : 'Needs a connection — a live session lives on the server.'}
              </small>
            </span>
          </label>

          {/* The third-party toggle stays benched: the report-somewhere-else
              flow on the start screen covers it. */}

          <input
            className="note-input"
            placeholder="Name this share — stays on this phone"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />

          <input
            className="note-input"
            placeholder="Note for the operator, e.g. third floor, back stairwell"
            value={note}
            maxLength={280}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      )}

      {panel === 'fallback' && (
        <div className={`sheet-panel ${!online ? 'panel-urgent' : ''}`}>
          <span className="panel-title">If the code doesn't work</span>
          <p className="panel-hint">Any of these also identify this spot.</p>
          <FallbackRows formats={formats} position={position} />
        </div>
      )}

      <div className="sheet-bar">
        <p className="accuracy-readout">
          {acquiring
            ? `Improving the fix… ±${Math.round(position.accuracyM)}m so far`
            : thirdParty
              ? marker === null
                ? 'Mark the spot to get your code'
                : `Marked spot, ±${Math.round(marker.accuracyM)}m — the code points here`
              : describeSource(position.source, position.accuracyM)}
        </p>
        <div className="sheet-icons">
          <button
            type="button"
            className={`sheet-icon ${panel === 'options' ? 'sheet-icon-active' : ''}`}
            aria-label="Options"
            aria-expanded={panel === 'options'}
            title="Options"
            onClick={() => togglePanel('options')}
          >
            <GearIcon />
          </button>
          <button
            type="button"
            className={`sheet-icon ${panel === 'fallback' ? 'sheet-icon-active' : ''} ${!online ? 'sheet-icon-urgent' : ''}`}
            aria-label="If the code doesn't work"
            aria-expanded={panel === 'fallback'}
            title="If the code doesn't work"
            onClick={() => togglePanel('fallback')}
          >
            <SignalOffIcon />
          </button>
        </div>
      </div>

      {/* A marker-share has nothing to point a code at until a spot exists —
          offering the button anyway would mint a code for the demo default. */}
      <button
        className="big-button"
        onClick={onShare}
        disabled={minting || (thirdParty && marker === null)}
      >
        {minting ? 'Creating code…' : online ? 'Get my code' : 'Get my offline code'}
      </button>
    </div>
  );
}

/**
 * Place search for the report-somewhere-else flow, via OSM's Nominatim (the
 * same ecosystem as the tiles; no key needed). Search fires ONLY on submit —
 * never per keystroke — which keeps us far inside the public instance's
 * usage policy. The typed query does leave the device, so this renders only
 * when the caller is deliberately looking a place up, never for their own
 * position.
 */
function PlaceSearch({
  onPick,
}: {
  onPick: (lat: number, lon: number, accuracyM: number, label: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{
    lat: number;
    lon: number;
    accuracyM: number;
    label: string;
  }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const run = async () => {
    const q = query.trim();
    if (q === '' || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Array<{
        lat: string;
        lon: string;
        display_name: string;
        boundingbox?: [string, string, string, string];
      }>;
      setResults(
        data.map((place) => {
          const lat = Number(place.lat);
          const lon = Number(place.lon);
          // Honest precision: half the result's bounding-box diagonal. A
          // named building is tens of metres; a whole town caps at ±300m
          // rather than pretending to a pin-point.
          let accuracyM = 50;
          if (place.boundingbox !== undefined) {
            const [south, north, west, east] = place.boundingbox.map(Number) as [number, number, number, number];
            const northM = (north - south) * 111_320;
            const eastM = (east - west) * 111_320 * Math.cos((lat * Math.PI) / 180);
            accuracyM = Math.round(Math.min(300, Math.max(10, Math.hypot(northM, eastM) / 2)));
          }
          return { lat, lon, accuracyM, label: place.display_name };
        }),
      );
    } catch {
      setFailed(true);
      setResults(null);
    }
    setBusy(false);
  };

  return (
    <div className="place-search">
      <form
        className="place-search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <input
          className="note-input"
          type="search"
          placeholder="Search for a place or address"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="button button-primary" disabled={busy || query.trim() === ''}>
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {failed && (
        <p className="panel-hint">Search did not respond — you can still drag the pin instead.</p>
      )}
      {results !== null && results.length === 0 && (
        <p className="panel-hint">Nothing found for that. Try adding a town, or drag the pin.</p>
      )}
      {results !== null && results.length > 0 && (
        <div className="history-list place-results">
          {results.map((place) => (
            <button
              key={`${place.lat},${place.lon}`}
              type="button"
              className="history-row"
              onClick={() => {
                setResults(null);
                onPick(place.lat, place.lon, place.accuracyM, place.label);
              }}
            >
              <strong>{place.label.split(',')[0]}</strong>
              <span>{place.label.split(',').slice(1).join(',').trim()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.7-1L14.9 3.4h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.4 1 2-3.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The same four-corner expand glyph the map's own fullscreen control uses. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SignalOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="4.5" y1="19" x2="4.5" y2="15.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="9.5" y1="19" x2="9.5" y2="12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="14.5" y1="19" x2="14.5" y2="8.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="19.5" y1="19" x2="19.5" y2="5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <line x1="3" y1="4" x2="21" y2="21" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The offline code presented as the issued document.
 *
 * Everything a session code gets — the frame, the size, the phonetic grid — an
 * offline code gets too, because with no signal it is not a fallback, it is the
 * product. What it does not get is anything that resembles a countdown: this
 * code cannot be stopped, and styling it like one that can would be a lie about
 * the caller's own privacy.
 */
function OfflineShared({
  phase,
  formats,
  sketch,
  thirdParty,
  liveWanted,
  online,
  keeping,
  onKeep,
  onUpgrade,
  onShare,
  onStartAgain,
  saveSlot,
  pinAvatar,
}: {
  phase: Extract<Phase, { name: 'offline-shared' }>;
  formats: ReturnType<typeof allFormats>;
  sketch: Sketch | null;
  thirdParty: boolean;
  liveWanted: boolean;
  online: boolean;
  keeping: boolean;
  onKeep: () => void;
  onUpgrade: () => void;
  onShare: () => void;
  onStartAgain: () => void;
  saveSlot?: React.ReactNode;
  pinAvatar?: string | null;
}) {
  const { position, code, cause, detail } = phase;

  return (
    <div className="stack">
      <div className="code-doc code-doc-offline">
        <div className="code-doc-head">
          <span className="label">Offline code</span>
          <span className="code-permanent">Does not expire</span>
        </div>

        <div className="code-doc-body">
          <p className="code code-offline">{formatOfflineCode(code)}</p>

          <div className="read-aloud">
            <PhoneticGrid code={code} />
          </div>
        </div>
      </div>

      {sketch !== null && sketch.shapes.length > 0 && (
        <div className="notice notice-offline">
          <strong>Your drawing stays on this phone.</strong>
          <span>
            An offline code carries a position and nothing else — there is no server to hold the
            drawing. Describe it out loud instead, or get an expiring code when you have signal.
          </span>
        </div>
      )}

      <div className="notice notice-offline">
        <strong>This code never expires and cannot be stopped.</strong>
        <span>
          Your position is built into the code itself, which is what lets it work with no signal —
          at either end. It also means there is nothing to switch off: anyone who has these ten
          characters can find this spot, indefinitely. Only give it to the operator.
        </span>
      </div>

      <div className="row">
        <button className="button button-primary" onClick={onShare}>
          Share code
        </button>
        <button className="button" onClick={onStartAgain}>
          Start again
        </button>
      </div>

      {saveSlot}

      <p className="offline-reason">
        {cause === 'no-link' && 'Your phone has no connection, so there was no way to create a code that expires.'}
        {cause === 'no-network' && 'Nothing on the network answered, so there was no way to create a code that expires.'}
        {cause === 'service' &&
          (detail !== null
            ? `The code service could be reached but would not issue a code — ${detail}`
            : 'The code service could be reached but would not issue a code.')}
        {liveWanted && ' A code that follows you as you move needs a connection; this one is a single fixed point.'}
      </p>

      {/* Never swap the code underneath them. They may already have read it
          down the phone, so an expiring code is offered, never imposed. */}
      {online && !keeping && (
        <div className="notice notice-offer">
          <strong>
            {cause === 'service'
              ? 'You can try again for a code that expires.'
              : "You're back online."}
          </strong>
          <span>
            A session code expires after half an hour and you can stop it at any time. The offline
            code above keeps working either way — if you have already read it out, the operator can
            still use it.
          </span>
          <div className="notice-actions">
            <button className="button button-primary" onClick={onUpgrade}>
              Get an expiring code
            </button>
            <button className="link-button" onClick={onKeep}>
              Keep this one
            </button>
          </div>
        </div>
      )}

      {online && keeping && (
        <button className="link-button" onClick={onUpgrade}>
          Get an expiring code instead
        </button>
      )}

      {!online && (
        <button className="link-button" onClick={onUpgrade}>
          Try again for a code that expires
        </button>
      )}

      <Map
        lat={position.lat}
        lon={position.lon}
        accuracyM={position.accuracyM}
        thirdParty={thirdParty}
        pinAvatar={pinAvatar ?? null}
        offline={!online}
        sketch={sketch}
        fitContent
        allowFullscreen
        fullscreenOverlay={
          <div className="map-sheet map-sheet-code">
            <p className="map-code-line">{formatOfflineCode(code)}</p>
            <button className="button button-primary" onClick={onShare}>
              Share code
            </button>
          </div>
        }
      />

      <CoordinatePanel formats={formats} position={position} online={online} omitOfflineCode />
    </div>
  );
}

/**
 * Shown before a code exists, so the caller learns what they are about to get
 * *before* they press the button rather than being surprised by a permanent
 * code afterwards.
 */
function NoSignalNotice({ linkUp }: { linkUp: boolean }) {
  return (
    <div className="notice notice-offline">
      <strong>{linkUp ? 'Cannot reach the network.' : 'No connection.'}</strong>
      <span>
        You can still share where you are. You will get an offline code, which works with no signal
        because your position is inside the code — but it never expires and cannot be taken back.
      </span>
    </div>
  );
}

/**
 * Each phonetic word sits directly under the character it stands for.
 *
 * The spoken form is the real interface — it is what actually travels down the
 * phone line — so it gets presented as something to perform rather than as a
 * caption. Pairing word to character also means that when the operator asks
 * "sorry, was that the fifth one?", the caller can answer without re-reading
 * the whole string.
 */
function PhoneticGrid({ code }: { code: string }) {
  return (
    <div className="phonetic-grid">
      {[...code].map((char, index) => (
        <span className="phonetic-pair" key={`${char}-${index}`}>
          <span className="phonetic-char">{char}</span>
          <span className="phonetic-word">{phoneticFor(char)}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The fallback panel. Always rendered from local state with no network call —
 * minting a code needs connectivity, and if that connectivity goes away the
 * caller must still have something they can read down the phone.
 *
 * PROMINENT — open, and flagged — when there is no connection, because these
 * ARE the product then. Folded away behind its summary when there is one: a
 * person with a working code doesn't need four fallback formats competing
 * with it.
 */
function CoordinatePanel({
  formats,
  position,
  online,
  omitOfflineCode = false,
}: {
  formats: ReturnType<typeof allFormats>;
  position: Position;
  online: boolean;
  /** Set when the offline code is already the hero and repeating it would
      invite the caller to read out the same thing twice. */
  omitOfflineCode?: boolean;
}) {
  // Managed as state rather than a bare `open` attribute: the shared screen
  // re-renders every second for its countdown, and a prop-driven attribute
  // would slam the panel shut against the user's toggle on every tick.
  const [open, setOpen] = useState(!online);
  useEffect(() => {
    if (!online) setOpen(true);
  }, [online]);

  return (
    <details
      className={`panel panel-concertina ${!online ? 'panel-urgent' : ''}`}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="panel-title">If the code doesn't work</summary>
      <p className="panel-hint">Any of these also identify this spot.</p>
      <FallbackRows formats={formats} position={position} omitOfflineCode={omitOfflineCode} />
    </details>
  );
}

function FallbackRows({
  formats,
  position,
  omitOfflineCode = false,
}: {
  formats: ReturnType<typeof allFormats>;
  position: Position;
  omitOfflineCode?: boolean;
}) {
  const offlineCode = encodeOffline(position.lat, position.lon);
  return (
    <>
      {/* Computed on this device with no network call, so it survives losing
          signal after the page has loaded — the one thing a session code
          cannot do. Listed first for that reason. */}
      {!omitOfflineCode && (
        <CopyRow label="Offline code — say this one" value={formatOfflineCode(offlineCode)} />
      )}
      <CopyRow label="Latitude, longitude" value={formats.latLon} />
      {formats.plusCode !== null && <CopyRow label="Plus Code" value={formats.plusCode} />}
      {formats.osGridRef !== null && <CopyRow label="OS grid reference" value={formats.osGridRef} />}
    </>
  );
}
