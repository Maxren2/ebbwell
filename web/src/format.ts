import { diffDays } from '../../shared/dates.ts';
import type { Range } from '../../shared/engine.ts';
import type { Settings } from '../../shared/schema.ts';
import { activeLocale, activeMessages } from './i18n.tsx';

const asDate = (d: string) => new Date(`${d}T12:00:00Z`);

export function fmtDate(date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  return asDate(date).toLocaleDateString(activeLocale(), { timeZone: 'UTC', ...opts });
}

export const fmtLong = (d: string) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtMonth = (d: string) => fmtDate(d, { month: 'long', year: 'numeric' });

/** A timestamp (ms) as a day, e.g. "3 Mar" or "3 Mar 2026". */
export const fmtDay = (ms: number, withYear = false) =>
  new Date(ms).toLocaleDateString(activeLocale(), { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });

/** A timestamp (ms) as day and time. */
export const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString(activeLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Short weekday names, Monday first. */
export function weekdayNames(): string[] {
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(activeLocale(), { weekday: 'short', timeZone: 'UTC' }));
}

export function fmtRange(r: Range): string {
  if (r.earliest === r.latest) return fmtDate(r.date);
  return `${fmtDate(r.earliest)} – ${fmtDate(r.latest)}`;
}

export function relDays(from: string, to: string): string {
  const t = activeMessages().rel;
  const n = diffDays(from, to);
  if (n === 0) return t.today;
  if (n === 1) return t.tomorrow;
  if (n === -1) return t.yesterday;
  return n > 0 ? t.inDays(n) : t.daysAgo(-n);
}

export function toDisplayTemp(celsius: number, unit: Settings['temperatureUnit']): number {
  return unit === 'F' ? Math.round((celsius * 9) / 5 * 100 + 3200) / 100 : Math.round(celsius * 100) / 100;
}

export function fromDisplayTemp(value: number, unit: Settings['temperatureUnit']): number {
  return unit === 'F' ? Math.round(((value - 32) * 5) / 9 * 1000) / 1000 : value;
}

export const fmtTemp = (celsius: number, unit: Settings['temperatureUnit']) =>
  `${toDisplayTemp(celsius, unit).toFixed(2)} °${unit}`;
