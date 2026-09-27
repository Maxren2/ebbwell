import { diffDays } from '../../shared/dates.ts';
import type { Confidence, OvulationMethod, Range } from '../../shared/engine.ts';
import type { Settings } from '../../shared/schema.ts';

const LOCALE = 'en-GB';

const asDate = (d: string) => new Date(`${d}T12:00:00Z`);

export function fmtDate(date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  return asDate(date).toLocaleDateString(LOCALE, { timeZone: 'UTC', ...opts });
}

export const fmtLong = (d: string) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long' });
export const fmtWeekday = (d: string) => fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtMonth = (d: string) => fmtDate(d, { month: 'long', year: 'numeric' });

export function fmtRange(r: Range): string {
  if (r.earliest === r.latest) return fmtDate(r.date);
  return `${fmtDate(r.earliest)} – ${fmtDate(r.latest)}`;
}

export function relDays(from: string, to: string): string {
  const n = diffDays(from, to);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

export function toDisplayTemp(celsius: number, unit: Settings['temperatureUnit']): number {
  return unit === 'F' ? Math.round((celsius * 9) / 5 * 100 + 3200) / 100 : Math.round(celsius * 100) / 100;
}

export function fromDisplayTemp(value: number, unit: Settings['temperatureUnit']): number {
  return unit === 'F' ? Math.round(((value - 32) * 5) / 9 * 1000) / 1000 : value;
}

export const fmtTemp = (celsius: number, unit: Settings['temperatureUnit']) =>
  `${toDisplayTemp(celsius, unit).toFixed(2)} °${unit}`;

export const CONFIDENCE: Record<Confidence, string> = {
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};

export const METHOD: Record<OvulationMethod, string> = {
  'temperature+mucus': 'confirmed by temperature and mucus',
  temperature: 'confirmed by temperature',
  mucus: 'estimated from the mucus peak',
  lh: 'estimated from a positive LH test',
};

export const WARNINGS: Record<string, { title: string; body: string }> = {
  'few-cycles': {
    title: 'Still learning your cycle',
    body: 'Predictions use averages until at least 3 complete cycles are logged. Log every period start to improve them.',
  },
  irregular: {
    title: 'Your cycles vary a lot',
    body: 'Your shortest and longest recent cycles differ by more than 9 days. Calendar predictions are unreliable; temperature and mucus observations give a much better picture. If this persists, consider talking to a clinician.',
  },
  frequent: {
    title: 'Cycles shorter than usual',
    body: 'Your average cycle is under 24 days, outside the usual 24–38 day range (FIGO). Consider mentioning it to a clinician.',
  },
  infrequent: {
    title: 'Cycles longer than usual',
    body: 'Your average cycle is over 38 days, outside the usual 24–38 day range (FIGO). Consider mentioning it to a clinician.',
  },
  'implausible-cycle': {
    title: 'A cycle looks unusual',
    body: 'One cycle is longer than 90 days. Check for a missing period entry, or exclude that cycle in Insights.',
  },
};

export const LABELS = {
  bleeding: { spotting: 'Spotting', light: 'Light', medium: 'Medium', heavy: 'Heavy' },
  disturbances: {
    sleep: 'Short / bad sleep',
    time: 'Measured at another time',
    alcohol: 'Alcohol',
    illness: 'Ill / fever',
    travel: 'Travel / time zone',
    stress: 'Stress',
    medication: 'Medication',
  },
  sensation: { dry: 'Dry', nothing: 'Nothing felt', moist: 'Moist', wet: 'Wet / slippery' },
  appearance: { none: 'Nothing seen', creamy: 'Creamy / sticky', eggwhite: 'Clear / stretchy' },
  symptoms: {
    cramps: 'Cramps', headache: 'Headache', migraine: 'Migraine', backache: 'Backache', breast_tenderness: 'Tender breasts',
    bloating: 'Bloating', acne: 'Acne', nausea: 'Nausea', fatigue: 'Fatigue', cravings: 'Cravings', insomnia: 'Insomnia',
    diarrhea: 'Diarrhoea', constipation: 'Constipation', ovulation_pain: 'Ovulation pain', hot_flashes: 'Hot flashes',
    dizziness: 'Dizziness',
  },
  mood: {
    happy: 'Happy', calm: 'Calm', energetic: 'Energetic', sensitive: 'Sensitive', irritable: 'Irritable', anxious: 'Anxious',
    sad: 'Sad', low_energy: 'Low energy', stressed: 'Stressed',
  },
} as const;
