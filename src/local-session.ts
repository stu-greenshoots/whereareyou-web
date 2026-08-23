import type { MarkerIcon, Position, SessionMarker, SessionMode } from '@whereareyou/protocol';

/**
 * This device's memory of the sessions it is part of — the one share it OWNS
 * and the sessions it has JOINED. All of it lives in localStorage on this
 * phone only, is never sent anywhere, and is a convenience, not a record:
 * every reader tolerates it being absent, stale or unparseable.
 *
 * The point of keeping it here (rather than inside Share.tsx, where the
 * owner half historically lived) is the self-rejoin guard: the look-up
 * screen must be able to ask "is this code MINE?" and "have I joined this
 * one before?" before treating a typed code as a stranger's.
 */

/**
 * The one session this device currently has running, so a reload — or a trip
 * to another app — can come BACK to it as the owner instead of rejoining
 * their own room as a stranger. Cleared on revoke; ignored once expired.
 */
export interface ActiveShare {
  code: string;
  updateToken: string;
  expiresAt: string;
  mode: SessionMode;
  position: Position;
  /** The owner's drawing, encoded — restored on resume so a reload never
      quietly loses what was drawn against a still-live code. */
  sketch: string | null;
  /** LEGACY single-marker mirror of markers[0] — kept so an entry written by
      an older build still restores, and written on save for the same reason. */
  marker: Position | null;
  markerIcon: MarkerIcon;
  /** All placed markers. The source of truth since live v2. */
  markers?: SessionMarker[];
  /**
   * Whether this was a "share a different location" (marker-share): the code
   * points AT the marked spot rather than at the sharer. Restored on resume
   * so the code screen keeps telling the marker story after a reload.
   * Absent on entries written by older builds — read as false.
   */
  thirdParty?: boolean;
}

const ACTIVE_KEY = 'activeShare';

export function loadActiveShare(): ActiveShare | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as ActiveShare;
    return typeof parsed.code === 'string' && typeof parsed.updateToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function persistActiveShare(entry: ActiveShare | null): void {
  try {
    if (entry === null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, JSON.stringify(entry));
  } catch {
    // Convenience only.
  }
}

/**
 * The identity this device presented when it joined someone else's session —
 * so re-entering the same code resumes as the SAME person (name, watcher or
 * sharer posture) instead of piling a fresh anonymous participant into the
 * room. Server participant ids are per-connection and cannot be resumed;
 * the presented identity is the stable part, so it is what we keep.
 */
export interface JoinedIdentity {
  /** Whether this device streamed its own position into the room. */
  share: boolean;
  /** The display name presented at hello. '' when joined anonymously. */
  name: string;
  /** When the join happened, for pruning. */
  at: number;
}

const JOINED_KEY = 'joinedSessions';
/** No session outlives 24h (the extend cap), so no record needs to either. */
const JOINED_TTL_MS = 24 * 60 * 60 * 1000;

function loadJoinedAll(): Record<string, JoinedIdentity> {
  try {
    const raw = localStorage.getItem(JOINED_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Record<string, JoinedIdentity>;
    if (typeof parsed !== 'object' || parsed === null) return {};
    // Prune on read: codes are recycled only after long delays, but a stale
    // identity silently re-entering a NEW session under an old code would be
    // wrong, so nothing older than a session's maximum life survives.
    const now = Date.now();
    const fresh: Record<string, JoinedIdentity> = {};
    for (const [code, entry] of Object.entries(parsed)) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.at === 'number' &&
        now - entry.at < JOINED_TTL_MS
      ) {
        fresh[code] = entry;
      }
    }
    return fresh;
  } catch {
    return {};
  }
}

export function loadJoinedIdentity(code: string): JoinedIdentity | null {
  return loadJoinedAll()[code] ?? null;
}

export function rememberJoinedIdentity(code: string, identity: { share: boolean; name: string }): void {
  try {
    const all = loadJoinedAll();
    all[code] = { ...identity, at: Date.now() };
    localStorage.setItem(JOINED_KEY, JSON.stringify(all));
  } catch {
    // Convenience only.
  }
}
