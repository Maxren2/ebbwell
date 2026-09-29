import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import type { PartnerView, ShareScope } from '../../shared/partner.ts';
import type { DayData, DayEntry, Settings } from '../../shared/schema.ts';
import { setDeviceBiometric } from './device.ts';

export interface Me {
  name: string;
  settings: Settings;
  authMode: 'standard' | 'dev';
  oidc: boolean;
  /** Where feedback goes, or null when the administrator turned it off. */
  feedbackUrl: string | null;
  account: {
    kind: 'oidc' | 'local' | 'dev';
    username: string | null;
    isAdmin: boolean;
    mustChangePassword: boolean;
    twoFactor: boolean;
    twoFactorSetupRequired: boolean;
  };
}

export interface AdminUser {
  id: string;
  name: string;
  username: string | null;
  kind: 'oidc' | 'local' | 'dev';
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  locked: boolean;
  twoFactor: boolean;
  self: boolean;
}

export interface AccessReport {
  policy: {
    localLogin: 'disabled' | 'local-network' | 'everywhere';
    localNetworks: string[];
    twoFactor: 'optional' | 'required';
    oidc: boolean;
    publicUrl: string;
  };
  thisConnection: { addresses: string[]; local: boolean; viaPublicUrl: boolean; secure: boolean; localLoginAllowed: boolean };
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent: string;
  current: boolean;
}

export interface LockStatus {
  enabled: boolean;
  locked: boolean;
  timeoutSec: number | null;
  biometrics: boolean;
  canReset: boolean;
  credentials: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
}

export interface ShareSummary {
  id: string;
  name: string;
  scopes: ShareScope[];
  createdAt: number;
}

export interface SharesInfo {
  asOwner: ShareSummary[];
  asPartner: ShareSummary[];
  invites: { id: string; scopes: ShareScope[]; expiresAt: number }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Fired when the server reports the session as locked (423); the app then shows the lock screen. */
export const LOCKED_EVENT = 'ebbwell:locked';

async function request<T>(method: string, url: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-ebbwell-csrf': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
    keepalive: opts.keepalive,
  });
  if (res.status === 401) {
    // Full-page redirect (not a popup) so the login works inside installed iOS apps.
    window.location.assign('/auth/login');
    throw new ApiError(401, 'Signing in…');
  }
  if (res.status === 403 && url.startsWith('/api/')) {
    const err = (await res.clone().json().catch(() => ({}))) as { error?: string };
    if (err.error === 'password-change-required') {
      window.location.assign('/auth/password');
      throw new ApiError(403, 'password-change-required');
    }
    if (err.error === '2fa-setup-required') {
      window.location.assign('/auth/2fa/setup');
      throw new ApiError(403, '2fa-setup-required');
    }
  }
  if (res.status === 423) {
    window.dispatchEvent(new Event(LOCKED_EVENT));
    throw new ApiError(423, 'locked');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(res.status, (err.error as string | undefined) ?? res.statusText, err);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Leaves the app after the session has ended (signed-out page or the identity provider's logout). */
export function leaveApp(redirect: string) {
  setDeviceBiometric(false); // the next person on this device must not get the biometric button
  location.replace(redirect);
}

/** Ends the session on the server, then leaves the app. */
export async function signOut() {
  const { redirect } = await api.logout();
  leaveApp(redirect);
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
  ping: () => request<void>('POST', '/api/ping'),

  lock: {
    status: () => request<LockStatus>('GET', '/api/lock'),
    set: (pin: string, timeoutSec: number, currentPin?: string) => request<void>('PUT', '/api/lock', { pin, timeoutSec, currentPin }),
    setTimeout: (timeoutSec: number) => request<void>('PATCH', '/api/lock', { timeoutSec }),
    remove: (pin: string) => request<void>('DELETE', '/api/lock', { pin }),
    lockNow: (keepalive = false) => request<void>('POST', '/api/lock/lock', undefined, { keepalive }),
    unlock: (pin: string) => request<void>('POST', '/api/lock/unlock', { pin }),
    registerOptions: () => request<PublicKeyCredentialCreationOptionsJSON>('POST', '/api/lock/webauthn/register/options'),
    registerVerify: (response: unknown, name: string) => request<{ id: string }>('POST', '/api/lock/webauthn/register/verify', { response, name }),
    removeCredential: (id: string) => request<void>('DELETE', `/api/lock/webauthn/${encodeURIComponent(id)}`),
    unlockOptions: () => request<PublicKeyCredentialRequestOptionsJSON>('POST', '/api/lock/webauthn/unlock/options'),
    unlockVerify: (response: unknown) => request<void>('POST', '/api/lock/webauthn/unlock/verify', { response }),
  },

  push: {
    info: () => request<{ publicKey: string; devices: { id: string; createdAt: number; userAgent: string }[] }>('GET', '/api/push'),
    subscribe: (subscription: PushSubscriptionJSON) => request<{ id: string }>('POST', '/api/push/subscribe', { subscription }),
    unsubscribe: (endpoint: string) => request<void>('POST', '/api/push/unsubscribe', { endpoint }),
    removeDevice: (id: string) => request<void>('DELETE', `/api/push/devices/${id}`),
    test: () => request<{ delivered: number }>('POST', '/api/push/test'),
  },

  account: {
    changePassword: (current: string, password: string, confirm: string) =>
      request<void>('POST', '/api/account/password', { current, password, confirm }),
    twoFactor: () =>
      request<{ available: boolean; enabled: boolean; required: boolean; recoveryCodesLeft: number; enabledAt: number | null }>('GET', '/api/account/2fa'),
    renewRecoveryCodes: (password: string, code: string) => request<{ codes: string[] }>('POST', '/api/account/2fa/recovery-codes', { password, code }),
    disableTwoFactor: (password: string, code: string) => request<void>('POST', '/api/account/2fa/disable', { password, code }),
  },

  admin: {
    users: () => request<AdminUser[]>('GET', '/api/admin/users'),
    access: () => request<AccessReport>('GET', '/api/admin/access'),
    createUser: (username: string, name: string, isAdmin: boolean) =>
      request<{ id: string; temporaryPassword: string }>('POST', '/api/admin/users', { username, name, isAdmin }),
    resetPassword: (id: string) => request<{ temporaryPassword: string }>('POST', `/api/admin/users/${id}/reset-password`),
    resetTwoFactor: (id: string) => request<void>('POST', `/api/admin/users/${id}/reset-2fa`),
    update: (id: string, patch: { disabled?: boolean; isAdmin?: boolean }) => request<void>('PATCH', `/api/admin/users/${id}`, patch),
    remove: (id: string) => request<void>('DELETE', `/api/admin/users/${id}`),
  },

  shares: {
    list: () => request<SharesInfo>('GET', '/api/shares'),
    invite: (scopes: ShareScope[]) => request<{ code: string; url: string; expiresAt: number }>('POST', '/api/shares/invites', { scopes }),
    revokeInvite: (id: string) => request<void>('DELETE', `/api/shares/invites/${id}`),
    preview: (code: string) => request<{ name: string; scopes: ShareScope[]; expiresAt: number; own: boolean }>('POST', '/api/shares/invites/preview', { code }),
    accept: (code: string) => request<{ id: string }>('POST', '/api/shares/accept', { code }),
    update: (id: string, scopes: ShareScope[]) => request<void>('PUT', `/api/shares/${id}`, { scopes }),
    end: (id: string) => request<void>('DELETE', `/api/shares/${id}`),
    view: (id: string, today: string) => request<PartnerView>('GET', `/api/shares/${id}/view?today=${today}`),
  },
};
