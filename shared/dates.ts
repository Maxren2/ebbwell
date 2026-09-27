// Calendar dates are plain "YYYY-MM-DD" strings. All arithmetic goes through
// UTC epoch days, so it is immune to time zones and DST changes.

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return fromEpochDay(toEpochDay(value)) === value;
}

export function toEpochDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

export function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Number of days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return toEpochDay(b) - toEpochDay(a);
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Today's date in the device's local time zone. */
export function localToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = toEpochDay(from), end = toEpochDay(to); d <= end; d++) out.push(fromEpochDay(d));
  return out;
}
