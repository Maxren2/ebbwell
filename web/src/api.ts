import type { DayData, DayEntry, Settings } from '../../shared/schema.ts';

export interface Me {
  name: string;
  settings: Settings;
  authMode: 'oidc' | 'dev';
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string;
  current: boolean;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-lune-csrf': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (res.status === 401) {
    // Full-page redirect (not a popup) so the login works inside installed iOS apps.
    window.location.assign('/auth/login');
    throw new ApiError(401, 'Signing in…');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (err as { error?: string }).error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  days: () => request<DayEntry[]>('GET', '/api/days'),
  saveDay: (date: string, data: DayData) => request<DayEntry>('PUT', `/api/days/${date}`, { data }),
  deleteDay: (date: string) => request<void>('DELETE', `/api/days/${date}`),
  saveSettings: (s: Settings) => request<Settings>('PUT', '/api/settings', s),
  importData: (payload: unknown) => request<{ imported: number }>('POST', '/api/import', payload),
  sessions: () => request<SessionInfo[]>('GET', '/api/sessions'),
  revokeSession: (id: string) => request<void>('DELETE', `/api/sessions/${id}`),
  audit: () => request<{ at: number; event: string }[]>('GET', '/api/audit'),
  deleteAccount: () => request<{ redirect: string }>('DELETE', '/api/account', { confirm: 'DELETE' }),
  logout: () => request<{ redirect: string }>('POST', '/auth/logout'),
};
