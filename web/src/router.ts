import { useSyncExternalStore } from 'react';

// Minimal History-API router: the app has a handful of flat routes.

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
  window.scrollTo(0, 0);
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
