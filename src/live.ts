import type { LiveParticipant, LiveServerMessage, Position } from '@whereareyou/protocol';

/**
 * The client end of a live room: one socket, typed handlers, and reconnection
 * that takes phones seriously — a locked screen drops the socket, and coming
 * back must Just Work. On every (re)join we replay our own last position and
 * sketch, because the server keeps joiners in memory only: to be seen again
 * is to speak again.
 */

export interface LiveHandlers {
  onWelcome(participantId: string, expiresAt: string, roster: LiveParticipant[]): void;
  onParticipant(participant: LiveParticipant): void;
  onLeft(participantId: string): void;
  /** The room is over — expired, refused, or given up on. No reconnection follows. */
  onEnded(reason: 'expired' | 'refused' | 'failed', detail?: string): void;
  /** Socket connectivity, for a "reconnecting…" indicator. */
  onStatus(connected: boolean): void;
}

export interface LiveHandle {
  sendPosition(position: Position): void;
  /** Place, or with null clear, our single placed marker. */
  sendMarker(position: Position | null): void;
  sendSketch(sketch: string): void;
  close(): void;
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
  updateToken?: string;
  share: boolean;
  handlers: LiveHandlers;
}): LiveHandle {
  const { code, name, updateToken, share, handlers } = options;

  let socket: WebSocket | null = null;
  let closedByUs = false;
  let ended = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;
  // Replayed on every rejoin — see the header comment.
  let lastPosition: Position | null = null;
  let lastSketch: string | null = null;
  let lastMarker: Position | null | undefined; // undefined = never placed

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
        handlers.onWelcome(message.participantId, message.expiresAt, message.roster);
        if (lastPosition !== null) ws.send(JSON.stringify({ type: 'position', position: lastPosition }));
        if (lastMarker !== undefined) ws.send(JSON.stringify({ type: 'marker', position: lastMarker }));
        if (lastSketch !== null) ws.send(JSON.stringify({ type: 'sketch', sketch: lastSketch }));
      } else if (message.type === 'participant') {
        handlers.onParticipant(message.participant);
      } else if (message.type === 'left') {
        handlers.onLeft(message.participantId);
      } else if (message.type === 'expired') {
        end('expired');
      } else if (message.type === 'refused') {
        end('refused', message.reason);
      }
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
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'position', position }));
      }
    },
    sendMarker(position) {
      lastMarker = position;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'marker', position }));
      }
    },
    sendSketch(sketch) {
      lastSketch = sketch;
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'sketch', sketch }));
      }
    },
    close() {
      closedByUs = true;
      ended = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    },
  };
}
