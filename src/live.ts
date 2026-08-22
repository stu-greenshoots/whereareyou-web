import type {
  ChatMessage,
  LiveEvent,
  LiveParticipant,
  LiveServerMessage,
  Position,
  SessionMarker,
  Zone,
} from '@whereareyou/protocol';

/**
 * The client end of a live room: one socket, typed handlers, and reconnection
 * that takes phones seriously — a locked screen drops the socket, and coming
 * back must Just Work. On every (re)join we replay our own last position,
 * markers and sketch, because the server keeps joiners in memory only: to be
 * seen again is to speak again. Chat, zones and events are NOT replayed —
 * they are room state, retained by the server and re-delivered in the
 * welcome.
 *
 * THE TOLERANCE RULE: any message type this client does not recognise is
 * silently ignored (the dispatch below simply has no branch for it). Never
 * close the connection or surface an error over an unknown frame.
 */

/** Everything a v2 welcome carries. A v1 server omits the history arrays;
    they arrive here as empty, per the contract's absence-is-empty rule. */
export interface LiveWelcome {
  participantId: string;
  expiresAt: string;
  roster: LiveParticipant[];
  chat: ChatMessage[];
  zones: Zone[];
  events: LiveEvent[];
}

export interface LiveHandlers {
  onWelcome(welcome: LiveWelcome): void;
  onParticipant(participant: LiveParticipant): void;
  onLeft(participantId: string): void;
  /** The room is over — expired, refused, or given up on. No reconnection follows. */
  onEnded(reason: 'expired' | 'refused' | 'failed', detail?: string): void;
  /** Socket connectivity, for a "reconnecting…" indicator. */
  onStatus(connected: boolean): void;
  /** One chat message, fanned out by the server (the sender gets it too). */
  onChat?(message: ChatMessage): void;
  /** A zone landed — the sender's own echo is its create ack. */
  onZoneCreated?(zone: Zone): void;
  onZoneRemoved?(id: string): void;
  /** A detection outcome: someone entered/left a zone or reached a marker. */
  onEvent?(event: LiveEvent): void;
  /** The owner extended the session. */
  onExpiry?(expiresAt: string): void;
}

export interface LiveHandle {
  sendPosition(position: Position): void;
  /** Replace our whole marker list; [] clears. ≤ MAX_SESSION_MARKERS. */
  sendMarkers(markers: SessionMarker[]): void;
  sendSketch(sketch: string): void;
  /** Say something to the room. Trimmed here; the server truncates over-cap. */
  sendChat(text: string): void;
  /** `id` is client-generated (see newLiveId); the echo is the ack. */
  sendZoneCreate(zone: { id: string; name: string; center: Position; radiusM: number }): void;
  sendZoneRemove(id: string): void;
  close(): void;
}

/** An id valid under the protocol's id rule (1–64 of `A-Za-z0-9_-`). */
export function newLiveId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Where the socket lives: VITE_API_BASE in a deployed build, the dev proxy otherwise. */
function liveUrl(code: string): string {
  const base = import.meta.env['VITE_API_BASE'] ?? '';
  const root =
    base === ''
      ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
      : base.replace(/^http/, 'ws');
  return `${root}/v1/sessions/${code}/live`;
}

export function connectLive(options: {
  code: string;
  name?: string;
  /** Small data-URL photo, shown on everyone's map. Typed in the protocol's
      hello since live v2; an unusable one is dropped server-side, never a
      reason to refuse the join. */
  avatar?: string;
  updateToken?: string;
  share: boolean;
  handlers: LiveHandlers;
}): LiveHandle {
  const { code, name, avatar, updateToken, share, handlers } = options;

  let socket: WebSocket | null = null;
  let closedByUs = false;
  let ended = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  // Replayed on every rejoin — see the header comment.
  let lastPosition: Position | null = null;
  let lastSketch: string | null = null;
  let lastMarkers: SessionMarker[] | null = null; // null = never sent

  const send = (frame: Record<string, unknown>): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
    }
  };

  const end = (reason: 'expired' | 'refused' | 'failed', detail?: string): void => {
    if (ended) return;
    ended = true;
    closedByUs = true;
    socket?.close();
    handlers.onEnded(reason, detail);
  };

  const connect = (): void => {
    if (ended || closedByUs) return;
    const ws = new WebSocket(liveUrl(code));
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      ws.send(
        JSON.stringify({
          type: 'hello',
          code,
          share,
          ...(name !== undefined && name !== '' ? { name } : {}),
          ...(avatar !== undefined && avatar !== '' ? { avatar } : {}),
          ...(updateToken !== undefined ? { updateToken } : {}),
        }),
      );
    };

    ws.onmessage = (event) => {
      let message: LiveServerMessage;
      try {
        message = JSON.parse(String(event.data)) as LiveServerMessage;
      } catch {
        return;
      }
      if (message.type === 'welcome') {
        handlers.onStatus(true);
        handlers.onWelcome({
          participantId: message.participantId,
          expiresAt: message.expiresAt,
          roster: message.roster,
          // A v1 server sends no history arrays; absence means empty.
          chat: message.chat ?? [],
          zones: message.zones ?? [],
          events: message.events ?? [],
        });
        if (lastPosition !== null) ws.send(JSON.stringify({ type: 'position', position: lastPosition }));
        if (lastMarkers !== null) ws.send(JSON.stringify({ type: 'markers', markers: lastMarkers }));
        if (lastSketch !== null) ws.send(JSON.stringify({ type: 'sketch', sketch: lastSketch }));
      } else if (message.type === 'participant') {
        handlers.onParticipant(message.participant);
      } else if (message.type === 'left') {
        handlers.onLeft(message.participantId);
      } else if (message.type === 'chat') {
        handlers.onChat?.({
          id: message.id,
          participantId: message.participantId,
          text: message.text,
          at: message.at,
        });
      } else if (message.type === 'zone-created') {
        handlers.onZoneCreated?.(message.zone);
      } else if (message.type === 'zone-removed') {
        handlers.onZoneRemoved?.(message.id);
      } else if (message.type === 'event') {
        handlers.onEvent?.({
          kind: message.kind,
          participantId: message.participantId,
          ...(message.zoneId !== undefined ? { zoneId: message.zoneId } : {}),
          ...(message.markerId !== undefined ? { markerId: message.markerId } : {}),
          at: message.at,
        });
      } else if (message.type === 'expiry') {
        handlers.onExpiry?.(message.expiresAt);
      } else if (message.type === 'expired') {
        end('expired');
      } else if (message.type === 'refused') {
        end('refused', message.reason);
      }
      // Anything else: unknown type, ignored on purpose — the tolerance rule.
    };

    ws.onclose = () => {
      if (ended || closedByUs) return;
      handlers.onStatus(false);
      // Exponential backoff, capped — a locked phone reconnects in seconds,
      // a dead server doesn't get hammered.
      attempt += 1;
      if (attempt > 8) {
        end('failed');
        return;
      }
      const delay = Math.min(15_000, 1000 * 2 ** (attempt - 1));
      reconnectTimer = window.setTimeout(connect, delay);
    };

    ws.onerror = () => ws.close();
  };

  connect();

  return {
    sendPosition(position) {
      lastPosition = position;
      send({ type: 'position', position });
    },
    sendMarkers(markers) {
      lastMarkers = markers;
      send({ type: 'markers', markers });
    },
    sendSketch(sketch) {
      lastSketch = sketch;
      send({ type: 'sketch', sketch });
    },
    sendChat(text) {
      const trimmed = text.trim();
      if (trimmed === '') return;
      // Not replayed on rejoin: the server retains delivered chat.
      send({ type: 'chat', text: trimmed });
    },
    sendZoneCreate(zone) {
      send({ type: 'zone-create', ...zone });
    },
    sendZoneRemove(id) {
      send({ type: 'zone-remove', id });
    },
    close() {
      closedByUs = true;
      ended = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
