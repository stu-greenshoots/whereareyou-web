import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_CHAT_HISTORY,
  MAX_CHAT_TEXT_CHARS,
  MAX_EVENT_HISTORY,
  MAX_MARKER_NAME_CHARS,
  MAX_SESSION_MARKERS,
  MAX_SESSION_ZONES,
  MAX_TRAIL_FIXES,
  MAX_ZONE_NAME_CHARS,
  MAX_ZONE_RADIUS_M,
  MIN_ZONE_RADIUS_M,
  decodeSketch,
  encodeSketch,
} from '@whereareyou/protocol';
import type {
  ChatMessage,
  LiveEvent,
  LiveParticipant,
  MarkerIcon,
  Position,
  SessionMarker,
  Sketch,
  Zone,
} from '@whereareyou/protocol';
import {
  Compass,
  requestHeadingPermission,
  type CompassTarget,
  type HeadingPermission,
} from './Compass.jsx';
import { connectLive, newLiveId, type LiveHandle, type LiveHandlers, type LiveWelcome } from './live.js';
import {
  Map,
  MarkerIconPicker,
  escapeHtml,
  isSafeAvatar,
  type MapChatFlag,
  type MapPeer,
  type MapZone,
  type PlacedMarker,
  type TileVariant,
} from './Map.jsx';
import { NotifyControl } from './Notify.jsx';
import { OpenInMaps, openInMapsUrl } from './OpenInMaps.jsx';
import { SaveMapButton } from './SaveMap.jsx';
import { inferSource, timeRemaining } from './formats.js';

/**
 * The live room, as a screen. One component for both roles: the OWNER's map
 * has their own blue pin and streams their movement; a JOINER's map keeps
 * the blue pin on the owner (blue is THE caller, always) and shows
 * themselves as a slate dot like everyone else. Everyone draws; every
 * drawing is everyone's to see.
 *
 * Live v2 makes the room a place people can also talk and agree: chat, named
 * zones (the circle tool, given a name), enter/left/reached events, several
 * named markers each, and participant cards with trails. A watcher
 * (share: false — the dispatcher's posture) reads the room but does not
 * speak: the chat composer is withheld, not just disabled.
 *
 * Nothing that arrives here is ever logged — chat bodies, zone and marker
 * names, trails and positions are user content, end of story.
 */

/** The room's side panels — also the vocabulary of push deep links. */
export type LivePanel = 'chat' | 'activity' | 'people';

/** The panel a URL fragment names, if any. Push payload urls arrive as
    `lookup?code=<code>#chat|#activity|#people`; the fragment is which panel
    the notification was about. Anything else is not ours — ignored. */
export function panelFromFragment(hash: string): LivePanel | null {
  return hash === '#chat' || hash === '#activity' || hash === '#people'
    ? (hash.slice(1) as LivePanel)
    : null;
}

/** How long the little "said something" bubble hangs over a sender. */
const CHAT_FLAG_MS = 4000;
/** An unacked zone-create is withdrawn after this — the echo is the ack. */
const ZONE_ACK_MS = 15_000;
/** Start showing the chat counter when this near the cap. */
const CHAT_COUNTER_AT = 50;

/**
 * The ids of chat messages THIS DEVICE sent into a session, per code —
 * sessionStorage, because participant ids are per-connection: after the
 * code-screen ↔ live-map connection churn our own history arrives under a
 * participantId that is no longer ours, and without this record our own
 * words would render as "Someone". Ids only, never text — nothing here is
 * content. Capped at the server's own retention: an id that can no longer
 * appear in a welcome is not worth remembering.
 */
function sentChatKey(code: string): string {
  return `sentChat.${code}`;
}

function loadSentChatIds(code: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(sentChatKey(code));
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistSentChatIds(code: string, ids: Set<string>): void {
  try {
    sessionStorage.setItem(sentChatKey(code), JSON.stringify([...ids].slice(-MAX_CHAT_HISTORY)));
  } catch {
    // Convenience only — the current connection still renders "You" by id.
  }
}

/** Relative time for feeds and cards — deliberately coarse and calm. */
function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 45_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function clockTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** How a marker is spoken of in the events feed. */
function markerDisplay(marker: SessionMarker): string {
  const trimmed = (marker.name ?? '').trim();
  if (trimmed !== '') return `“${trimmed}”`;
  return marker.icon === 'spot' ? 'a marked spot' : `the ${marker.icon} marker`;
}

function markerPopupHtml(marker: SessionMarker): string {
  const title = (marker.name ?? '').trim();
  const heading = title !== '' ? `<strong>${escapeHtml(title)}</strong><br/>` : '';
  const url = openInMapsUrl(
    marker.position.lat,
    marker.position.lon,
    title !== '' ? title : 'Marked spot',
  );
  return `${heading}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open in maps</a>`;
}

/** Everyone's markers, with the legacy single-marker mirror honoured. */
function markersOf(participant: LiveParticipant): SessionMarker[] {
  if (participant.markers !== undefined) return participant.markers;
  if (participant.marker !== undefined) {
    return [
      {
        id: `legacy-${participant.id}`,
        position: participant.marker,
        icon: participant.markerIcon ?? 'spot',
      },
    ];
  }
  return [];
}

export interface SessionMapProps {
  code: string;
  /** Grouped form for the pill: X7K9-P2Q4. */
  displayCode: string;
  role: 'owner' | 'joiner';
  updateToken?: string;
  /** Whether THIS device streams its position (owners always do). */
  share: boolean;
  name?: string;
  /** This device's account photo, shown on everyone's map. */
  avatar?: string;
  initialPosition: { lat: number; lon: number; accuracyM: number };
  initialSketch?: Sketch | null;
  /** Markers this device already placed (the code screen's marked spot,
      restored state after a reload) — announced to the room on connect. */
  initialMarkers?: SessionMarker[];
  /** Fires on every committed change to OUR drawing, so the parent can keep
      it when this screen closes (and persist it across reloads). */
  onSketchShared?: (sketch: Sketch | null) => void;
  /** Same, for our marker list. */
  onMarkersShared?: (markers: SessionMarker[]) => void;
  onLeave: () => void;
  /** Which basemap this surface draws — `dark` on the console. */
  tiles?: TileVariant;
  /** Panel to open as the screen mounts — how a tapped push notification
      lands on the thing it announced (chat, activity, people). */
  initialPanel?: LivePanel;
}

export function SessionMap({
  code,
  displayCode,
  role,
  updateToken,
  share,
  name,
  avatar,
  initialPosition,
  initialSketch = null,
  initialMarkers = [],
  onSketchShared,
  onMarkersShared,
  onLeave,
  tiles = 'voyager',
  initialPanel,
}: SessionMapProps) {
  const [participants, setParticipants] = useState<Record<string, LiveParticipant>>({});
  const [selfId, setSelfId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<'expired' | 'refused' | 'failed' | null>(null);
  const [mySketch, setMySketch] = useState<Sketch | null>(initialSketch);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  /** The points I placed — claims about the world, never where I am. */
  const [myMarkers, setMyMarkers] = useState<SessionMarker[]>(initialMarkers);
  /** Which of my markers has its edit sheet open. */
  const [markerEdit, setMarkerEdit] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  /** A drawn-but-unnamed zone, waiting for its name. */
  const [zoneDraft, setZoneDraft] = useState<{ center: Position; radiusM: number } | null>(null);
  const [zoneNameInput, setZoneNameInput] = useState('');
  const [panel, setPanel] = useState<'none' | 'chat' | 'activity' | 'people'>(
    initialPanel ?? 'none',
  );
  /** Which participant's card is open. Their trail shows while it is. */
  const [card, setCard] = useState<string | null>(null);
  /** The compass overlay, carrying the outcome of the iOS permission ask. */
  const [compass, setCompass] = useState<'closed' | HeadingPermission>('closed');
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  /** participantId → stamp of their latest message, while its bubble shows. */
  const [chatFlags, setChatFlags] = useState<Record<string, number>>({});
  const [, forceTick] = useState(0);

  const handleRef = useRef<LiveHandle | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const myMarkersRef = useRef(myMarkers);
  myMarkersRef.current = myMarkers;
  const pendingChatRef = useRef<Array<{ localId: string; text: string }>>([]);
  const pendingZonesRef = useRef<Record<string, number>>({});
  const flagTimersRef = useRef<Record<string, number>>({});
  /** Names/avatars of everyone ever seen — chat history outlives departures. */
  const metaRef = useRef<Record<string, { name: string | null; avatar: string | null; owner: boolean }>>({});
  /** Zone and marker names ever seen — events may refer to removed ones. */
  const zoneNamesRef = useRef<Record<string, string>>({});
  const markerLabelsRef = useRef<Record<string, string>>({});
  /** Ids of chat messages this device sent, across connection churn. */
  const sentChatIdsRef = useRef<Set<string> | null>(null);
  if (sentChatIdsRef.current === null) sentChatIdsRef.current = loadSentChatIds(code);

  // The room takes the whole screen, like the map-first share flow.
  useEffect(() => {
    document.body.classList.add('map-first');
    return () => document.body.classList.remove('map-first');
  }, []);

  // One tick per second drives the countdown and the relative times.
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(
    () => () => {
      for (const timer of Object.values(flagTimersRef.current)) window.clearTimeout(timer);
      for (const timer of Object.values(pendingZonesRef.current)) window.clearTimeout(timer);
    },
    [],
  );

  const registerParticipant = useCallback((participant: LiveParticipant): void => {
    metaRef.current[participant.id] = {
      name: participant.name ?? null,
      avatar: participant.avatar ?? null,
      owner: participant.owner,
    };
    for (const marker of markersOf(participant)) {
      markerLabelsRef.current[marker.id] = markerDisplay(marker);
    }
  }, []);

  const applyWelcome = useCallback(
    (welcome: LiveWelcome) => {
      selfIdRef.current = welcome.participantId;
      setSelfId(welcome.participantId);
      setExpiresAt(welcome.expiresAt);
      setEnded(null);
      for (const timer of Object.values(pendingZonesRef.current)) window.clearTimeout(timer);
      pendingZonesRef.current = {};
      pendingChatRef.current = [];
      for (const entry of welcome.roster) registerParticipant(entry);
      for (const zone of welcome.zones) zoneNamesRef.current[zone.id] = zone.name;
      setParticipants(Object.fromEntries(welcome.roster.map((entry) => [entry.id, entry])));
      setChat(welcome.chat);
      setZones(welcome.zones);
      setEvents(welcome.events.slice(-MAX_EVENT_HISTORY));
    },
    [registerParticipant],
  );

  const applyParticipant = useCallback(
    (participant: LiveParticipant) => {
      if (participant.id === selfIdRef.current) return; // our own echo, if any
      registerParticipant(participant);
      setParticipants((current) => {
        // Trails arrive in the welcome only; later frames would erase them.
        // Keep what we have and grow it with each new fix, capped like the
        // server's own ring.
        const kept = participant.trail ?? current[participant.id]?.trail ?? [];
        let trail = kept;
        const fix = participant.position;
        if (fix !== undefined) {
          const last = kept[kept.length - 1];
          if (last === undefined || last.takenAt !== fix.takenAt || last.lat !== fix.lat || last.lon !== fix.lon) {
            trail = [...kept, fix].slice(-MAX_TRAIL_FIXES);
          }
        }
        return { ...current, [participant.id]: { ...participant, trail } };
      });
    },
    [registerParticipant],
  );

  const applyLeft = useCallback((participantId: string) => {
    setParticipants((current) => {
      const { [participantId]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  /** Whether a chat message is OURS: same connection, or an id this device
      sent under an earlier connection (the per-code sessionStorage set). */
  const isMine = useCallback(
    (message: ChatMessage): boolean =>
      message.participantId === selfIdRef.current ||
      (sentChatIdsRef.current?.has(message.id) ?? false),
    [],
  );

  const applyChat = useCallback(
    (message: ChatMessage) => {
      if (message.participantId === selfIdRef.current) {
        // The fanout of our own message replaces its optimistic copy — and
        // its server id joins the per-code sent set, so this message keeps
        // reading "You" after the next connection churn changes our
        // participantId out from under it.
        const pending = pendingChatRef.current;
        const index = pending.findIndex((entry) => entry.text === message.text);
        if (index !== -1) {
          const [entry] = pending.splice(index, 1);
          const sent = sentChatIdsRef.current;
          if (sent !== null) {
            sent.add(message.id);
            persistSentChatIds(code, sent);
          }
          setChat((current) => current.map((m) => (m.id === entry!.localId ? message : m)));
          return;
        }
      }
      const mine = isMine(message);
      setChat((current) => [...current, message]);
      if (mine) return;
      if (panelRef.current !== 'chat') setUnread((n) => n + 1);
      const sender = message.participantId;
      const stamp = Date.now();
      setChatFlags((current) => ({ ...current, [sender]: stamp }));
      const existing = flagTimersRef.current[sender];
      if (existing !== undefined) window.clearTimeout(existing);
      flagTimersRef.current[sender] = window.setTimeout(() => {
        setChatFlags((current) => {
          if (current[sender] !== stamp) return current;
          const { [sender]: _done, ...rest } = current;
          return rest;
        });
      }, CHAT_FLAG_MS);
    },
    [code, isMine],
  );

  const applyZoneCreated = useCallback((zone: Zone) => {
    zoneNamesRef.current[zone.id] = zone.name;
    const timer = pendingZonesRef.current[zone.id];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete pendingZonesRef.current[zone.id];
    }
    setZones((current) => [...current.filter((z) => z.id !== zone.id), zone]);
  }, []);

  const applyZoneRemoved = useCallback((id: string) => {
    setZones((current) => current.filter((z) => z.id !== id));
  }, []);

  const applyEvent = useCallback((event: LiveEvent) => {
    setEvents((current) => [...current, event].slice(-MAX_EVENT_HISTORY));
  }, []);

  const applyExpiry = useCallback((next: string) => setExpiresAt(next), []);

  // One socket for the lifetime of the screen.
  useEffect(() => {
    const handlers: LiveHandlers = {
      onWelcome: applyWelcome,
      onParticipant: applyParticipant,
      onLeft: applyLeft,
      onEnded: (reason) => setEnded(reason),
      onStatus: setConnected,
      onChat: applyChat,
      onZoneCreated: applyZoneCreated,
      onZoneRemoved: applyZoneRemoved,
      onEvent: applyEvent,
      onExpiry: applyExpiry,
    };
    // Dev builds only (dead-code-eliminated from production): the handlers
    // are reachable from the console so the UI can be exercised without a
    // v2 server behind it.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>)['__liveHandlers'] = handlers;
    }
    const handle = connectLive({
      code,
      share,
      ...(name !== undefined && name !== '' ? { name } : {}),
      ...(avatar !== undefined && avatar !== '' ? { avatar } : {}),
      ...(updateToken !== undefined ? { updateToken } : {}),
      handlers,
    });
    handleRef.current = handle;
    // Restored drawings and markers exist only in local state until they
    // travel once.
    if (initialSketch !== null && initialSketch.shapes.length > 0) {
      try {
        handle.sendSketch(encodeSketch(initialSketch));
      } catch {
        // Stays local.
      }
    }
    if (initialMarkers.length > 0) handle.sendMarkers(initialMarkers);
    return () => {
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>)['__liveHandlers'];
      }
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

  // The welcome roster is everyone ALREADY here — the server never includes
  // the joining connection itself — so without this, participants[selfId]
  // is forever undefined and tapping your own pin or dot opens nothing.
  // Synthesise the self entry locally from what we presented at hello, and
  // keep its position current as our own stream moves.
  useEffect(() => {
    if (selfId === null) return;
    setParticipants((current) => {
      const now = new Date().toISOString();
      const self: LiveParticipant = {
        id: selfId,
        owner: role === 'owner',
        joinedAt: current[selfId]?.joinedAt ?? now,
        lastSeenAt: now,
        updatedAt: now,
        ...(name !== undefined && name !== '' ? { name } : {}),
        ...(avatar !== undefined && avatar !== '' ? { avatar } : {}),
        ...(myPosition !== null ? { position: myPosition } : {}),
      };
      return { ...current, [selfId]: self };
    });
  }, [selfId, myPosition, role, name, avatar]);

  /** Every committed change to my marker list: state, parent, wire. */
  const commitMarkers = useCallback(
    (next: SessionMarker[]) => {
      setMyMarkers(next);
      for (const marker of next) markerLabelsRef.current[marker.id] = markerDisplay(marker);
      onMarkersShared?.(next);
      handleRef.current?.sendMarkers(next);
    },
    [onMarkersShared],
  );

  const placeMarker = useCallback(
    (lat: number, lon: number, accuracyM: number) => {
      const current = myMarkersRef.current;
      if (current.length >= MAX_SESSION_MARKERS) return; // the tool is disabled at cap; this is the belt
      const marker: SessionMarker = {
        id: newLiveId(),
        position: { lat, lon, accuracyM, source: 'manual', takenAt: new Date().toISOString() },
        icon: 'spot',
      };
      commitMarkers([...current, marker]);
      setMarkerEdit(marker.id);
    },
    [commitMarkers],
  );

  const pickMarkerIcon = useCallback(
    (id: string, icon: MarkerIcon) => {
      commitMarkers(myMarkersRef.current.map((m) => (m.id === id ? { ...m, icon } : m)));
    },
    [commitMarkers],
  );

  /** Name edits stay local while typing; Done commits the lot. */
  const renameMarkerLocal = useCallback((id: string, value: string) => {
    setMyMarkers((current) =>
      current.map((m) => {
        if (m.id !== id) return m;
        const { name: _dropped, ...rest } = m;
        const trimmedish = value.slice(0, MAX_MARKER_NAME_CHARS);
        return trimmedish === '' ? rest : { ...rest, name: trimmedish };
      }),
    );
  }, []);

  const closeMarkerEdit = useCallback(() => {
    // Normalise the name on the way out, then tell the room.
    const next = myMarkersRef.current.map((m) => {
      const trimmed = (m.name ?? '').trim();
      const { name: _dropped, ...rest } = m;
      return trimmed === '' ? rest : { ...rest, name: trimmed };
    });
    commitMarkers(next);
    setMarkerEdit(null);
  }, [commitMarkers]);

  const removeMarker = useCallback(
    (id: string) => {
      commitMarkers(myMarkersRef.current.filter((m) => m.id !== id));
      setMarkerEdit(null);
    },
    [commitMarkers],
  );

  const zonesFull = zones.length >= MAX_SESSION_ZONES;

  const onZoneDraw = useCallback((center: { lat: number; lon: number }, radiusM: number, accuracyM: number) => {
    const clamped = Math.round(Math.min(MAX_ZONE_RADIUS_M, Math.max(MIN_ZONE_RADIUS_M, radiusM)));
    setZoneNameInput('');
    setZoneDraft({
      center: {
        lat: center.lat,
        lon: center.lon,
        accuracyM,
        source: 'manual',
        takenAt: new Date().toISOString(),
      },
      radiusM: clamped,
    });
  }, []);

  const createZone = useCallback(() => {
    if (zoneDraft === null) return;
    const zoneName = zoneNameInput.trim().slice(0, MAX_ZONE_NAME_CHARS);
    if (zoneName === '') return;
    const id = newLiveId();
    zoneNamesRef.current[id] = zoneName;
    // Optimistic: render now, reconcile when the echo (the ack) arrives.
    // If it never does — the create raced the cap, or was dropped — the
    // zone is withdrawn rather than left lying about a shared agreement.
    setZones((current) => [
      ...current,
      {
        id,
        name: zoneName,
        center: zoneDraft.center,
        radiusM: zoneDraft.radiusM,
        createdBy: selfIdRef.current ?? '',
        createdAt: new Date().toISOString(),
      },
    ]);
    handleRef.current?.sendZoneCreate({
      id,
      name: zoneName,
      center: zoneDraft.center,
      radiusM: zoneDraft.radiusM,
    });
    pendingZonesRef.current[id] = window.setTimeout(() => {
      delete pendingZonesRef.current[id];
      setZones((current) => current.filter((z) => z.id !== id));
    }, ZONE_ACK_MS);
    setZoneDraft(null);
  }, [zoneDraft, zoneNameInput]);

  const removeZone = useCallback((id: string) => {
    setZones((current) => current.filter((z) => z.id !== id));
    handleRef.current?.sendZoneRemove(id);
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

  const changeSketch = useCallback(
    (sketch: Sketch | null) => {
      setMySketch(sketch);
      onSketchShared?.(sketch);
      // An empty sketch is announced too — clearing must clear everywhere.
      try {
        handleRef.current?.sendSketch(sketch === null ? 'AQAA' : encodeSketch(sketch));
      } catch {
        // An unencodable sketch stays local; the room just doesn't hear it.
      }
    },
    [onSketchShared],
  );

  const submitChat = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim().slice(0, MAX_CHAT_TEXT_CHARS);
      const self = selfIdRef.current;
      if (text === '' || self === null) return;
      const localId = `local-${newLiveId()}`;
      pendingChatRef.current.push({ localId, text });
      setChat((current) => [
        ...current,
        { id: localId, participantId: self, text, at: new Date().toISOString() },
      ]);
      handleRef.current?.sendChat(text);
      setDraft('');
    },
    [draft],
  );

  const openPanel = useCallback((which: 'chat' | 'activity' | 'people') => {
    setPanel(which);
    if (which === 'chat') setUnread(0);
  }, []);

  const roster = Object.values(participants);
  const owner = roster.find((entry) => entry.owner);

  const displayName = useCallback(
    (participantId: string): string => {
      if (participantId === selfId) return 'You';
      const live = participants[participantId];
      const meta = metaRef.current[participantId];
      const known = live?.name ?? meta?.name ?? null;
      if (known !== null && known !== '') return known;
      return (live?.owner ?? meta?.owner ?? false) ? 'The sharer' : 'Someone';
    },
    [participants, selfId],
  );

  const eventLine = useCallback(
    (event: LiveEvent): string => {
      // Identity order per the contract: the server-stamped name (taken at
      // event time — the actor may have left since), then the roster and
      // this screen's registry of everyone seen, then a generic label. Our
      // own connection still reads "You" first.
      const stamped = (event.name ?? '').trim();
      const who =
        event.participantId === selfId
          ? 'You'
          : stamped !== ''
            ? stamped
            : displayName(event.participantId);
      const target = (event.targetName ?? '').trim();
      if (event.kind === 'reached') {
        const label =
          target !== ''
            ? `“${target}”`
            : event.markerId !== undefined
              ? markerLabelsRef.current[event.markerId]
              : undefined;
        return `${who} reached ${label ?? 'a marked spot'}`;
      }
      const zoneName =
        target !== ''
          ? target
          : event.zoneId !== undefined
            ? zoneNamesRef.current[event.zoneId]
            : undefined;
      return `${who} ${event.kind} ${zoneName !== undefined ? `“${zoneName}”` : 'a zone'}`;
    },
    [displayName, selfId],
  );

  // The blue pin: me if I am the owner, the owner's latest fix if not.
  const pin =
    role === 'owner'
      ? (myPosition ?? initialPosition)
      : (owner?.position ?? initialPosition);

  // The blue pin's face follows the same rule as the pin itself: me when I
  // own the session, the owner's account photo (if they sent one) when not.
  const pinFace = role === 'owner' ? (avatar ?? null) : (owner?.avatar ?? null);

  const peers = useMemo(() => {
    const dots: MapPeer[] = [];
    for (const entry of roster) {
      if (entry.owner || entry.id === selfId || entry.position === undefined) continue;
      dots.push({
        id: entry.id,
        label: entry.name,
        avatar: entry.avatar,
        position: entry.position,
        onTap: () => setCard(entry.id),
      });
    }
    // A sharing joiner appears to themselves too — seeing your own dot is
    // how you know the room can see you. Tapping it opens your own card,
    // the same as tapping anyone else's dot.
    if (role === 'joiner' && share && myPosition !== null) {
      dots.push({
        id: 'self',
        label: name ?? 'Me',
        avatar,
        position: myPosition,
        onTap: () => {
          const self = selfIdRef.current;
          if (self !== null) setCard(self);
        },
      });
    }
    return dots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId, role, share, myPosition, name, avatar]);

  const placedMarkers = useMemo(() => {
    const points: PlacedMarker[] = [];
    for (const entry of roster) {
      if (entry.id === selfId) continue;
      for (const marker of markersOf(entry)) {
        points.push({
          id: marker.id,
          label: entry.name,
          name: marker.name,
          position: marker.position,
          icon: marker.icon,
          popupHtml: markerPopupHtml(marker),
        });
      }
    }
    for (const marker of myMarkers) {
      points.push({
        id: marker.id,
        label: name ?? 'Me',
        name: marker.name,
        position: marker.position,
        icon: marker.icon,
        onTap: () => setMarkerEdit(marker.id),
      });
    }
    return points;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId, myMarkers, name]);

  const mapZones = useMemo(() => {
    const list: MapZone[] = zones.map((zone) => {
      // The × only appears on zones the server would actually let us remove:
      // ours (same-connection participantId) or, as the session owner, any.
      // Matches the server's silent-drop gate — and inherits its POC caveat:
      // an anonymous creator who reconnects gets a new participantId and
      // loses the affordance on their own zone. Accepted, not fought.
      const removable = role === 'owner' || zone.createdBy === selfId;
      return {
        id: zone.id,
        name: zone.name,
        center: { lat: zone.center.lat, lon: zone.center.lon },
        radiusM: zone.radiusM,
        ...(removable ? { onRemove: () => removeZone(zone.id) } : {}),
      };
    });
    if (zoneDraft !== null) {
      const preview = zoneNameInput.trim();
      list.push({
        id: 'zone-draft',
        name: preview === '' ? '…' : preview,
        center: { lat: zoneDraft.center.lat, lon: zoneDraft.center.lon },
        radiusM: zoneDraft.radiusM,
      });
    }
    return list;
  }, [zones, zoneDraft, zoneNameInput, removeZone, role, selfId]);

  const flags = useMemo(() => {
    const list: MapChatFlag[] = [];
    for (const participantId of Object.keys(chatFlags)) {
      const position = participants[participantId]?.position;
      if (position === undefined) continue;
      list.push({ id: participantId, position: { lat: position.lat, lon: position.lon } });
    }
    return list;
  }, [chatFlags, participants]);

  const focusTrail = useMemo(() => {
    if (card === null) return null;
    const trail = participants[card]?.trail;
    if (trail === undefined || trail.length < 2) return null;
    return trail.map((fix): [number, number] => [fix.lat, fix.lon]);
  }, [card, participants]);

  const remoteSketches = useMemo(() => {
    const decoded: Array<{ id: string; sketch: Sketch }> = [];
    for (const entry of roster) {
      if (entry.id === selfId || entry.sketch === undefined) continue;
      const sketch = decodeSketch(entry.sketch);
      if (sketch !== null && sketch.shapes.length > 0) decoded.push({ id: entry.id, sketch });
    }
    return decoded;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId]);

  // Everything the compass can point at: everyone else with a position, and
  // every placed marker (theirs and mine). Never me — I am its centre.
  const compassTargets = useMemo<CompassTarget[]>(() => {
    const list: CompassTarget[] = [];
    for (const entry of roster) {
      if (entry.id === selfId) continue;
      if (entry.position !== undefined) {
        list.push({
          kind: 'person',
          id: entry.id,
          label: displayName(entry.id),
          avatar: entry.avatar ?? null,
          owner: entry.owner,
          position: { lat: entry.position.lat, lon: entry.position.lon },
        });
      }
      for (const marker of markersOf(entry)) {
        list.push({
          kind: 'marker',
          id: marker.id,
          icon: marker.icon,
          ...(marker.name !== undefined ? { name: marker.name } : {}),
          position: { lat: marker.position.lat, lon: marker.position.lon },
        });
      }
    }
    for (const marker of myMarkers) {
      list.push({
        kind: 'marker',
        id: marker.id,
        icon: marker.icon,
        ...(marker.name !== undefined ? { name: marker.name } : {}),
        position: { lat: marker.position.lat, lon: marker.position.lon },
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId, myMarkers, displayName]);

  // Where the compass starts measuring from: my own stream when I have one.
  // A watcher has no stream — the overlay runs its own fix and says so.
  const compassSelf =
    myPosition !== null
      ? { lat: myPosition.lat, lon: myPosition.lon }
      : role === 'owner'
        ? { lat: initialPosition.lat, lon: initialPosition.lon }
        : null;

  const others = roster.filter((entry) => entry.id !== selfId).length;
  const remaining = expiresAt !== null ? timeRemaining(expiresAt) : null;
  const editingMarker = markerEdit !== null ? myMarkers.find((m) => m.id === markerEdit) : undefined;
  const cardParticipant = card !== null ? participants[card] : undefined;

  return (
    <div className="share-stage">
      <Map
        lat={pin.lat}
        lon={pin.lon}
        accuracyM={pin.accuracyM}
        offline={false}
        tiles={tiles}
        sketch={mySketch}
        onSketchChange={changeSketch}
        peers={peers}
        remoteSketches={remoteSketches}
        placedMarkers={placedMarkers}
        zones={mapZones}
        chatFlags={flags}
        onChatFlagTap={() => openPanel('chat')}
        focusTrail={focusTrail}
        onPinTap={() => {
          const target = role === 'owner' ? selfId : (owner?.id ?? null);
          if (target !== null) setCard(target);
        }}
        onPlaceMarker={placeMarker}
        onZoneDraw={onZoneDraw}
        zonesFull={zonesFull}
        markersFull={myMarkers.length >= MAX_SESSION_MARKERS}
        pinAvatar={pinFace}
        // The locate-me control, present on every other map view. On a
        // sharing surface it recentres on the position we already stream
        // (the blue pin / our own dot); a watcher gets the one-shot
        // viewer-dot behaviour. Top-right, clear of the drawing tools and
        // live bar (bottom) and the zoom control (top-left); the owner's
        // profile float shifts it down a slot via CSS.
        showViewerLocation
        selfPosition={share ? (myPosition ?? (role === 'owner' ? initialPosition : null)) : null}
        viewerAvatar={avatar ?? null}
        fullscreenLocked
        className="map map-fill"
        fullscreenOverlay={
          <>
            {editingMarker !== undefined && (
              <div className="map-sheet">
                <span className="panel-title">What is this spot?</span>
                <MarkerIconPicker
                  current={editingMarker.icon}
                  onPick={(icon) => pickMarkerIcon(editingMarker.id, icon)}
                />
                <input
                  className="note-input"
                  placeholder="Name this spot — everyone sees it"
                  maxLength={MAX_MARKER_NAME_CHARS}
                  value={editingMarker.name ?? ''}
                  onChange={(event) => renameMarkerLocal(editingMarker.id, event.target.value)}
                />
                <div className="row marker-edit-row">
                  <OpenInMaps
                    lat={editingMarker.position.lat}
                    lon={editingMarker.position.lon}
                    label={(editingMarker.name ?? '').trim() !== '' ? (editingMarker.name ?? '').trim() : 'Marked spot'}
                  />
                  <button type="button" className="button button-danger" onClick={() => removeMarker(editingMarker.id)}>
                    Remove
                  </button>
                  <button type="button" className="button button-primary" onClick={closeMarkerEdit}>
                    Done
                  </button>
                </div>
              </div>
            )}
            {zoneDraft !== null && (
              <div className="map-sheet">
                <span className="panel-title">Name this zone</span>
                <p className="panel-hint zone-hint">
                  A named circle everyone sees. The room is told when someone enters or leaves it.
                </p>
                <form
                  className="row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    createZone();
                  }}
                >
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    className="note-input"
                    placeholder="e.g. Search area"
                    maxLength={MAX_ZONE_NAME_CHARS}
                    value={zoneNameInput}
                    onChange={(event) => setZoneNameInput(event.target.value)}
                  />
                  <button type="submit" className="button button-primary" disabled={zoneNameInput.trim() === ''}>
                    Add zone
                  </button>
                  <button type="button" className="button" onClick={() => setZoneDraft(null)}>
                    Cancel
                  </button>
                </form>
              </div>
            )}
            <div className="map-sheet map-sheet-code live-bar">
              <div className="live-bar-code">
                <p className="map-code-line">{displayCode}</p>
                <button
                  type="button"
                  className="live-bar-status live-bar-people"
                  onClick={() => openPanel('people')}
                >
                  {ended !== null
                    ? ended === 'expired'
                      ? 'Session ended'
                      : 'Connection lost'
                    : !connected
                      ? 'Reconnecting…'
                      : `${others === 0 ? 'No one else here yet' : `${others} other${others === 1 ? '' : 's'} here`}${
                          remaining !== null && remaining !== 'expired' ? ` · ${remaining} left` : ''
                        }`}
                </button>
              </div>
              <div className="live-bar-actions">
                {/* Gated on the socket, not navigator.onLine: a room we can
                    reach is the only honest proof the subscribe can land. */}
                {connected && ended === null && <NotifyControl code={code} variant="live" />}
                <button
                  type="button"
                  className="button live-chat-button"
                  aria-label="Compass — which way is everyone?"
                  title="Compass"
                  onClick={() => {
                    // The iOS orientation permission only exists inside a
                    // user gesture — ask here, then open with the answer.
                    void requestHeadingPermission().then(setCompass);
                  }}
                >
                  <CompassIcon />
                </button>
                <button
                  type="button"
                  className="button live-chat-button"
                  aria-label="Chat with the room"
                  onClick={() => openPanel('chat')}
                >
                  <ChatIcon />
                  {unread > 0 && <span className="chat-unread">{unread > 9 ? '9+' : unread}</span>}
                </button>
                <button type="button" className="button button-primary" onClick={() => void shareRoom()}>
                  Share
                </button>
                <button type="button" className="button" onClick={onLeave}>
                  {role === 'owner' ? 'Back to code' : 'Leave'}
                </button>
              </div>
              {/* A live map is savable by anyone in it — the snapshot is taken
                  at save time: the pin as it stands, my drawing, my spots. */}
              <SaveMapButton
                className="button live-bar-save"
                data={() => ({
                  lat: pin.lat,
                  lon: pin.lon,
                  accuracyM: pin.accuracyM,
                  note: '',
                  sketch:
                    mySketch !== null && mySketch.shapes.length > 0 ? encodeSketch(mySketch) : null,
                  marker: myMarkers[0]?.position ?? null,
                  ...(myMarkers[0] !== undefined ? { markerIcon: myMarkers[0].icon } : {}),
                  thirdParty: false,
                  source: 'live',
                  code,
                })}
              />
            </div>
          </>
        }
      />

      {panel !== 'none' && (
        <div className="live-panel" role="dialog" aria-label="Session panel">
          <div className="live-panel-tabs">
            <button
              type="button"
              className={`live-tab ${panel === 'chat' ? 'live-tab-active' : ''}`}
              onClick={() => openPanel('chat')}
            >
              Chat{unread > 0 && panel !== 'chat' ? ` (${unread})` : ''}
            </button>
            <button
              type="button"
              className={`live-tab ${panel === 'activity' ? 'live-tab-active' : ''}`}
              onClick={() => openPanel('activity')}
            >
              Activity
            </button>
            <button
              type="button"
              className={`live-tab ${panel === 'people' ? 'live-tab-active' : ''}`}
              onClick={() => openPanel('people')}
            >
              People{roster.length > 0 ? ` (${roster.length})` : ''}
            </button>
            <button
              type="button"
              className="live-tab live-tab-close"
              aria-label="Close the panel"
              onClick={() => setPanel('none')}
            >
              ✕
            </button>
          </div>

          {panel === 'chat' && (
            <ChatTab
              chat={chat}
              isMine={isMine}
              displayName={displayName}
              participants={participants}
              meta={metaRef.current}
              readOnly={!share}
              connected={connected && ended === null}
              ended={ended !== null}
              draft={draft}
              setDraft={setDraft}
              onSubmit={submitChat}
            />
          )}

          {panel === 'activity' && (
            <div className="live-panel-body live-feed">
              {events.length === 0 ? (
                <p className="live-empty">
                  Nothing yet. Entries appear when someone enters or leaves a zone, or reaches a
                  marked spot.
                </p>
              ) : (
                [...events].reverse().map((event, index) => (
                  <p key={`${event.at}-${event.participantId}-${index}`} className="feed-row">
                    <span className={`feed-kind feed-${event.kind}`} aria-hidden="true" />
                    <span className="feed-text">{eventLine(event)}</span>
                    <span className="feed-time">{timeAgo(event.at)}</span>
                  </p>
                ))
              )}
            </div>
          )}

          {panel === 'people' && (
            <div className="live-panel-body live-people">
              {roster.length === 0 ? (
                <p className="live-empty">No one here yet.</p>
              ) : (
                [...roster]
                  .sort((a, b) => Number(b.owner) - Number(a.owner))
                  .map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="person-row"
                      onClick={() => setCard(entry.id)}
                    >
                      <Face name={entry.name ?? null} avatar={entry.avatar ?? null} />
                      <span className="person-name">
                        {displayName(entry.id)}
                        {entry.owner ? <span className="person-tag">sharer</span> : null}
                        {entry.position === undefined && !entry.owner ? (
                          <span className="person-tag person-tag-quiet">watching</span>
                        ) : null}
                      </span>
                      <span className="person-meta">
                        {entry.joinedAt !== undefined ? `joined ${timeAgo(entry.joinedAt)}` : ''}
                      </span>
                    </button>
                  ))
              )}
            </div>
          )}
        </div>
      )}

      {compass !== 'closed' && (
        <Compass
          targets={compassTargets}
          initialSelf={compassSelf}
          headingPermission={compass}
          onClose={() => setCompass('closed')}
        />
      )}

      {cardParticipant !== undefined && (
        <div className="live-card" role="dialog" aria-label="Participant">
          <div className="live-card-head">
            <Face name={cardParticipant.name ?? null} avatar={cardParticipant.avatar ?? null} />
            <div className="live-card-title">
              <strong>{displayName(cardParticipant.id)}</strong>
              <span className="person-meta">
                {cardParticipant.owner
                  ? 'Sharing this session'
                  : cardParticipant.position !== undefined
                    ? 'In the session'
                    : 'Watching'}
              </span>
            </div>
            <button
              type="button"
              className="live-tab live-tab-close"
              aria-label="Close"
              onClick={() => setCard(null)}
            >
              ✕
            </button>
          </div>
          <div className="live-card-facts">
            {cardParticipant.joinedAt !== undefined && (
              <span>Joined {timeAgo(cardParticipant.joinedAt)}</span>
            )}
            {cardParticipant.lastSeenAt !== undefined && (
              <span>Last seen {timeAgo(cardParticipant.lastSeenAt)}</span>
            )}
            {cardParticipant.position !== undefined && (
              <span>Latest fix ±{Math.round(cardParticipant.position.accuracyM)}m</span>
            )}
          </div>
          {focusTrail !== null && (
            <p className="live-card-trail">Their recent path is shown on the map while this is open.</p>
          )}
          {(() => {
            const theirs = events.filter((event) => event.participantId === cardParticipant.id);
            if (theirs.length === 0) return null;
            return (
              <div className="live-card-events">
                {theirs.slice(-4).reverse().map((event, index) => (
                  <p key={`${event.at}-${index}`} className="feed-row">
                    <span className={`feed-kind feed-${event.kind}`} aria-hidden="true" />
                    <span className="feed-text">{eventLine(event)}</span>
                    <span className="feed-time">{timeAgo(event.at)}</span>
                  </p>
                ))}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/** A small round face: the photo when they sent a usable one, else initial. */
function Face({ name, avatar }: { name: string | null; avatar: string | null }) {
  if (avatar !== null && isSafeAvatar(avatar)) {
    return <img className="face-dot face-img" src={avatar} alt="" />;
  }
  const first = (name ?? '').trim().charAt(0).toUpperCase();
  return <span className="face-dot">{/^[A-Z0-9]$/.test(first) ? first : '•'}</span>;
}

function ChatTab({
  chat,
  isMine,
  displayName,
  participants,
  meta,
  readOnly,
  connected,
  ended,
  draft,
  setDraft,
  onSubmit,
}: {
  chat: ChatMessage[];
  /** Ours by connection OR by the per-code sent-id record — never rendered
      as "Someone" just because our participantId changed since sending. */
  isMine: (message: ChatMessage) => boolean;
  displayName: (participantId: string) => string;
  participants: Record<string, LiveParticipant>;
  meta: Record<string, { name: string | null; avatar: string | null; owner: boolean }>;
  readOnly: boolean;
  connected: boolean;
  /** The room is over — "Reconnecting…" would be a lie in the composer. */
  ended: boolean;
  draft: string;
  setDraft: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Stay pinned to the newest message.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null) list.scrollTop = list.scrollHeight;
  }, [chat.length]);

  const remainingChars = MAX_CHAT_TEXT_CHARS - draft.length;

  return (
    <>
      <div className="live-panel-body chat-list" ref={listRef}>
        {chat.length === 0 ? (
          <p className="live-empty">No messages yet.</p>
        ) : (
          chat.map((message) => {
            const mine = isMine(message);
            // Identity order per the contract: the server-stamped sender
            // (taken at send time — the sender may have left since), then
            // the live roster, then this screen's registry, then generic.
            const stampedName = (message.name ?? '').trim();
            const senderName =
              stampedName !== '' ? stampedName : displayName(message.participantId);
            const avatar =
              message.avatar ??
              participants[message.participantId]?.avatar ??
              meta[message.participantId]?.avatar ??
              null;
            return (
              <div key={message.id} className={`chat-msg ${mine ? 'chat-mine' : ''}`}>
                {!mine && (
                  <Face
                    name={
                      stampedName !== ''
                        ? stampedName
                        : (participants[message.participantId]?.name ??
                          meta[message.participantId]?.name ??
                          null)
                    }
                    avatar={avatar}
                  />
                )}
                <div className="chat-body">
                  {!mine && <span className="chat-sender">{senderName}</span>}
                  <p className="chat-text">{message.text}</p>
                  <span className="chat-time">{clockTime(message.at)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {readOnly ? (
        <p className="chat-watch-note">Watching — you can read the room's messages.</p>
      ) : (
        <form className="chat-composer" onSubmit={onSubmit}>
          <input
            className="note-input"
            placeholder={ended ? 'The session has ended' : connected ? 'Message the session' : 'Reconnecting…'}
            maxLength={MAX_CHAT_TEXT_CHARS}
            value={draft}
            disabled={!connected}
            onChange={(event) => setDraft(event.target.value)}
          />
          {remainingChars <= CHAT_COUNTER_AT && <span className="chat-count">{remainingChars}</span>}
          <button
            type="submit"
            className="button button-primary"
            disabled={!connected || draft.trim() === ''}
          >
            Send
          </button>
        </form>
      )}
    </>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 5h16v11H9l-4 4v-4H4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CompassIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15.4 8.6 13.2 13.2 8.6 15.4l2.2-4.6Z" fill="currentColor" />
    </svg>
  );
}
