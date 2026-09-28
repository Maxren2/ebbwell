import type { FastifyRequest } from 'fastify';
import { LANG_COOKIE, isLang, parseAcceptLanguage, pickLanguage, type Lang } from '../shared/i18n/index.ts';
import type { Settings } from '../shared/schema.ts';

/** Language of a server-rendered page: the app's choice (cookie), then the browser's languages. */
export function requestLang(request: FastifyRequest): Lang {
  const chosen = request.cookies?.[LANG_COOKIE];
  if (isLang(chosen)) return chosen;
  return pickLanguage(parseAcceptLanguage(request.headers['accept-language']));
}

/** Language for texts sent to a user while they are away (reminders). */
export const settingsLang = (s: Settings): Lang => (s.language === 'auto' ? s.notifications.language : s.language);
