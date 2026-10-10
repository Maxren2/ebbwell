import { addDays, dateRange } from '../../shared/dates.ts';
import type { Analysis, Ovulation, Range } from '../../shared/engine.ts';
import type { PartnerView } from '../../shared/partner.ts';
import type { DayData } from '../../shared/schema.ts';

export type Mark = 'period' | 'spotting' | 'pred-period' | 'fertile' | 'peak' | 'ovulation' | 'estimated';

/** What the calendar needs; built from the user's own analysis or a partner view. */
export interface MarkInput {
  pastOvulations: Ovulation[];
  currentOvulationConfirmed: boolean;
  /** Paint the current period from its start to today (partner view without daily bleeding data). */
  inferCurrentPeriod?: boolean;
  predictions: {
    start: Range;
    periodEnd: string;
    ovulation?: Range;
    fertileStart?: string;
    fertileEnd?: string;
    peakFertileStart?: string;
    peakFertileEnd?: string;
  }[];
}

export const marksInputFromAnalysis = (a: Analysis): MarkInput => {
  const confirmed = !!a.cycles.at(-1)?.ovulation?.confirmed;
  return {
    pastOvulations: a.cycles.slice(0, -1).flatMap((c) => (c.ovulation ? [c.ovulation] : [])),
    currentOvulationConfirmed: confirmed,
    // Without the fertility forecast only the periods and an ovulation the signs confirmed are painted.
    predictions: a.forecastHidden
      ? a.predictions.map((p, i) => ({ start: p.start, periodEnd: p.periodEnd, ...(i === 0 && confirmed && { ovulation: p.ovulation }) }))
      : a.predictions,
  };
};

export const marksInputFromPartner = (v: PartnerView): MarkInput => ({
  pastOvulations: v.pastOvulations,
  currentOvulationConfirmed: !!v.current?.ovulationConfirmed,
  inferCurrentPeriod: !v.scopes.includes('history'),
  predictions: v.predictions,
});

/** Visual classes per date: logged facts first, then past estimates, then predictions. */
export function buildMarks(input: MarkInput, days: Map<string, DayData>, today: string): Map<string, Set<Mark>> {
  const marks = new Map<string, Set<Mark>>();
  const add = (date: string, m: Mark) => {
    let s = marks.get(date);
    if (!s) marks.set(date, (s = new Set()));
    s.add(m);
  };

  for (const [date, d] of days) {
    if (d.bleeding && !d.bleeding.exclude) add(date, d.bleeding.value === 'spotting' ? 'spotting' : 'period');
  }

  // Past cycles: fertile window around the estimated/confirmed ovulation.
  for (const ov of input.pastOvulations) {
    for (const d of dateRange(addDays(ov.date, -5), addDays(ov.date, 1))) add(d, 'fertile');
    add(ov.date, 'ovulation');
    if (!ov.confirmed) add(ov.date, 'estimated');
  }

  input.predictions.forEach((p, i) => {
    const current = i === 0;
    if (p.fertileStart && p.fertileEnd) for (const d of dateRange(p.fertileStart, p.fertileEnd)) add(d, 'fertile');
    if (p.peakFertileStart && p.peakFertileEnd) for (const d of dateRange(p.peakFertileStart, p.peakFertileEnd)) add(d, 'peak');
    if (p.ovulation) {
      add(p.ovulation.date, 'ovulation');
      if (!(current && input.currentOvulationConfirmed)) add(p.ovulation.date, 'estimated');
    }
    if (current && input.inferCurrentPeriod) for (const d of dateRange(p.start.date, p.periodEnd)) if (d <= today) add(d, 'period');
    const from = current ? addDays(today, 1) : p.start.date;
    for (const d of dateRange(from, p.periodEnd)) if (d > today) add(d, 'pred-period');
  });

  // Logged bleeding wins over predictions.
  for (const s of marks.values()) {
    if (s.has('period') || s.has('spotting')) s.delete('pred-period');
    if (s.has('period')) {
      s.delete('fertile');
      s.delete('peak');
    }
  }
  return marks;
}
