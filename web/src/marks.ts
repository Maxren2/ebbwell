import { addDays, dateRange } from '../../shared/dates.ts';
import type { Analysis } from '../../shared/engine.ts';
import type { DayData } from '../../shared/schema.ts';

export type Mark = 'period' | 'spotting' | 'pred-period' | 'fertile' | 'peak' | 'ovulation' | 'estimated';

/** Visual classes per date: logged facts first, then past estimates, then predictions (future only). */
export function buildMarks(analysis: Analysis, days: Map<string, DayData>, today: string): Map<string, Set<Mark>> {
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
  for (const c of analysis.cycles.slice(0, -1)) {
    if (!c.ovulation) continue;
    for (const d of dateRange(addDays(c.ovulation.date, -5), addDays(c.ovulation.date, 1))) add(d, 'fertile');
    add(c.ovulation.date, 'ovulation');
    if (!c.ovulation.confirmed) add(c.ovulation.date, 'estimated');
  }

  analysis.predictions.forEach((p, i) => {
    const current = i === 0;
    const confirmed = current && analysis.cycles.at(-1)?.ovulation?.confirmed;
    for (const d of dateRange(p.fertileStart, p.fertileEnd)) add(d, 'fertile');
    for (const d of dateRange(p.peakFertileStart, p.peakFertileEnd)) add(d, 'peak');
    add(p.ovulation.date, 'ovulation');
    if (!confirmed) add(p.ovulation.date, 'estimated');
    if (!current) {
      for (const d of dateRange(p.start.date, p.periodEnd)) if (d > today) add(d, 'pred-period');
    } else {
      for (const d of dateRange(addDays(today, 1), p.periodEnd)) add(d, 'pred-period');
    }
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
