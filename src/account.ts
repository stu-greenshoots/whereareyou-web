import type { MarkerIcon, Position } from '@whereareyou/protocol';
import { request, type ApiResult } from './api.js';

/**
 * Accounts and saved maps — the storage layer.
 *
 * Everyone has an account from the moment they open the app: a LOCAL one,
 * living entirely in this browser's localStorage, exactly as private as the
 * share history always was. Creating a REAL account is optional and only
 * changes where saved maps live — on the resolver, reachable from any
 * device. The rest of the app talks to ONE shape (`Account`, `SavedMap`)
 * and never cares which kind is behind it; that seam is what makes the
 * backend swappable later.
 *
 * A saved map is a deliberate, NAMED act — unlike the share history, which
 * is an automatic convenience. What it captures is the map as material:
 * position, note, sketch, marked spot. The code is kept only as a label —
 * codes expire, and a saved map must not pretend otherwise.
 */

export interface SavedMapData {
  lat: number;
  lon: number;
  accuracyM: number;
  note: string;
  /** Encoded sketch payload, or null. */
  sketch: string | null;
  marker: Position | null;
  markerIcon?: MarkerIcon;
  thirdParty: boolean;
  /** How this map came to be saved — my own share, a code I looked up, a
      live session I was in. Provenance, shown in the list. */
  source: 'share' | 'lookup' | 'live';
  /** The session code at save time. Informative only — it has expired. */
  code?: string;
}

export interface SavedMap extends SavedMapData {
  id: string;
  name: string;
  savedAt: number;
}

export type Account =
  | { kind: 'local'; name: string; avatar: string | null }
  | { kind: 'remote'; name: string; avatar: string | null; token: string };

const LOCAL_PROFILE_KEY = 'account.local';
const REMOTE_SESSION_KEY = 'account.remote';
const LOCAL_MAPS_KEY = 'account.savedMaps';

// ---------------------------------------------------------------------------
// Account persistence

export function loadAccount(): Account {
  try {
    const remote = localStorage.getItem(REMOTE_SESSION_KEY);
    if (remote !== null) {
      const parsed = JSON.parse(remote) as { token: string; name: string; avatar: string | null };
      if (typeof parsed.token === 'string' && typeof parsed.name === 'string') {
        return { kind: 'remote', name: parsed.name, avatar: parsed.avatar ?? null, token: parsed.token };
      }
    }
  } catch {
    // Fall through to local.
  }
  try {
    const local = localStorage.getItem(LOCAL_PROFILE_KEY);
    if (local !== null) {
      const parsed = JSON.parse(local) as { name: string; avatar: string | null };
      return { kind: 'local', name: parsed.name ?? '', avatar: parsed.avatar ?? null };
    }
  } catch {
    // A fresh local account.
  }
  return { kind: 'local', name: '', avatar: null };
}

export function persistAccount(account: Account): void {
  try {
    if (account.kind === 'remote') {
      localStorage.setItem(
        REMOTE_SESSION_KEY,
        JSON.stringify({ token: account.token, name: account.name, avatar: account.avatar }),
      );
    } else {
      localStorage.removeItem(REMOTE_SESSION_KEY);
      localStorage.setItem(
        LOCAL_PROFILE_KEY,
        JSON.stringify({ name: account.name, avatar: account.avatar }),
      );
    }
  } catch {
    // Storage full or blocked — the account still works for this visit.
  }
}

// ---------------------------------------------------------------------------
// Local saved maps

export function loadLocalMaps(): SavedMap[] {
  try {
    const raw = localStorage.getItem(LOCAL_MAPS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as SavedMap[];
    return Array.isArray(parsed)
      ? parsed.filter((m) => typeof m.id === 'string' && typeof m.lat === 'number')
      : [];
  } catch {
    return [];
  }
}

export function persistLocalMaps(maps: SavedMap[]): void {
  try {
    localStorage.setItem(LOCAL_MAPS_KEY, JSON.stringify(maps));
  } catch {
    // Saved maps are a convenience; a full store must not crash the app.
  }
}

export function clearLocalMaps(): void {
  try {
    localStorage.removeItem(LOCAL_MAPS_KEY);
  } catch {
    // Nothing to do.
  }
}

// ---------------------------------------------------------------------------
// The resolver's account API

interface AuthResponse {
  token: string;
  account: { username: string; avatar?: string };
}

function authed(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function apiRegister(username: string, password: string): Promise<ApiResult<AuthResponse>> {
  return request<AuthResponse>('/v1/account/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function apiLogin(username: string, password: string): Promise<ApiResult<AuthResponse>> {
  return request<AuthResponse>('/v1/account/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function apiLogout(token: string): Promise<ApiResult<void>> {
  return request<void>('/v1/account/logout', { method: 'POST', headers: authed(token) });
}

export function apiPatchAccount(
  token: string,
  patch: Record<string, unknown>,
): Promise<ApiResult<{ account: { username: string; avatar?: string } }>> {
  return request('/v1/account', {
    method: 'PATCH',
    headers: authed(token),
    body: JSON.stringify(patch),
  });
}

interface RemoteMapRecord {
  id: string;
  name: string;
  savedAt: number;
  data: string;
}

export async function apiListMaps(token: string): Promise<ApiResult<SavedMap[]>> {
  const result = await request<{ maps: RemoteMapRecord[] }>('/v1/account/maps', {
    headers: authed(token),
  });
  if (!result.ok) return result;
  const maps: SavedMap[] = [];
  for (const record of result.data.maps) {
    try {
      const data = JSON.parse(record.data) as SavedMapData;
      if (typeof data.lat === 'number' && typeof data.lon === 'number') {
        maps.push({ id: record.id, name: record.name, savedAt: record.savedAt, ...data });
      }
    } catch {
      // A corrupt blob loses itself, not the list.
    }
  }
  return { ok: true, data: maps };
}

export function apiPutMap(token: string, map: SavedMap): Promise<ApiResult<void>> {
  const { id, name, savedAt: _savedAt, ...data } = map;
  return request<void>(`/v1/account/maps/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: authed(token),
    body: JSON.stringify({ name, data: JSON.stringify(data) }),
  });
}

export function apiDeleteMap(token: string, id: string): Promise<ApiResult<void>> {
  return request<void>(`/v1/account/maps/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authed(token),
  });
}

// ---------------------------------------------------------------------------
// Avatar

/** Kept small enough to ride in a live-room hello frame (16KB cap). */
const AVATAR_SIZE = 64;

/**
 * A chosen photo, downsized to a small square JPEG data URL. One size is
 * used everywhere — the profile button, the drawer, the map dot — so the
 * account holds a few KB, not the camera original.
 */
export function fileToAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const context = canvas.getContext('2d');
      if (context === null) {
        reject(new Error('no canvas'));
        return;
      }
      // Cover-crop the centre square.
      const side = Math.min(image.width, image.height);
      context.drawImage(
        image,
        (image.width - side) / 2,
        (image.height - side) / 2,
        side,
        side,
        0,
        0,
        AVATAR_SIZE,
        AVATAR_SIZE,
      );
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable image'));
    };
    image.src = url;
  });
}

export function newMapId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
