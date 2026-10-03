/// <reference lib="webworker" />
// Service worker: precaches the app shell only (never API responses) and shows push reminders.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//, /^\/auth\//, /^\/healthz/, /^\/signed-out\.html/],
  }),
);

interface Payload {
  title?: string;
  body?: string;
  tag?: string;
  url?: string;
}

self.addEventListener('push', (event) => {
  let data: Payload = {};
  try {
    data = (event.data?.json() ?? {}) as Payload;
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'Ebbwell', {
      body: data.body ?? 'A gentle reminder from Ebbwell',
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url ?? '/' },
    }),
  );
});

// The browser may replace a subscription (expired or rotated keys): register the new one, or
// reminders stop until the app is opened again.
interface SubscriptionChange extends ExtendableEvent {
  oldSubscription?: PushSubscription | null;
  newSubscription?: PushSubscription | null;
}

self.addEventListener('pushsubscriptionchange', (e) => {
  const event = e as SubscriptionChange;
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options.applicationServerKey;
      const sub =
        event.newSubscription ?? (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!sub) return;
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-ebbwell-csrf': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
    })().catch(() => {}),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data as { url?: string })?.url ?? '/', self.location.origin);
  // Only ever navigate within the app.
  const url = target.origin === self.location.origin ? target.href : self.location.origin;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        return existing.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
