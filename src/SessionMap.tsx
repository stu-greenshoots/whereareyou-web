import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Map as LeafletMap } from 'leaflet';
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
import { useSharedConnectivity } from './connectivity.js';
import {
  Map,
  centreOnPlacement,
  disarmPointTool,
  escapeHtml,
  isSafeAvatar,
  releaseFollow,
  type MapChatFlag,
  type MapPeer,
  type MapTrail,
  type MapZone,
  type PlacedMarker,
  type TileVariant,
} from './Map.jsx';
import { MarkerPlaceStrip, MarkerStrip } from './MarkerStrip.jsx';
import { SKETCH_INKS } from './sketch-layer.js';
import { NotifyControl } from './Notify.jsx';
import { OpenInMaps, openInMapsUrl } from './OpenInMaps.jsx';
import { SaveMapButton } from './SaveMap.jsx';
import { inferSource, timeRemaining } from './formats.js';
import { useResumeFix, useWakeLock } from './wake-lock.js';

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
 * BROADCASTING IS A SWITCH. The join-time choice ("Join and share my
 * location" / "Just watch") only sets where it starts; the live bar carries
 * it from then on, for the OWNER as much as for anyone else. Off tells the
 * room at once and takes our position out of everybody's roster — present,
 * not sharing, which is neither a dropped connection nor a quiet phone. The
 * consequence to keep in mind all through this file: a session can be
 * running, with a code, markers and zones, and have no live sharer pin at
 * all. Every surface has to read as that rather than as broken.
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
 * The pinned-path palette — and, because one path owns one colour, the cap on
 * how many may be up at once. Three lines that can genuinely be told apart at
 * arm's length outdoors is an honest number; a fourth would be a colour
 * somebody has to squint at.
 *
 * Borrowed from the drawing inks rather than invented, and for the same
 * reason they were chosen: they are the colours on this map that carry no
 * meaning. Amber is a REPORTED location, blue the caller's own position,
 * green a LIVE session, indigo an OFFLINE code, red an error — a path
 * borrowing any of those would be making a claim it cannot support. Slate is
 * out too, for a duller reason: it is what the peer dots are already made of,
 * so a slate ring on a slate dot is not a ring, it is a bigger dot (measured
 * — the first cut of this used slate and the ring vanished).
 *
 * Ink and path can still be told apart at a glance: ink is thick, solid and
 * white-cased; a path is thin, dotted and uncased. And no path colour ever
 * appears without the legend chip naming whose path it is — the colour
 * separates the lines, the chip and the ring on the dot say who.
 */
const TRAIL_COLOURS = [SKETCH_INKS[0], SKETCH_INKS[1], SKETCH_INKS[2]] as const;
const MAX_SHOWN_TRAILS = TRAIL_COLOURS.length;

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

/**
 * When a participant's stream counts as gone quiet. Phones drop fixes the
 * moment they lock or background; after a minute of silence the dot on the
 * map is a memory, not a position, and the room should be able to tell.
 */
const STALE_AFTER_MS = 60_000;

/** Whether a last-seen stamp is old enough to say so out loud. */
function isStale(lastSeenAt: string | undefined, now = Date.now()): boolean {
  if (lastSeenAt === undefined) return false;
  const age = now - Date.parse(lastSeenAt);
  return Number.isFinite(age) && age > STALE_AFTER_MS;
}

/**
 * Their socket CLOSED and the room kept them — the position on the map is
 * the last one they sent. Absence of the stamp means connected; the server
 * fans a disconnect out as a `participant` frame carrying it, never a
 * `left`, and `left` now always means genuine removal.
 *
 * Two states, never conflated. QUIET is a connected phone that has stopped
 * producing fixes (screen locked, indoors) — `isStale`, said in words only.
 * GONE is a phone that is no longer in the room at all — this, said in words
 * AND drawn. Both keep the last position; only one of them means the person
 * has actually dropped off, and a searcher reading the map has to be able to
 * tell which.
 */
function isGone(participant: LiveParticipant | undefined): boolean {
  return participant?.disconnectedAt !== undefined;
}

/** One pinned path. */
interface PinnedTrail {
  id: string;
  colour: string;
}

/**
 * Pin `id`'s path, holding whichever palette colour no other pinned path is
 * using. At the cap the OLDEST steps aside rather than the tap doing nothing:
 * a control that silently refuses reads as broken. Already pinned is a no-op,
 * so a colour never changes under someone mid-read.
 */
function withTrail(current: PinnedTrail[], id: string): PinnedTrail[] {
  if (current.some((trail) => trail.id === id)) return current;
  const kept = current.slice(-(MAX_SHOWN_TRAILS - 1));
  const taken = new Set(kept.map((trail) => trail.colour));
  // `kept` is one short of the palette, so a free colour always exists.
  const colour = TRAIL_COLOURS.find((candidate) => !taken.has(candidate)) ?? TRAIL_COLOURS[0];
  return [...kept, { id, colour }];
}

/** The sharer heads every People group; everyone else keeps roster order. */
function ownerFirst(a: LiveParticipant, b: LiveParticipant): number {
  return Number(b.owner) - Number(a.owner);
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
  /**
   * Whether this device STARTS by streaming its position. The join-time
   * choice ("Join and share my location" / "Just watch") sets it; from here
   * on it is a switch in the live bar that anyone — the owner included —
   * may flip either way, at any time.
   */
  share: boolean;
  /** Fires whenever the switch moves, so the parent can remember the
      posture across leaving and re-entering the room. */
  onSharingChange?: (sharing: boolean) => void;
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
  /**
   * Which basemap this surface draws. Defaults to `street` — the live room is
   * where people navigate to each other by landmark ("outside the Pret"), and
   * it is the only free raster that actually names shops and pubs. See
   * TILE_SOURCES in Map.tsx for the measurement behind that.
   */
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
  onSharingChange,
  name,
  avatar,
  initialPosition,
  initialSketch = null,
  initialMarkers = [],
  onSketchShared,
  onMarkersShared,
  onLeave,
  tiles = 'street',
  initialPanel,
}: SessionMapProps) {
  const [participants, setParticipants] = useState<Record<string, LiveParticipant>>({});
  const [selfId, setSelfId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState<'expired' | 'refused' | 'failed' | null>(null);
  const [mySketch, setMySketch] = useState<Sketch | null>(initialSketch);
  const [myPosition, setMyPosition] = useState<Position | null>(null);
  /**
   * Whether we are broadcasting our position RIGHT NOW. `share` is only
   * where this starts: the live bar carries a switch, and it works for the
   * owner as much as for anyone who joined to watch. Off means the room is
   * told at once and our position leaves everyone's roster — present, not
   * sharing — which is a different thing from a dropped connection.
   */
  const [sharing, setSharing] = useState(share);
  /**
   * Once you have shared a position you are a participant rather than a
   * watcher, and the chat composer never goes away again. Monotone on
   * purpose: going dark must not take your voice with it — least of all the
   * owner's, and least of all mid-conversation.
   */
  const [everShared, setEverShared] = useState(share);
  /** The points I placed — claims about the world, never where I am. */
  const [myMarkers, setMyMarkers] = useState<SessionMarker[]>(initialMarkers);
  /** Which of my markers has its edit strip open, and how it opened —
      `place` is the just-dropped naming step, `tap` is revisiting one that
      already exists (the only time the strip offers "Open in maps"). Either
      way the marker is in EDIT MODE while this is set: map taps MOVE it,
      repeatedly, until Done. */
  const [markerEdit, setMarkerEdit] = useState<{ id: string; via: 'place' | 'tap' } | null>(null);
  const markerEditRef = useRef(markerEdit);
  markerEditRef.current = markerEdit;
  /** The point tool is armed but nothing is placed yet — the pre-placement
      strip is up, carrying the hint and the way out. */
  const [placingMarker, setPlacingMarker] = useState(false);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  /** A drawn-but-unnamed zone, waiting for its name. */
  const [zoneDraft, setZoneDraft] = useState<{ center: Position; radiusM: number } | null>(null);
  const [zoneNameInput, setZoneNameInput] = useState('');
  const [panel, setPanel] = useState<'none' | 'chat' | 'activity' | 'people'>(
    initialPanel ?? 'none',
  );
  /** Which participant's card is open, and how it should present itself.
      `map` anchors it to that person's marker as a popover — a tapped pin or
      dot, and a roster tap that flew the camera to them. `roster` is the
      classic bottom sheet, for someone with no position to point at. */
  const [card, setCard] = useState<{ id: string; via: 'map' | 'roster' } | null>(null);
  /**
   * Whose paths are pinned on the map, oldest first, each holding a colour
   * for as long as it is up. Opening someone's card pins their path; CLOSING
   * the card no longer takes it away — the card sat directly on top of the
   * path it had just drawn, which made the whole thing useless. Turning one
   * off is now a deliberate act: the card's toggle, its chip in the legend,
   * or Hide all.
   */
  const [trails, setTrails] = useState<PinnedTrail[]>([]);
  /** The live Leaflet map — what the popover projects positions through. */
  const [liveMap, setLiveMap] = useState<LeafletMap | null>(null);
  /** The compass overlay, carrying the outcome of the iOS permission ask. */
  const [compass, setCompass] = useState<'closed' | HeadingPermission>('closed');
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  /** participantId → stamp of their latest message, while its bubble shows. */
  const [chatFlags, setChatFlags] = useState<Record<string, number>>({});
  const [, forceTick] = useState(0);

  /** Whether the resolver looks reachable — the same belief the rest of the
      app holds. Only gates the place search, which is online-only: offline
      the tap keeps working alone, quietly. */
  const { online } = useSharedConnectivity();

  const handleRef = useRef<LiveHandle | null>(null);
  const sharingRef = useRef(sharing);
  sharingRef.current = sharing;
  const selfIdRef = useRef<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const myMarkersRef = useRef(myMarkers);
  myMarkersRef.current = myMarkers;
  const participantsRef = useRef(participants);
  participantsRef.current = participants;
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

  const showTrail = useCallback((id: string) => {
    setTrails((current) => withTrail(current, id));
  }, []);

  const hideTrail = useCallback((id: string) => {
    setTrails((current) => current.filter((trail) => trail.id !== id));
  }, []);

  const toggleTrail = useCallback((id: string) => {
    setTrails((current) =>
      current.some((trail) => trail.id === id)
        ? current.filter((trail) => trail.id !== id)
        : withTrail(current, id),
    );
  }, []);

  /** Open someone's card and pin their path with it — but only if there IS
      a path. A watcher who never shared has no line to draw, and pinning them
      would hand a palette slot and a legend chip to nothing. */
  const openCard = useCallback(
    (id: string, via: 'map' | 'roster') => {
      setCard({ id, via });
      if ((participantsRef.current[id]?.trail?.length ?? 0) >= 2) showTrail(id);
    },
    [showTrail],
  );

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
      // When WE are the owner, any owner-flagged roster entry is a previous
      // connection of ours — being owner takes the updateToken, and only this
      // device holds it. The code screen's headless socket mid-close, or a
      // zombie the server has not reaped, must not stand beside the
      // synthesized self ("Stu" + "You", both sharer — the field-observed
      // duplicate). Registered above so old chat/events keep their name;
      // never rendered as a person.
      const roster =
        role === 'owner' ? welcome.roster.filter((entry) => !entry.owner) : welcome.roster;
      setParticipants(Object.fromEntries(roster.map((entry) => [entry.id, entry])));
      // A reconnect hands us a whole new roster with whole new participant
      // ids, and it does NOT emit `left` for the old ones. Any pinned path
      // keyed on an id this welcome does not carry is now a chip naming
      // somebody the map can no longer draw — prune it. Our own id is never
      // in the roster (the self entry is synthesized), so it is kept by name.
      const present = new Set([...welcome.roster.map((entry) => entry.id), welcome.participantId]);
      setTrails((current) => current.filter((trail) => present.has(trail.id)));
      setChat(welcome.chat);
      setZones(welcome.zones);
      setEvents(welcome.events.slice(-MAX_EVENT_HISTORY));
    },
    [registerParticipant, role],
  );

  const applyParticipant = useCallback(
    (participant: LiveParticipant) => {
      if (participant.id === selfIdRef.current) return; // our own echo, if any
      // Same rule as the welcome filter: we hold the updateToken, so an
      // owner-flagged frame under another id is a stale connection of ours,
      // not a second person. Never let it stand beside the synthesized self.
      if (role === 'owner' && participant.owner) return;
      registerParticipant(participant);
      // THEY WENT DARK: connected, and their position has left the roster.
      // Their path goes with it — the server has already dropped their trail,
      // and a line left drawn here would be this screen asserting a route for
      // someone who has stopped sharing one. A DISCONNECTED participant is
      // the opposite case and keeps both: their last position is history
      // worth having, and the map ghosts it rather than erasing it.
      const wentDark = participant.position === undefined && participant.disconnectedAt === undefined;
      if (wentDark) setTrails((current) => current.filter((trail) => trail.id !== participant.id));
      setParticipants((current) => {
        // Trails arrive in the welcome only; later frames would erase them.
        // Keep what we have and grow it with each new fix, capped like the
        // server's own ring.
        const kept = wentDark ? [] : (participant.trail ?? current[participant.id]?.trail ?? []);
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
    [registerParticipant, role],
  );

  /**
   * GENUINE removal — since live v2.3 that is all `left` ever means: owner
   * supersession, an over-cap disconnected entry evicted, or a reconnect
   * merging away its own disconnected entry. A dropped connection does NOT
   * arrive here; it arrives as a `participant` frame carrying
   * `disconnectedAt`, and the person stays on the map.
   *
   * Every scrap of per-participant state keyed on this id dies with it.
   * Participant ids are per-connection, so a RECONNECT is a `left` (old id)
   * immediately followed by a `participant` (new id): keeping anything keyed
   * on the old id would strand a bubble, a timer or an open card on a
   * connection that no longer exists. The registries (names, avatars, marker
   * labels) are deliberately NOT pruned — chat and events outlive the
   * connection that produced them and still have to render a name.
   */
  const applyLeft = useCallback((participantId: string) => {
    setParticipants((current) => {
      const { [participantId]: _removed, ...rest } = current;
      return rest;
    });
    const timer = flagTimersRef.current[participantId];
    if (timer !== undefined) {
      window.clearTimeout(timer);
      delete flagTimersRef.current[participantId];
    }
    setChatFlags((current) => {
      if (!(participantId in current)) return current;
      const { [participantId]: _done, ...rest } = current;
      return rest;
    });
    setCard((current) => (current?.id === participantId ? null : current));
    // A path outlives its card, but never its person. `left` is genuine
    // removal, so the line goes with them — leaving it drawn would be the
    // map asserting a route for somebody no longer in the room.
    setTrails((current) => current.filter((trail) => trail.id !== participantId));
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

  // The room is over: every pinned path comes down with it. What is left on
  // screen after an expiry is a record of where people WERE, and a dotted
  // line is exactly the thing that would keep reading as current.
  useEffect(() => {
    if (ended !== null) setTrails([]);
  }, [ended]);

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

  /**
   * The switch. Flipping OFF stops the fixes leaving this device in the
   * same tick, tells the room (which drops our position from the roster),
   * and clears our own copy so nothing on this screen keeps drawing us.
   * Flipping ON resumes: the watch below re-arms and the next fix puts us
   * back on everyone's map.
   */
  const toggleSharing = useCallback(() => {
    // Side effects stay OUT of the setState updater — React may run an
    // updater more than once (StrictMode does), and a doubled setShare
    // would send the room two contradictory frames for one tap.
    const next = !sharingRef.current;
    sharingRef.current = next;
    setSharing(next);
    handleRef.current?.setShare(next);
    if (next) {
      setEverShared(true);
    } else {
      setMyPosition(null);
      // Our own pinned path comes down with our position — the chip in the
      // legend must never outlive the line it names.
      const self = selfIdRef.current;
      if (self !== null) setTrails((current) => current.filter((trail) => trail.id !== self));
    }
    onSharingChange?.(next);
  }, [onSharingChange]);

  // Stream our own movement while we said we would.
  useEffect(() => {
    if (!sharing || !('geolocation' in navigator)) return;
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
  }, [sharing]);

  // While we are the one streaming, the screen must not sleep out from under
  // the share — a locked phone stops producing fixes. Quiet and best-effort,
  // and RELEASED the moment the switch goes off: holding a screen awake for
  // a stream nobody is sending is battery spent on nothing.
  useWakeLock(sharing && ended === null);

  // Coming back to the foreground: push one fresh fix immediately, so the
  // gap between "screen on" and "my dot moves" closes in a beat instead of
  // waiting for the watch to wake up. The socket's own reconnect+replay
  // handles the rest.
  const pushResumeFix = useCallback((fix: GeolocationPosition) => {
    const position: Position = {
      lat: fix.coords.latitude,
      lon: fix.coords.longitude,
      accuracyM: fix.coords.accuracy,
      source: inferSource(fix.coords.accuracy),
      takenAt: new Date(fix.timestamp).toISOString(),
    };
    setMyPosition(position);
    handleRef.current?.sendPosition(position);
  }, []);
  useResumeFix(sharing && ended === null, pushResumeFix);

  // The welcome roster is everyone ALREADY here — the server never includes
  // the joining connection itself — so without this, participants[selfId]
  // is forever undefined and tapping your own pin or dot opens nothing.
  // Synthesise the self entry locally from what we presented at hello, and
  // keep its position current as our own stream moves.
  useEffect(() => {
    if (selfId === null) return;
    setParticipants((current) => {
      const now = new Date().toISOString();
      // Our own path is grown here for the same reason everyone else's is
      // grown in applyParticipant: nothing on the wire carries it back to us.
      // Without this, tapping your own pin offers a path toggle that would
      // draw nothing — and the owner is the person most likely to try it.
      // Our own path goes the same way everyone else's does when the switch
      // goes off: nothing left drawn that we are no longer sending.
      const kept = sharing ? (current[selfId]?.trail ?? []) : [];
      let trail = kept;
      if (myPosition !== null) {
        const last = kept[kept.length - 1];
        if (
          last === undefined ||
          last.takenAt !== myPosition.takenAt ||
          last.lat !== myPosition.lat ||
          last.lon !== myPosition.lon
        ) {
          trail = [...kept, myPosition].slice(-MAX_TRAIL_FIXES);
        }
      }
      const self: LiveParticipant = {
        id: selfId,
        owner: role === 'owner',
        joinedAt: current[selfId]?.joinedAt ?? now,
        lastSeenAt: now,
        updatedAt: now,
        trail,
        ...(name !== undefined && name !== '' ? { name } : {}),
        ...(avatar !== undefined && avatar !== '' ? { avatar } : {}),
        ...(myPosition !== null ? { position: myPosition } : {}),
      };
      return { ...current, [selfId]: self };
    });
  }, [selfId, myPosition, role, name, avatar, sharing]);

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
      setMarkerEdit({ id: marker.id, via: 'place' });
    },
    [commitMarkers],
  );

  /** Move one of my markers to a tapped point — the edit-mode gesture. The
      camera stays put (the edge pills cover a landing out of view); the room
      gets the usual full-list replace, so the move travels like any edit. */
  const moveMarker = useCallback(
    (id: string, lat: number, lon: number, accuracyM: number) => {
      commitMarkers(
        myMarkersRef.current.map((m) =>
          m.id === id
            ? {
                ...m,
                position: {
                  lat,
                  lon,
                  accuracyM,
                  source: 'manual' as const,
                  takenAt: new Date().toISOString(),
                },
              }
            : m,
        ),
      );
    },
    [commitMarkers],
  );

  /** What a map tap means right now: with an edit strip open it MOVES that
      marker (repeatedly, until Done); otherwise it places a new one — the
      armed point tool's tap, which then opens the new marker's edit strip. */
  const placeOrMoveMarker = useCallback(
    (lat: number, lon: number, accuracyM: number) => {
      const editing = markerEditRef.current;
      if (editing !== null) {
        moveMarker(editing.id, lat, lon, accuracyM);
        return;
      }
      placeMarker(lat, lon, accuracyM);
    },
    [moveMarker, placeMarker],
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

  /** Normalise every name and tell the room — the shared tail of Done, of
      switching the strip to another marker mid-edit, and of arming the
      point tool over an open edit. */
  const commitMarkerNames = useCallback(() => {
    const next = myMarkersRef.current.map((m) => {
      const trimmed = (m.name ?? '').trim();
      const { name: _dropped, ...rest } = m;
      return trimmed === '' ? rest : { ...rest, name: trimmed };
    });
    commitMarkers(next);
  }, [commitMarkers]);

  const closeMarkerEdit = useCallback(() => {
    commitMarkerNames();
    setMarkerEdit(null);
  }, [commitMarkerNames]);

  /** The point tool arming or disarming. Arming over an open edit commits
      it — one mode at a time — and puts follow down (a strip is about to
      open over the map). The disarm side also fires when the tool puts
      itself down after a tap placement; the guard in the render (edit strip
      wins) keeps that from folding the fresh edit away. */
  const onMarkerToolChange = useCallback(
    (armed: boolean) => {
      if (armed) {
        if (markerEditRef.current !== null) {
          commitMarkerNames();
          setMarkerEdit(null);
        }
        if (liveMap !== null) releaseFollow(liveMap);
        setPlacingMarker(true);
      } else {
        setPlacingMarker(false);
      }
    },
    [commitMarkerNames, liveMap],
  );

  /** Done on the pre-placement strip — nothing was placed; close cleanly. */
  const closePlacing = useCallback(() => {
    setPlacingMarker(false);
    if (liveMap !== null) disarmPointTool(liveMap);
  }, [liveMap]);

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

  // The SHARER can drop off too, and their pin is the one everybody came for.
  // Ghost it where they last were rather than letting the map keep implying
  // a live fix. Never on our own map: we cannot be disconnected from
  // ourselves, and `pin` is our own stream there anyway.
  const pinGone = role === 'joiner' && isGone(owner);

  /**
   * The blue pin has nobody behind it. Two ways that happens, and both must
   * leave the map honest rather than drawing a phantom:
   *
   *  - OUR OWN map with the switch off — we are not sending a position, so
   *    there is nothing of ours to point at.
   *  - A JOINER's map where the sharer is in the room but sharing nothing.
   *    Their session still has a code, markers and zones; it just has no
   *    live owner pin. Note the deliberate gap: a sharer not in the roster
   *    at all (not yet welcomed, never opened the room) keeps today's
   *    behaviour, because `initialPosition` is the position the code
   *    actually resolves to and that is worth drawing.
   *
   * The map still CENTRES on `pin` either way — a view has to open
   * somewhere, and where the code points is the right somewhere.
   */
  const pinAbsent =
    role === 'owner'
      ? !sharing
      : owner !== undefined && !isGone(owner) && owner.position === undefined;

  /** participantId → the colour their pinned path is drawn in, if any. */
  const trailColours = useMemo(
    () => Object.fromEntries(trails.map((trail) => [trail.id, trail.colour])),
    [trails],
  );

  // Whose person the blue pin IS — the one whose card its tap opens, and
  // whose pinned path (if any) rings it.
  const pinPersonId = role === 'owner' ? selfId : (owner?.id ?? null);
  const pinTrailColour = pinPersonId !== null ? (trailColours[pinPersonId] ?? null) : null;

  const peers = useMemo(() => {
    const dots: MapPeer[] = [];
    for (const entry of roster) {
      if (entry.owner || entry.id === selfId || entry.position === undefined) continue;
      dots.push({
        id: entry.id,
        label: entry.name,
        avatar: entry.avatar,
        position: entry.position,
        // A dropped connection ghosts the dot where they last were; it never
        // takes it off the map. Still tappable — the card is where the room
        // is told WHEN they were last connected.
        disconnected: isGone(entry),
        // The ring that says WHICH dotted line on the map is theirs.
        trailColour: trailColours[entry.id] ?? null,
        onTap: () => openCard(entry.id, 'map'),
      });
    }
    // A sharing joiner appears to themselves too — seeing your own dot is
    // how you know the room can see you. Tapping it opens your own card,
    // the same as tapping anyone else's dot.
    if (role === 'joiner' && sharing && myPosition !== null) {
      dots.push({
        id: 'self',
        label: name ?? 'Me',
        avatar,
        position: myPosition,
        trailColour: (selfId !== null ? trailColours[selfId] : null) ?? null,
        onTap: () => {
          const self = selfIdRef.current;
          if (self !== null) openCard(self, 'map');
        },
      });
    }
    return dots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId, role, sharing, myPosition, name, avatar, trailColours, openCard]);

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
        onTap: () => {
          // Tapping a placed marker re-enters its edit mode — the same
          // strip, taps move it, Done commits. Follow goes down so a fix
          // cannot drag the map off the spot being edited; switching from
          // another open edit commits that one first — one mode, one marker.
          if (liveMap !== null) releaseFollow(liveMap);
          const open = markerEditRef.current;
          if (open !== null && open.id !== marker.id) commitMarkerNames();
          setMarkerEdit({ id: marker.id, via: 'tap' });
        },
      });
    }
    return points;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, selfId, myMarkers, name, liveMap]);

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

  const focusTrails = useMemo(() => {
    const list: MapTrail[] = [];
    for (const { id, colour } of trails) {
      const entry = participants[id];
      const fixes = entry?.trail;
      // Still pinned but nothing to draw yet (one fix, or none): the chip
      // stays up, the line simply has nothing to say.
      if (entry === undefined || fixes === undefined || fixes.length < 2) continue;
      list.push({
        id,
        colour,
        points: fixes.map((fix): [number, number] => [fix.lat, fix.lon]),
        // A dropped connection's path is history twice over; it fades to
        // match the ghosted dot at the end of it.
        ghost: isGone(entry),
      });
    }
    return list;
  }, [trails, participants]);

  /** Whether this person has enough of a path to be worth drawing — what the
      card's toggle is offered on. */
  const hasPath = useCallback(
    (id: string): boolean => (participants[id]?.trail?.length ?? 0) >= 2,
    [participants],
  );

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
          // Same rule as the map: a bearing to where they last were is worth
          // more than no bearing at all, as long as it says it is old.
          disconnected: isGone(entry),
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
  // With the switch off there IS no stream — not even the owner's opening
  // position, which by then is only where they used to be — so the overlay
  // runs its own fix and says so, exactly as it does for a watcher.
  const compassSelf = !sharing
    ? null
    : myPosition !== null
      ? { lat: myPosition.lat, lon: myPosition.lon }
      : role === 'owner'
        ? { lat: initialPosition.lat, lon: initialPosition.lon }
        : null;

  /**
   * Roster split. Everyone the room still holds is on the map and in the
   * People tab; only the CONNECTED ones are counted out loud. "2 others
   * here" has to mean two people who could answer — a count inflated by
   * ghosts would quietly rot into a lie over a long session. The ghosts are
   * discoverable the way they should be: visible, muted, and labelled with
   * when they were last connected.
   */
  const connectedRoster = roster.filter((entry) => !isGone(entry));
  const goneRoster = roster.filter((entry) => isGone(entry));
  const others = connectedRoster.filter((entry) => entry.id !== selfId).length;
  const remaining = expiresAt !== null ? timeRemaining(expiresAt) : null;
  const editingMarker = markerEdit !== null ? myMarkers.find((m) => m.id === markerEdit.id) : undefined;
  const cardParticipant = card !== null ? participants[card.id] : undefined;

  // Where a map-opened card anchors: the tapped marker's CURRENT position,
  // so the popover follows a moving pin. The blue pin renders from `pin`
  // (fresher than the roster frame for our own stream), everyone else from
  // their latest fix. Null means nothing to anchor to — fall back to the
  // classic bottom card rather than a popover floating on a guess.
  const cardAnchor = useMemo(() => {
    if (card === null || card.via !== 'map' || cardParticipant === undefined) return null;
    const isPinPerson = role === 'owner' ? card.id === selfId : cardParticipant.owner;
    if (isPinPerson) return { lat: pin.lat, lon: pin.lon };
    if (card.id === selfId) {
      return myPosition !== null ? { lat: myPosition.lat, lon: myPosition.lon } : null;
    }
    return cardParticipant.position !== undefined
      ? { lat: cardParticipant.position.lat, lon: cardParticipant.position.lon }
      : null;
  }, [card, cardParticipant, role, selfId, pin.lat, pin.lon, myPosition]);

  /**
   * Tapping someone in the People list is NAVIGATION: bring the map to them,
   * open their card anchored on their marker, and pin their path. The panel
   * closes on the way — the whole point is to see where they are, and the
   * roster is sitting over exactly that.
   *
   * Deliberately going to look at someone is the same gesture as going to
   * look at a place, so it puts follow-mode down through the same
   * `centreOnPlacement` path the search uses; without that the next streaming
   * fix would yank the view straight back off them.
   *
   * A watcher who never shared has nothing to fly to. The row does not
   * pretend: no jump, no anchored card, and the card says so in as many
   * words rather than opening onto empty map.
   */
  const focusPerson = useCallback(
    (entry: LiveParticipant) => {
      const position = entry.position;
      if (position === undefined) {
        openCard(entry.id, 'roster');
        return;
      }
      setPanel('none');
      if (liveMap !== null) centreOnPlacement(liveMap, position.lat, position.lon, 16);
      openCard(entry.id, 'map');
    },
    [liveMap, openCard],
  );

  /** One People row, rendered identically for both groups — the difference
      is which time it tells and how muted it reads, never its shape. */
  const personRow = (entry: LiveParticipant) => {
    const gone = isGone(entry);
    // A CONNECTED participant whose stream has gone quiet: say so instead of
    // "joined" — the row's time should answer "is this dot current?", not
    // "how long have they been here?". Calm wording, no alarm styling. Never
    // said of someone who has dropped off: they get "last connected", which
    // is a different and more final fact, and the two must not be muddled.
    const stale = !gone && entry.position !== undefined && isStale(entry.lastSeenAt);
    return (
      <button
        key={entry.id}
        type="button"
        className={`person-row${gone ? ' person-row-gone' : ''}`}
        onClick={() => focusPerson(entry)}
      >
        <Face name={entry.name ?? null} avatar={entry.avatar ?? null} />
        <span className="person-name">
          {displayName(entry.id)}
          {entry.owner ? <span className="person-tag">sharer</span> : null}
          {/* No position and no dropped connection: they are here and have
              their sharing switched off. Said the same way whether they
              never turned it on or turned it back off — the room cannot
              know which, and does not need to. The OWNER gets it too: this
              is the tag that stops a positionless sharer reading as broken. */}
          {entry.position === undefined && !gone ? (
            <span className="person-tag person-tag-quiet">not sharing</span>
          ) : null}
          {trailColours[entry.id] !== undefined ? (
            <span
              className="trail-swatch"
              style={{ '--trail-colour': trailColours[entry.id] } as CSSProperties}
              aria-label="path shown"
            />
          ) : null}
        </span>
        <span
          className={`person-meta${stale ? ' person-meta-stale' : ''}${gone ? ' person-meta-gone' : ''}`}
        >
          {gone && entry.disconnectedAt !== undefined
            ? `last connected ${timeAgo(entry.disconnectedAt)}`
            : stale && entry.lastSeenAt !== undefined
              ? `last seen ${timeAgo(entry.lastSeenAt)}`
              : entry.joinedAt !== undefined
                ? `joined ${timeAgo(entry.joinedAt)}`
                : ''}
        </span>
      </button>
    );
  };

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
        focusTrails={focusTrails}
        pinTrailColour={pinTrailColour}
        onPinTap={() => {
          if (pinPersonId !== null) openCard(pinPersonId, 'map');
        }}
        /* Place search, as a permanent map control — top-left under the zoom,
           on the owner's map, a joiner's and a watcher's alike. It moves the
           VIEW and nothing else; marking a spot is still the point tool's
           job. Withheld while the resolver looks unreachable: a field that
           cannot answer is worse than none. */
        placeSearch={online}
        onPlaceMarker={placeOrMoveMarker}
        /* Edit mode: while a marker's strip is open, a plain tap moves that
           marker — the tap only regains its usual meaning (nothing) once
           Done has closed the strip. */
        markerOnClick={markerEdit !== null}
        onMarkerToolChange={onMarkerToolChange}
        onZoneDraw={onZoneDraw}
        zonesFull={zonesFull}
        markersFull={myMarkers.length >= MAX_SESSION_MARKERS}
        pinAvatar={pinFace}
        pinDisconnected={pinGone}
        /* Nobody behind the blue pin: draw no pin rather than one standing
           where somebody used to be. The tiles, markers, zones, drawings
           and everyone else's dots are untouched — a session with its
           sharing off is still a session. */
        hidePin={pinAbsent}
        // The locate-me control, present on every other map view. On a
        // sharing surface it recentres on the position we already stream
        // (the blue pin / our own dot); a watcher gets the one-shot
        // viewer-dot behaviour. Top-right, clear of the drawing tools and
        // live bar (bottom) and the zoom control (top-left); the owner's
        // profile float shifts it down a slot via CSS.
        showViewerLocation
        selfPosition={sharing ? (myPosition ?? (role === 'owner' ? initialPosition : null)) : null}
        /* Follow-mode: the owner's view opens centred on THEMSELVES, so it
           follows from the start; a sharing joiner arrives on the sharer's
           pin — not themselves — so follow waits for the locate control.
           With the switch off there is no self on this map to follow at
           all, so the mode stands down and the legacy keep-the-pin-in-view
           framing takes over — and comes back when the switch does. */
        {...(!sharing
          ? {}
          : role === 'owner'
            ? { followSelf: 'on' as const }
            : { followSelf: 'off' as const })}
        viewerAvatar={avatar ?? null}
        onMapReady={setLiveMap}
        fullscreenLocked
        className="map map-fill"
        fullscreenOverlay={
          <>
            {/* The point tool is armed and nothing is placed yet: the strip
                opens straight away in its pre-placement state, so the place
                search is available BEFORE the first tap. The edit strip
                below wins the moment a marker exists. */}
            {editingMarker === undefined && placingMarker && (
              <MarkerPlaceStrip hint="Tap the map to place the point." onDone={closePlacing} />
            )}
            {editingMarker !== undefined && (
              <MarkerStrip
                icon={editingMarker.icon}
                name={editingMarker.name ?? ''}
                onPickIcon={(icon) => pickMarkerIcon(editingMarker.id, icon)}
                onNameChange={(value) => renameMarkerLocal(editingMarker.id, value)}
                onDone={closeMarkerEdit}
                onRemove={() => removeMarker(editingMarker.id)}
                // "Open in maps" belongs to revisiting a marker, not to the
                // placement step — placement is about naming the spot, not
                // leaving for another app.
                extraAction={
                  markerEdit?.via === 'tap' ? (
                    <OpenInMaps
                      lat={editingMarker.position.lat}
                      lon={editingMarker.position.lon}
                      label={
                        (editingMarker.name ?? '').trim() !== ''
                          ? (editingMarker.name ?? '').trim()
                          : 'Marked spot'
                      }
                    />
                  ) : undefined
                }
              />
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
            {/* The paths legend. It exists the moment a path does, and it
                is the answer to two questions at once: which colour is
                whose, and how do I put this away. */}
            {trails.length > 0 && (
              <div className="map-sheet trail-legend">
                <span className="trail-legend-label">Paths shown</span>
                {trails.map((trail) => (
                  <button
                    key={trail.id}
                    type="button"
                    className="trail-chip"
                    aria-label={`Hide ${displayName(trail.id)}’s path`}
                    onClick={() => hideTrail(trail.id)}
                  >
                    <span
                      className="trail-swatch"
                      style={{ '--trail-colour': trail.colour } as CSSProperties}
                      aria-hidden="true"
                    />
                    <span className="trail-chip-name">{displayName(trail.id)}</span>
                    <span className="trail-chip-x" aria-hidden="true">
                      ✕
                    </span>
                  </button>
                ))}
                {trails.length > 1 && (
                  <button
                    type="button"
                    className="link-button trail-hide-all"
                    onClick={() => setTrails([])}
                  >
                    Hide all
                  </button>
                )}
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
              {/* THE SWITCH. Broadcasting your position is a choice you can
                  change at any time, so it lives where the room's state
                  lives, wears its state on its face, and is one tap wide.
                  Everyone gets it: the owner can run a session without a
                  live pin, and someone who came in to watch can start
                  sharing without leaving and rejoining. */}
              <button
                type="button"
                className={`button share-switch ${sharing ? 'share-switch-on' : ''}`}
                aria-pressed={sharing}
                onClick={toggleSharing}
              >
                <span className="share-switch-label">Sharing my location</span>
                <span className="share-switch-state">
                  {sharing ? (
                    <>
                      <span className="live-dot" />
                      On
                    </>
                  ) : (
                    'Off'
                  )}
                </span>
              </button>
              {/* The sharer is here and sending nothing. Without this the
                  map reads as broken — no blue pin, no explanation — and a
                  joiner waits for a position that was never coming. */}
              {role === 'joiner' && pinAbsent && (
                <p className="live-bar-note">
                  The sharer is not sharing a position right now. Everything else on the map is
                  still theirs.
                </p>
              )}
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
              {/* Connected only — see the roster split. */}
              People{connectedRoster.length > 0 ? ` (${connectedRoster.length})` : ''}
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
              readOnly={!everShared}
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
                <>
                  {[...connectedRoster].sort(ownerFirst).map(personRow)}
                  {/* The ghosts, below the living and plainly labelled. A
                      dropped connection is not an alarm and not a departure,
                      so it gets a quiet group rather than a banner — but it
                      does get said, because someone scanning this list for a
                      missing friend must find them rather than conclude they
                      left. */}
                  {goneRoster.length > 0 && (
                    <>
                      <span className="people-group">Not connected</span>
                      {[...goneRoster].sort(ownerFirst).map(personRow)}
                    </>
                  )}
                </>
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

      {cardParticipant !== undefined &&
        (() => {
          const cardGone = isGone(cardParticipant);
          const cardStale =
            !cardGone && cardParticipant.position !== undefined && isStale(cardParticipant.lastSeenAt);
          const content = (
            <>
              <div className="live-card-head">
                <Face name={cardParticipant.name ?? null} avatar={cardParticipant.avatar ?? null} />
                <div className="live-card-title">
                  <strong>{displayName(cardParticipant.id)}</strong>
                  <span className="person-meta">
                    {cardGone
                      ? 'Not connected'
                      : cardParticipant.position === undefined
                        ? // Here, connected, position switched off. The
                          // owner keeps their standing said out loud —
                          // it is still their session — with the plain
                          // fact beside it.
                          cardParticipant.owner
                          ? 'The sharer — not sharing a position'
                          : 'Not sharing a position'
                        : cardParticipant.owner
                          ? 'Sharing this session'
                          : 'In the session'}
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
                {/* When they have dropped off, WHEN THEY WENT is the fact that
                    matters — it dates the position on the map. "Last seen"
                    would be answering a question nobody is asking any more,
                    so it is replaced rather than stacked beside it. */}
                {cardGone && cardParticipant.disconnectedAt !== undefined ? (
                  <span className="fact-gone">
                    Last connected {timeAgo(cardParticipant.disconnectedAt)}
                  </span>
                ) : (
                  cardParticipant.lastSeenAt !== undefined && (
                    <span className={cardStale ? 'fact-stale' : ''}>
                      Last seen {timeAgo(cardParticipant.lastSeenAt)}
                    </span>
                  )
                )}
                {cardParticipant.position !== undefined ? (
                  <span>
                    {cardGone ? 'Last fix' : 'Latest fix'} ±
                    {Math.round(cardParticipant.position.accuracyM)}m
                  </span>
                ) : (
                  // Said plainly, because the roster row that opened this
                  // deliberately did NOT fly anywhere, and an unexplained
                  // non-jump reads as a broken tap.
                  <span>No position shared</span>
                )}
              </div>
              {/* Two different truths, deliberately worded so they can never
                  be mistaken for each other: a quiet phone might be right
                  here; a dropped one is a position with a timestamp on it. */}
              {cardGone && cardParticipant.position !== undefined && (
                <p className="live-card-trail">
                  Their connection dropped. This is the last position they sent, not where they
                  are now.
                </p>
              )}
              {cardStale && (
                <p className="live-card-trail">
                  Nothing heard for a little while — this may not be where they are right now.
                </p>
              )}
              {/* The path toggle. Offered only where there is a path to
                  draw, and it says what it will do next, not what is true
                  now — the state is visible on the map either way. */}
              {hasPath(cardParticipant.id) &&
                (trailColours[cardParticipant.id] !== undefined ? (
                  <>
                    <button
                      type="button"
                      className="button live-card-path"
                      onClick={() => toggleTrail(cardParticipant.id)}
                    >
                      <span
                        className="trail-swatch"
                        style={
                          { '--trail-colour': trailColours[cardParticipant.id] } as CSSProperties
                        }
                        aria-hidden="true"
                      />
                      Hide path
                    </button>
                    <p className="live-card-trail">
                      Their path stays on the map after you close this.
                    </p>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button live-card-path"
                    onClick={() => toggleTrail(cardParticipant.id)}
                  >
                    Show path
                  </button>
                ))}
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
            </>
          );
          // Tapped on the map, with a position to point at: a popover over
          // that marker. From the roster (or with nothing to anchor to):
          // the classic bottom card.
          return cardAnchor !== null && liveMap !== null ? (
            <PinPopover
              map={liveMap}
              lat={cardAnchor.lat}
              lon={cardAnchor.lon}
              onDismiss={() => setCard(null)}
            >
              {content}
            </PinPopover>
          ) : (
            <div className="live-card" role="dialog" aria-label="Participant">
              {content}
            </div>
          );
        })()}
    </div>
  );
}

/** How far the popover clears the tapped icon: half the 26px pin ring plus
    the caret's reach, so the caret tip sits just off the marker. */
const POPOVER_GAP_PX = 22;
/** Minimum air between the popover and the map's edges. */
const POPOVER_MARGIN_PX = 8;
/** The caret never slides past the popover's rounded corners. */
const POPOVER_CARET_INSET_PX = 18;

/**
 * The participant card, anchored ABOVE a tapped map marker with a caret
 * pointing down at it. Projected through the live Leaflet map, so it follows
 * the marker through pans, zooms and live movement; flips below the marker
 * only when the top of the map leaves no room, and clamps to the map's width
 * on phones (the caret keeps pointing at the marker regardless).
 */
function PinPopover({
  map,
  lat,
  lon,
  onDismiss,
  children,
}: {
  map: LeafletMap;
  lat: number;
  lon: number;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{
    left: number;
    top: number;
    caretX: number;
    below: boolean;
  } | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  const place = useCallback(() => {
    const box = boxRef.current;
    if (box === null) return;
    const point = map.latLngToContainerPoint([lat, lon]);
    const size = map.getSize();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.round(
      Math.min(
        Math.max(point.x - width / 2, POPOVER_MARGIN_PX),
        Math.max(POPOVER_MARGIN_PX, size.x - width - POPOVER_MARGIN_PX),
      ),
    );
    const caretX = Math.round(
      Math.min(Math.max(point.x - left, POPOVER_CARET_INSET_PX), width - POPOVER_CARET_INSET_PX),
    );
    const below = point.y - height - POPOVER_GAP_PX < POPOVER_MARGIN_PX;
    const top = Math.round(below ? point.y + POPOVER_GAP_PX : point.y - height - POPOVER_GAP_PX);
    setLayout({ left, top, caretX, below });
  }, [map, lat, lon]);

  // First paint (and any content change) measures before showing; map
  // movement re-projects continuously, so the card rides its marker.
  useLayoutEffect(place, [place, children]);
  useEffect(() => {
    map.on('move zoom moveend zoomend', place);
    window.addEventListener('resize', place);
    return () => {
      map.off('move zoom moveend zoomend', place);
      window.removeEventListener('resize', place);
    };
  }, [map, place]);

  // Tap-away dismisses — on click, not pointerdown, so panning the map under
  // the popover doesn't kill it (a touch pan never becomes a click; the card
  // just follows). Marker icons are exempt — their own tap decides what
  // opens next (the same card, another participant's, a marker sheet).
  useEffect(() => {
    const onTapAway = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target === null) return;
      if (boxRef.current?.contains(target) ?? false) return;
      if (target.closest('.leaflet-marker-icon') !== null) return;
      onDismissRef.current();
    };
    document.addEventListener('click', onTapAway, true);
    return () => document.removeEventListener('click', onTapAway, true);
  }, []);

  return (
    <div
      ref={boxRef}
      className={`live-card pin-popover ${layout?.below === true ? 'pin-popover-below' : ''}`}
      role="dialog"
      aria-label="Participant"
      style={
        layout === null
          ? { visibility: 'hidden', left: 0, top: 0 }
          : { left: layout.left, top: layout.top }
      }
    >
      {children}
      <span
        className="pin-popover-caret"
        aria-hidden="true"
        style={{ left: layout?.caretX ?? 0 }}
      />
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
