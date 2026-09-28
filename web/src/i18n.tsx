import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { LANG_COOKIE, LOCALES, isLang, messages, pickLanguage, textDirection, type Lang, type Messages } from '../../shared/i18n/index.ts';

export type LanguagePreference = Lang | 'auto';

const STORAGE_KEY = 'ebbwell.language';

export const deviceLanguage = (): Lang => pickLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);

function storedPreference(): LanguagePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'auto' || isLang(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

// The active language, for the formatting helpers that run outside React components.
let active: { lang: Lang; locale: string; t: Messages } = { lang: 'en', locale: LOCALES.en, t: messages('en') };
export const activeLocale = () => active.locale;
export const activeMessages = () => active.t;

interface I18n {
  lang: Lang;
  locale: string;
  t: Messages;
  /** Applies the user's saved preference (from their settings). */
  setPreference: (pref: LanguagePreference) => void;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // Remembered per device so the splash and lock screens appear in the right language before sign-in.
  const [pref, setPref] = useState<LanguagePreference>(storedPreference);
  const lang = pref === 'auto' ? deviceLanguage() : pref;

  const setPreference = useCallback((p: LanguagePreference) => {
    setPref(p);
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* private mode: preference lasts for this visit */
    }
  }, []);

  const value = useMemo(() => {
    active = { lang, locale: LOCALES[lang], t: messages(lang) };
    return { ...active, setPreference };
  }, [lang, setPreference]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = textDirection(lang);
    // Sign-in pages are rendered by the server; tell it which language to use.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  }, [lang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('I18nProvider missing');
  return v;
}

/** Shortcut for components that only need the messages. */
export const useT = (): Messages => useI18n().t;
