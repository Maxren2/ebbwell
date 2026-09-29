import { useSyncExternalStore } from 'react';

// Minimal History-API router: the app has a handful of flat routes.

// An invite link opened while signed out goes through the sign-in pages (and possibly the
// identity provider) and comes back to "/". The code is kept in this tab's sessionStorage
// meanwhile, so the invite reopens instead of being lost.
const INVITE_KEY = 'ebbwell:invite';
const INVITE_TTL_MS = 30 * 60_000;

/** Call once at startup, before the first render. */
export function keepPendingInvite() {
  try {
    if (location.pathname === '/invite' && location.hash.length > 1) {
      sessionStorage.setItem(INVITE_KEY, JSON.stringify({ code: location.hash.slice(1), at: Date.now() }));
      return;
    }
    const raw = sessionStorage.getItem(INVITE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(INVITE_KEY);
    const { code, at } = JSON.parse(raw) as { code?: unknown; at?: unknown };
    const fresh = typeof at === 'number' && Date.now() - at < INVITE_TTL_MS;
    if (fresh && typeof code === 'string' && location.pathname === '/') history.replaceState(null, '', `/invite#${code}`);
  } catch {
    /* storage unavailable: the partner opens the link again after signing in */
  }
}

/** The invite page has read the code: nothing left to resume. */
export function clearPendingInvite() {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    /* ignore */
  }
}

/** The element that scrolls the pages (the document itself doesn't scroll). */
export const SCROLLER_ID = 'scroller';

const listeners = new Set<() => void>();
/** Entries we pushed ourselves, so "back" never leaves the app. */
let depth = 0;

window.addEventListener('popstate', () => {
  depth = Math.max(0, depth - 1);
  listeners.forEach((l) => l());
});

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  if (path === location.pathname) return;
  if (opts.replace) {
    history.replaceState(null, '', path);
  } else {
    history.pushState(null, '', path);
    depth++;
  }
  listeners.forEach((l) => l());
  document.getElementById(SCROLLER_ID)?.scrollTo(0, 0);
}

export function goBack(fallback = '/') {
  if (depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}
