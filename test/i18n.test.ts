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
import { PARAM_NAMES, PLURAL_PATHS } from '../shared/i18n/bindings.ts';
import enCatalog from '../shared/i18n/locales/en.json' with { type: 'json' };
import frCatalog from '../shared/i18n/locales/fr.json' with { type: 'json' };
import deCatalog from '../shared/i18n/locales/de.json' with { type: 'json' };
import svCatalog from '../shared/i18n/locales/sv.json' with { type: 'json' };
import arCatalog from '../shared/i18n/locales/ar.json' with { type: 'json' };
import { SettingsSchema } from '../shared/schema.ts';

const RAW_CATALOGS: Record<(typeof LANGUAGES)[number], unknown> = {
  en: enCatalog,
  fr: frCatalog,
  de: deCatalog,
  sv: svCatalog,
  ar: arCatalog,
};
const pluralPathSet = new Set<string>(PLURAL_PATHS);
const helperPaths = new Set(['rel.inDays_today', 'rel.inDays_tomorrow']);
const customParameters: Record<string, string[]> = {
  'admin.connection_template': ['network', 'route', 'protocol'],
  'admin.sso_configured': ['url'],
  'admin.sso_notConfigured': ['url'],
  'chart.luteal': ['days'],
  'insights.sd': ['days'],
  'partner.ovulation_confirmed': ['date'],
  'partner.ovulation_expected': ['date'],
  'partner.sharedBy': ['name', 'items'],
  'partner.stats_none': ['mean', 'min', 'max'],
  'partner.stats_period': ['mean', 'min', 'max', 'periodMean'],
  'partner.stats_sd': ['mean', 'sd', 'min', 'max'],
  'partner.stats_both': ['mean', 'sd', 'min', 'max', 'periodMean'],
  'push.period': ['when'],
  'push.partner_named': ['when', 'name'],
  'push.partner_unnamed': ['when'],
};

function canonicalPath(path: string): string {
  const match = path.match(/_(zero|one|two|few|many|other)$/);
  const base = match ? path.slice(0, -match[0].length) : '';
  return base && pluralPathSet.has(base) ? base : path;
}

function rawStrings(value: unknown, path = '', result: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === 'string') {
    result.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => rawStrings(item, `${path}.${index}`, result));
  } else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      rawStrings(nested, path ? `${path}.${key}` : key, result);
    }
  }
  return result;
}

/** Every key path of a catalog; functions are leaves. */
function keys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

/** Calls every function in a catalog with sample arguments and collects the strings. */
function allStrings(value: unknown, path = ''): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') {
    const out: string[] = [];
    const booleans = new Set(['configured', 'confirmed', 'local', 'viaPublicUrl', 'secure']);
    const numbers = new Set(['n', 'day', 'firstHigh', 'left', 'min', 'max', 'mean', 'periodMean', 'sd', 'mb', 'pct', 's']);
    const names = (PARAM_NAMES as Readonly<Record<string, readonly string[]>>)[path] ?? [];
    for (const n of [0, 1, 2, 3, 5, 11, 100]) {
      const args = names.map((name) =>
        booleans.has(name) ? n % 2 === 1 : name === 'items' ? ['x', 'y'] : numbers.has(name) ? n : 'x',
      );
      const r = (value as (...a: unknown[]) => unknown)(...args);
      if (typeof r === 'string') out.push(r);
    }
    return out;
  }
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).flatMap(([k, v]) => allStrings(v, path ? `${path}.${k}` : k));
  return [];
}

describe('translations', () => {
  const reference = keys(messages('en')).sort();

  it.each(LANGUAGES.filter((l) => l !== 'en'))('%s has exactly the English keys', (lang) => {
    // Covers the lookup tables (events, errors…) that the Messages type cannot check key by key.
    expect(keys(messages(lang)).sort()).toEqual(reference);
    expect(messages(lang).insights.how).toHaveLength(messages('en').insights.how.length);
  });

  it('keeps raw locale keys, placeholders, and plural categories valid', () => {
    const publicKeys = (entries: Array<[string, string]>) =>
      [...new Set(entries.map(([path]) => canonicalPath(path)).filter((path) => !helperPaths.has(path)))].sort();
    const englishKeys = publicKeys(rawStrings(RAW_CATALOGS.en));
    const paramsByPath = PARAM_NAMES as Readonly<Record<string, readonly string[]>>;

    for (const lang of LANGUAGES) {
      const catalog = RAW_CATALOGS[lang];
      const entries = rawStrings(catalog);
      expect(publicKeys(entries)).toEqual(englishKeys);

      for (const [path, template] of entries) {
        expect(template.trim(), `${lang}:${path} must not be empty`).not.toBe('');
        const canonical = canonicalPath(path);
        const allowed = new Set(customParameters[canonical] ?? paramsByPath[canonical] ?? []);
        if (pluralPathSet.has(canonical)) allowed.add('count');
        expect(template.replace(/\{\{\w+\}\}/g, '')).not.toMatch(/\{\{|\}\}/);
        for (const [, placeholder] of template.matchAll(/\{\{(\w+)\}\}/g)) {
          if (placeholder) {
            expect(allowed.has(placeholder), `${lang}:${path} has unknown placeholder {{${placeholder}}}`).toBe(true);
          }
        }
      }

      const pluralCategories = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
      for (const path of PLURAL_PATHS) {
        const parts = path.split('.');
        const leaf = parts.pop()!;
        const parent = parts.reduce<unknown>((value, key) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, catalog);
        if (!parent || typeof parent !== 'object') continue;
        const value = (parent as Record<string, unknown>)[leaf];
        if (typeof value === 'string') continue;
        const forms = Object.keys(parent).map((key) => key.startsWith(`${leaf}_`) ? key.slice(leaf.length + 1) : '');
        expect(forms).toEqual(expect.arrayContaining(pluralCategories));
      }
    }
  });

  it.each(LANGUAGES)('%s produces complete strings', (lang) => {
    for (const s of allStrings(messages(lang))) {
      expect(s).not.toMatch(/#|undefined|\[object/);
    }
  });

  it('uses the right plural forms', () => {
    expect(messages('en').common.days(1)).toBe('1 day');
    expect(messages('en').common.days(3)).toBe('3 days');
    expect(messages('en').chart.luteal(3)).toBe(' Luteal phase 3 days.');
    expect(messages('en').insights.sd(3)).toBe('± 3 days (SD)');
    expect(messages('fr').common.days(0)).toBe('0 jour');
    expect(messages('de').rel.inDays(2)).toBe('in 2 Tagen');
    expect(messages('sv').common.days(1)).toBe('1 dag');
    expect(messages('sv').common.days(3)).toBe('3 dagar');
    expect(messages('sv').rel.inDays(2)).toBe('om 2 dagar');
    expect(messages('ar').common.days(2)).toBe('يومان');
    expect(messages('ar').common.days(5)).toBe('5 أيام');
    expect(messages('ar').common.days(14)).toBe('14 يومًا');
    expect(messages('ar').today.phase.late(3)).toBe('الحيض متأخر 3 يوم');
    expect(messages('ar').rel.daysAgo(3)).toBe('قبل 3 أيام');
  });

  it('negotiates the language from browser preferences', () => {
    expect(parseAcceptLanguage('de-CH,de;q=0.9,fr;q=0.8,en;q=0.5')).toEqual(['de-CH', 'de', 'fr', 'en']);
    expect(parseAcceptLanguage('en;q=0.2, ar-MA')).toEqual(['ar-MA', 'en']);
    expect(pickLanguage(parseAcceptLanguage('it-CH, fr-CH;q=0.7'))).toBe('fr');
    expect(pickLanguage(parseAcceptLanguage('sv-SE, en;q=0.8'))).toBe('sv');
    expect(pickLanguage(['ja'])).toBe('en');
  });

  it('stores the language preference with the settings', () => {
    expect(SettingsSchema.parse({}).language).toBe('auto');
    expect(SettingsSchema.parse({ language: 'ar' }).language).toBe('ar');
    expect(SettingsSchema.parse({ language: 'sv' }).language).toBe('sv');
    expect(SettingsSchema.safeParse({ language: 'xx' }).success).toBe(false);
  });

  it('writes reminders in the requested language', () => {
    expect(reminderText('period', false, { days: 2 }, 'fr')).toBe('Vos règles sont prévues dans 2 jours');
    expect(reminderText('partner', false, { days: 1, name: 'Alice' }, 'de')).toBe('Die Periode von Alice wird morgen erwartet');
    expect(reminderText('period', false, { days: 2 }, 'sv')).toBe('Din mens förväntas om 2 dagar');
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

  it('renders Swedish sign-in pages', async () => {
    const res = await get('/auth/login', { 'accept-language': 'sv-SE,sv;q=0.9' });
    expect(res.body).toContain('<html lang="sv" dir="ltr">');
    expect(res.body).toContain('Logga in på Ebbwell');
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
