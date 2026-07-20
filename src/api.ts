import type {
  CreateSessionResponse,
  Position,
  ResolvedSession,
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

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
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

export interface MintOptions {
  position: Position;
  mode: SessionMode;
  subject: SessionSubject;
  note?: string;
  ttlSeconds?: number;
}

export function mintSession(options: MintOptions): Promise<ApiResult<CreateSessionResponse>> {
  return request<CreateSessionResponse>('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(options),
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

export function revokeSession(code: string, updateToken: string): Promise<ApiResult<void>> {
  return request<void>(`/v1/sessions/${encodeURIComponent(code)}`, {
    method: 'DELETE',
    body: JSON.stringify({ updateToken }),
  });
}
