// Web Push reminders. Payloads are end-to-end encrypted to the device (RFC 8291), so
// Apple/Google push services can't read them; "discreet" wording (default) also keeps
// the lock screen generic.

import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diffDays } from '../shared/dates.ts';
import { analyze, type Analysis } from '../shared/engine.ts';
import { messages, type Lang } from '../shared/i18n/index.ts';
import type { Settings } from '../shared/schema.ts';
import type { Config } from './config.ts';
import { sha256 } from './crypto.ts';
import type { PushSubscriptionRow, Store } from './db.ts';
import { settingsLang } from './i18n.ts';

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
}

export type PushResult = 'ok' | 'gone' | 'error';
export type PushSender = (subscription: PushSubscriptionRow['subscription'], payload: PushPayload) => Promise<PushResult>;

/** Late reminders (e.g. after downtime) are still sent within this window, never later. */
const DUE_WINDOW_MIN = 180;

export function vapidKeys(store: Store, config: Config): { publicKey: string; privateKey: string } {
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    return { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
  }
  const stored = store.getMeta('vapid');
  if (stored) return JSON.parse(stored) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  store.setMeta('vapid', JSON.stringify(keys));
  return keys;
}

export function webPushSender(keys: { publicKey: string; privateKey: string }, subject: string): PushSender {
  return async (subscription, payload) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: 6 * 3600,
        urgency: 'normal',
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
      });
      return 'ok';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      // Log the push service's answer only (no endpoint or payload: both are personal data).
      console.warn(`Push delivery failed: ${status ?? ''} ${(err as Error).message.split('\n')[0]}`);
      return 'error';
    }
  };
}

export async function sendToUser(store: Store, send: PushSender, userId: string, payload: PushPayload): Promise<number> {
  let delivered = 0;
  for (const sub of store.listPushSubscriptions(userId)) {
    const result = await send(sub.subscription, payload);
    if (result === 'ok') {
      delivered++;
      store.markPushSuccess(sub.id);
    } else if (result === 'gone') {
      store.deletePushSubscription(sub.id);
    }
  }
  return delivered;
}

// ------------------------------------------------------------------ reminders

function localNow(now: Date, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

export function reminderText(
  kind: 'temperature' | 'log' | 'period' | 'fertile' | 'partner',
  discreet: boolean,
  detail: { days?: number; name?: string } = {},
  lang: Lang = 'en',
): string {
  const t = messages(lang).push;
  if (discreet) {
    if (kind === 'temperature') return t.morningDiscreet;
    if (kind === 'log') return t.eveningDiscreet;
    return t.generic;
  }
  switch (kind) {
    case 'temperature':
      return t.temperature;
    case 'log':
      return t.log;
    case 'period':
      return t.period(detail.days ?? 0);
    case 'fertile':
      return t.fertile;
    case 'partner':
      return t.partner(detail.name, detail.days ?? 0);
  }
}

/** Runs every minute: sends each due reminder once (idempotent through notification_log). */
export async function runReminders(store: Store, send: PushSender, now: Date = new Date()): Promise<number> {
  let sent = 0;
  const analyses = new Map<string, { analysis: Analysis; settings: Settings }>();
  const analysisFor = (userId: string, today: string) => {
    const key = `${userId}|${today}`;
    let a = analyses.get(key);
    if (!a) {
      const settings = store.getSettings(userId);
      a = { analysis: analyze(store.listDays(userId), settings, today), settings };
      analyses.set(key, a);
    }
    return a;
  };

  for (const userId of store.usersWithPushSubscriptions()) {
    try {
      const settings = store.getSettings(userId);
      const n = settings.notifications;
      const lang = settingsLang(settings);
      const { date, minutes } = localNow(now, n.timezone);
      const due = (hhmm: string) => minutes >= toMinutes(hhmm) && minutes < toMinutes(hhmm) + DUE_WINDOW_MIN;
      const notify = async (kind: string, key: string, payload: Omit<PushPayload, 'title'>) => {
        if (!store.claimNotification(userId, kind, key)) return;
        if ((await sendToUser(store, send, userId, { title: 'Ebbwell', ...payload })) > 0) sent++;
      };
      // Partner-only accounts don't track a cycle of their own.
      const own = settings.mode === 'own';

      if (own && n.temperature.enabled && settings.track.temperature && due(n.temperature.time)) {
        if (!store.getDay(userId, date)?.temperature) {
          await notify('temperature', date, { body: reminderText('temperature', n.discreet, {}, lang), tag: 'temperature', url: `/day/${date}` });
        }
      }
      if (own && n.log.enabled && due(n.log.time)) {
        const day = store.getDay(userId, date);
        if (!day?.mucus && !day?.symptoms?.length && !day?.mood?.length) {
          await notify('log', date, { body: reminderText('log', n.discreet, {}, lang), tag: 'log', url: `/day/${date}` });
        }
      }

      if (due(n.time)) {
        if (own && !settings.paused && !settings.hormonalContraception && (n.period.enabled || n.fertile.enabled)) {
          const { analysis } = analysisFor(userId, date);
          const next = analysis.predictions[1]?.start.date;
          if (n.period.enabled && next && !analysis.current?.inPeriod && diffDays(date, next) === n.period.daysBefore) {
            await notify('period', next, {
              body: reminderText('period', n.discreet, { days: n.period.daysBefore }, lang),
              tag: 'period',
              url: '/',
            });
          }
          const cur = analysis.predictions[0];
          const confirmed = analysis.cycles.at(-1)?.ovulation?.confirmed;
          // The calendar forecast of the fertile days is not announced where the app does not show it.
          if (n.fertile.enabled && settings.goal !== 'track' && !analysis.forecastHidden && cur && !confirmed && date === cur.fertileStart) {
            await notify('fertile', cur.fertileStart, { body: reminderText('fertile', n.discreet, {}, lang), tag: 'fertile', url: '/' });
          }
        }

        if (n.partner.enabled) {
          for (const share of store.sharesAsPartner(userId)) {
            const owner = analysisFor(share.ownerId, date);
            if (owner.settings.paused || owner.settings.hormonalContraception) continue;
            const next = owner.analysis.predictions[1]?.start.date;
            if (!next || owner.analysis.current?.inPeriod || diffDays(date, next) !== n.partner.daysBefore) continue;
            const name = store.getUser(share.ownerId)?.name.split(' ')[0];
            await notify(`partner:${share.id}`, next, {
              body: reminderText('partner', n.discreet, { days: n.partner.daysBefore, name }, lang),
              tag: `partner-${share.id}`,
              url: `/partner/${share.id}`,
            });
          }
        }
      }
    } catch (err) {
      // One user's broken settings must not stop everyone else's reminders.
      console.error('reminders failed for a user', (err as Error).message);
    }
  }
  store.purgeNotificationLog(now.getTime() - 90 * 86_400_000);
  return sent;
}

// ------------------------------------------------------------------ routes

const SubscriptionSchema = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith('https://'), 'Push endpoints must be https'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

export function registerPushRoutes(app: FastifyInstance, deps: { store: Store; publicKey: string; send: PushSender }) {
  const { store, publicKey, send } = deps;

  app.get('/api/push', async (request) => ({
    publicKey,
    devices: store.listPushSubscriptions(request.user!.id).map((s) => ({ id: s.id.slice(0, 16), createdAt: s.createdAt, userAgent: s.userAgent })),
  }));

  app.post('/api/push/subscribe', async (request, reply) => {
    const body = z.object({ subscription: SubscriptionSchema }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    const sub = body.data.subscription;
    const id = sha256(sub.endpoint);
    store.savePushSubscription(id, request.user!.id, { endpoint: sub.endpoint, keys: sub.keys }, request.headers['user-agent'] ?? '');
    store.audit(request.user!.id, 'push-subscribed');
    return { id: id.slice(0, 16) };
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const body = z.object({ endpoint: z.string().max(1000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid' });
    store.deletePushSubscription(sha256(body.data.endpoint), request.user!.id);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>('/api/push/devices/:id', async (request, reply) => {
    const match = store.listPushSubscriptions(request.user!.id).find((s) => s.id.slice(0, 16) === request.params.id);
    if (match) store.deletePushSubscription(match.id, request.user!.id);
    return reply.code(204).send();
  });

  app.post('/api/push/test', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const delivered = await sendToUser(store, send, request.user!.id, {
      title: 'Ebbwell',
      body: messages(settingsLang(store.getSettings(request.user!.id))).push.test,
      tag: 'test',
      url: '/settings',
    });
    return { delivered };
  });
}

