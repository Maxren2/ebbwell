import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { Cipher } from '../server/crypto.ts';
import { Store } from '../server/db.ts';
import { reminderText } from '../server/push.ts';
import { LANGUAGES, messages, parseAcceptLanguage, pickLanguage } from '../shared/i18n/index.ts';
import { SettingsSchema } from '../shared/schema.ts';

/** Every key path of a catalog; functions are leaves. */
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

/** Calls every function in a catalog with sample arguments and collects the strings. */
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const out: string[] = [];
    for (const n of [0, 1, 2, 3, 5, 11, 100]) {
      const args = Array.from({ length: value.length }, (_, i) => (i === 0 ? n : i % 2 ? 'x' : n));
      const r = (value as (...a: unknown[]) => unknown)(...args);
      if (typeof r === 'string') out.push(r);
    }
    return out;
  }
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(allStrings);
  return [];
}

describe('translations', () => {
  const reference = keys(messages('en')).sort();

  it.each(LANGUAGES.filter((l) => l !== 'en'))('%s has exactly the English keys', (lang) => {
    // Covers the lookup tables (events, errors…) that the Messages type cannot check key by key.
    expect(keys(messages(lang)).sort()).toEqual(reference);
    expect(messages(lang).insights.how).toHaveLength(messages('en').insights.how.length);
  });

  it.each(LANGUAGES)('%s produces complete strings', (lang) => {
    for (const s of allStrings(messages(lang))) {
      expect(s).not.toMatch(/#|undefined|\[object/);
    }
  });

  it('uses the right plural forms', () => {
    expect(messages('en').common.days(1)).toBe('1 day');
    expect(messages('en').common.days(3)).toBe('3 days');
    expect(messages('fr').common.days(0)).toBe('0 jour');
    expect(messages('de').rel.inDays(2)).toBe('in 2 Tagen');
    expect(messages('ar').common.days(2)).toBe('يومان');
    expect(messages('ar').common.days(5)).toBe('5 أيام');
    expect(messages('ar').common.days(14)).toBe('14 يومًا');
  });

  it('negotiates the language from browser preferences', () => {
    expect(parseAcceptLanguage('de-CH,de;q=0.9,fr;q=0.8,en;q=0.5')).toEqual(['de-CH', 'de', 'fr', 'en']);
    expect(parseAcceptLanguage('en;q=0.2, ar-MA')).toEqual(['ar-MA', 'en']);
    expect(pickLanguage(parseAcceptLanguage('it-CH, fr-CH;q=0.7'))).toBe('fr');
    expect(pickLanguage(['ja'])).toBe('en');
  });

  it('stores the language preference with the settings', () => {
    expect(SettingsSchema.parse({}).language).toBe('auto');
    expect(SettingsSchema.parse({ language: 'ar' }).language).toBe('ar');
    expect(SettingsSchema.safeParse({ language: 'xx' }).success).toBe(false);
  });

  it('writes reminders in the requested language', () => {
    expect(reminderText('period', false, { days: 2 }, 'fr')).toBe('Vos règles sont prévues dans 2 jours');
    expect(reminderText('partner', false, { days: 1, name: 'Alice' }, 'de')).toBe('Die Periode von Alice wird morgen erwartet');
    expect(reminderText('temperature', true, {}, 'en')).toBe('Time for your morning check-in');
  });
});

describe('server-rendered pages', () => {
  let dir: string;
  let store: Store;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ebbwell-'));
    const config = loadConfig({
      APP_URL: 'http://192.168.1.10:30504',
      DATA_DIR: dir,
      STATIC_DIR: join(dir, 'none'),
      DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      LOCAL_LOGIN: 'local-network',
      LOG_LEVEL: 'fatal',
    });
    const cipher = new Cipher(config.DATA_ENCRYPTION_KEY);
    store = new Store(join(dir, 'ebbwell.sqlite'), cipher);
    app = await buildApp({ config, store, cipher, push: { publicKey: 'k', send: async () => 'ok' } });
  });

  afterAll(async () => {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, remoteAddress: '192.168.1.20', headers: { host: '192.168.1.10:30504', ...headers } });

  it('follows the browser language by default', async () => {
    const res = await get('/auth/login', { 'accept-language': 'fr-CH,fr;q=0.9,en;q=0.8' });
    expect(res.body).toContain('<html lang="fr" dir="ltr">');
    expect(res.body).toContain('Se connecter à Ebbwell');
    expect(res.body).toContain('action="/auth/local"');
  });

  it("prefers the language chosen in the app, and renders Arabic right-to-left", async () => {
    const res = await get('/auth/login', { 'accept-language': 'de', cookie: 'ebbwell_lang=ar' });
    expect(res.body).toContain('<html lang="ar" dir="rtl">');
    expect(res.body).toContain('تسجيل الدخول إلى Ebbwell');
  });

  it('falls back to English and ignores unknown values', async () => {
    const res = await get('/auth/login', { 'accept-language': 'ja', cookie: 'ebbwell_lang=<script>' });
    expect(res.body).toContain('<html lang="en" dir="ltr">');
    expect(res.body).toContain('Sign in to Ebbwell');
  });

  it('translates the signed-out page', async () => {
    const res = await get('/signed-out.html', { 'accept-language': 'de' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Abgemeldet');
  });
});
