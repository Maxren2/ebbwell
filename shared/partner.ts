// What a partner is allowed to see. The owner's full data never leaves the server:
// the analysis runs on everything (so ovulation confirmation stays accurate), then
// only the fields covered by the granted scopes are returned.

import type { Analysis, Confidence, Ovulation, Range, Regularity } from './engine.ts';
import type { DayData, DayEntry } from './schema.ts';

/** Period predictions and the current cycle day are always shared. */
export const SHARE_SCOPES = ['fertility', 'history', 'wellbeing'] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];

export const SCOPE_LABELS: Record<ShareScope, { title: string; body: string }> = {
  fertility: { title: 'Fertility', body: 'Fertile window, ovulation, temperature, mucus and LH tests' },
  history: { title: 'History', body: 'Past periods and cycle statistics' },
  wellbeing: { title: 'Symptoms & mood', body: 'Daily symptoms and mood' },
};

export interface PartnerPrediction {
  start: Range;
  periodEnd: string;
  ovulation?: Range;
  fertileStart?: string;
  fertileEnd?: string;
  peakFertileStart?: string;
  peakFertileEnd?: string;
}

export interface PartnerView {
  owner: { name: string };
  scopes: ShareScope[];
  paused: boolean;
  confidence: Confidence;
  current: {
    cycleStart: string;
    cycleDay: number;
    /** Without the fertility scope, phases other than period/late are reported as "cycle". */
    phase: 'period' | 'late' | 'cycle' | 'follicular' | 'fertile' | 'peak-fertile' | 'luteal';
    daysLate: number;
    ovulationConfirmed: boolean;
  } | null;
  predictions: PartnerPrediction[];
  /** Past ovulations (fertility scope) for the calendar. */
  pastOvulations: Ovulation[];
  cycles: { start: string; length: number | null; periodLength: number }[];
  stats: { mean: number | null; sd: number | null; min: number | null; max: number | null; periodMean: number | null; regularity: Regularity } | null;
  days: DayEntry[];
}

function filterDay(d: DayData, scopes: Set<ShareScope>): DayData | null {
  const out: DayData = {};
  if (scopes.has('history') && d.bleeding) out.bleeding = d.bleeding;
  if (scopes.has('fertility')) {
    if (d.temperature) out.temperature = d.temperature;
    if (d.mucus) out.mucus = d.mucus;
    if (d.lh) out.lh = d.lh;
  }
  if (scopes.has('wellbeing')) {
    if (d.symptoms?.length) out.symptoms = d.symptoms;
    if (d.mood?.length) out.mood = d.mood;
  }
  // Never shared: notes, sex, pregnancy tests, cervix.
  return Object.keys(out).length ? out : null;
}

export function buildPartnerView(
  analysis: Analysis,
  entries: DayEntry[],
  ownerName: string,
  scopeList: ShareScope[],
  paused: boolean,
): PartnerView {
  const scopes = new Set(scopeList);
  const fertility = scopes.has('fertility');
  const history = scopes.has('history');

  const days: DayEntry[] = [];
  for (const e of entries) {
    const data = filterDay(e.data, scopes);
    if (data) days.push({ date: e.date, data });
  }

  const c = analysis.current;
  const current = c
    ? {
        cycleStart: c.cycleStart,
        cycleDay: c.cycleDay,
        phase: fertility || c.phase === 'period' || c.phase === 'late' ? c.phase : ('cycle' as const),
        daysLate: c.daysLate,
        ovulationConfirmed: fertility && !!analysis.cycles.at(-1)?.ovulation?.confirmed,
      }
    : null;

  const predictions: PartnerPrediction[] = analysis.predictions.map((p) =>
    fertility
      ? { start: p.start, periodEnd: p.periodEnd, ovulation: p.ovulation, fertileStart: p.fertileStart, fertileEnd: p.fertileEnd, peakFertileStart: p.peakFertileStart, peakFertileEnd: p.peakFertileEnd }
      : { start: p.start, periodEnd: p.periodEnd },
  );

  const s = analysis.stats;
  return {
    owner: { name: ownerName },
    scopes: [...scopes],
    paused,
    confidence: analysis.confidence,
    current,
    predictions,
    pastOvulations: fertility ? analysis.cycles.slice(0, -1).flatMap((cy) => (cy.ovulation ? [cy.ovulation] : [])) : [],
    cycles: history ? analysis.cycles.map((cy) => ({ start: cy.start, length: cy.length, periodLength: cy.periodLength })) : [],
    stats: history ? { mean: s.mean, sd: s.sd, min: s.min, max: s.max, periodMean: s.periodMean, regularity: s.regularity } : null,
    days,
  };
}
