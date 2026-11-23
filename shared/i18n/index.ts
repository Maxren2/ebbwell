import { messagesFor, type Messages } from './catalog.ts';

export type { Messages } from './catalog.ts';

export const LANGUAGES = ['en', 'fr', 'de', 'sv', 'ar'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** Each language's name, written in that language (for the language picker). */
export const LANGUAGE_NAMES: Record<Lang, string> = { en: 'English', fr: 'Français', de: 'Deutsch', sv: 'Svenska', ar: 'العربية' };

/** Formatting locales. Arabic keeps Western digits, so dates match the numbers typed in forms. */
export const LOCALES: Record<Lang, string> = { en: 'en-GB', fr: 'fr', de: 'de', sv: 'sv-SE', ar: 'ar-u-nu-latn' };

/** Name of the cookie that carries the chosen language to the server-rendered pages. */
export const LANG_COOKIE = 'ebbwell_lang';

export const messages = (lang: Lang): Messages => messagesFor(lang);
export const textDirection = (lang: Lang): 'ltr' | 'rtl' => (lang === 'ar' ? 'rtl' : 'ltr');
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);

/** First supported language among BCP 47 tags in preference order ("fr-CH", "de", …); English otherwise. */
export function pickLanguage(tags: readonly string[]): Lang {
  for (const tag of tags) {
    const base = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

/** Languages from an Accept-Language header, by descending q-value. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .slice(0, 20)
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(params.find((x) => x.trim().startsWith('q='))?.trim().slice(2) ?? 1);
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}
