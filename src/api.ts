import type {
  CreateSessionResponse,
  MarkerIcon,
  Position,
  ResolvedSession,
  SessionMarker,
  SessionMode,
  SessionSubject,
} from '@whereareyou/protocol';

/**
 * Empty by default: requests go to this page's own origin and the dev server
 * proxies /v1 to the API. That keeps the phone on a single HTTPS origin, which
 * avoids both mixed-content blocking and CORS.
 *
 * Set VITE_API_BASE to point at a resolver on a different host.
 */
const BASE = import.meta.env['VITE_API_BASE'] ?? '';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; message: string; status: number };

export async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: 'network',
      message: 'Could not reach the resolver. Is the API running?',
    };
  }

  if (response.status === 204) return { ok: true, data: undefined as T };

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: (body as { error?: string }).error ?? 'unknown',
      message: (body as { message?: string }).message ?? response.statusText,
    };
  }
  return { ok: true, data: body as T };
}

/**
 * Is the resolver actually reachable?
 *
 * `navigator.onLine` answers a different question — whether the OS thinks a
 * link exists — and it is wrong constantly: a captive-portal wifi with no
 * upstream, a phone holding a bar of signal that carries nothing, a VPN that
 * dropped. The only honest test is to try to reach the thing we need.
 *
 * Only a 2xx counts. A captive portal happily returns 200 with its own login
 * page, so this is not airtight either — that is why a failed mint is treated
 * as the stronger signal and can always override it.
 */
export async function probeResolver(timeoutMs = 4000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface MintOptions {
  position: Position;
  mode: SessionMode;
  subject: SessionSubject;
  note?: string;
  ttlSeconds?: number;
  /** Encoded sketch (see the protocol's sketch codec). Opaque to the server. */
  sketch?: string;
  /** LEGACY single-marker mirror — sent beside `markers` for old servers;
      a v2 server ignores it when `markers` is present. */
  marker?: Position;
  markerIcon?: MarkerIcon;
  /** All the spots the sharer marked — not where they are. Authoritative. */
  markers?: SessionMarker[];
}

export function mintSession(options: MintOptions): Promise<ApiResult<CreateSessionResponse>> {
  return request<CreateSessionResponse>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

/** One-way: a static session becomes joinable. Never the reverse. */
export function upgradeToLive(code: string, updateToken: string): Promise<ApiResult<void>> {
  return request<void>(`/v1/sessions/${code}`, {
    method: 'PATCH',
    body: JSON.stringify({ updateToken, mode: 'live' }),
  });
}

export interface ResolvedWithWarning extends ResolvedSession {
  warning?: string;
}

export function resolveSession(
  code: string,
  apiKey?: string,
): Promise<ApiResult<ResolvedWithWarning>> {
  return request<ResolvedWithWarning>(`/v1/sessions/${encodeURIComponent(code)}`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
}

export function updatePosition(
  code: string,
  updateToken: string,
  position: Position,
): Promise<ApiResult<void>> {
  return request<void>(`/v1/sessions/${encodeURIComponent(code)}`, {
    method: 'PATCH',
    body: JSON.stringify({ updateToken, position }),
  });
}

/**
 * Extend a running session. The server clamps so the cumulative lifetime
 * (createdAt → expiresAt) never exceeds 24h — at the cap, `expiresAt` comes
 * back unchanged. Callers read the response, never assume.
 */
export function extendSession(
  code: string,
  updateToken: string,
  addMinutes: number,
): Promise<ApiResult<{ expiresAt: string }>> {
  return request<{ expiresAt: string }>(`/v1/sessions/${encodeURIComponent(code)}/extend`, {
    method: 'POST',
    body: JSON.stringify({ updateToken, addMinutes }),
  });
}

/**
 * The VAPID public key for pushManager.subscribe(). A 404 means this
 * deployment has no push keypair — "push unavailable", not an error.
 */
export function getPushConfig(): Promise<ApiResult<{ vapidPublicKey: string }>> {
  return request<{ vapidPublicKey: string }>('/v1/push/config');
}

/**
 * Attach this device's push subscription to a session. No updateToken:
 * holding the code grants a subscription, same POC posture as joining the
 * live room. The subscription's endpoint identifies this device — it goes
 * to the resolver and nowhere else, and is never logged.
 */
export function registerPushSubscription(
  code: string,
  subscription: unknown,
): Promise<ApiResult<void>> {
  return request<void>(`/v1/sessions/${encodeURIComponent(code)}/push`, {
    method: 'POST',
    body: JSON.stringify({ subscription }),
  });
}

export function revokeSession(code: string, updateToken: string): Promise<ApiResult<void>> {
  return request<void>(`/v1/sessions/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    body: JSON.stringify({ updateToken }),
  });
}
