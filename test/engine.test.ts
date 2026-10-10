import { describe, expect, it } from 'vitest';
import { addDays, diffDays } from '../shared/dates.ts';
import { buildPartnerView } from '../shared/partner.ts';
import {
  analyze,
  buildCycles,
  computeStats,
  evaluateTemperature,
  findMucusPeaks,
  mucusCategory,
  type MucusCategory,
} from '../shared/engine.ts';
import { defaultSettings, type DayData, type DayEntry, type Settings } from '../shared/schema.ts';

// ---------------------------------------------------------------- fixtures

interface CycleSpec {
  length: number;
  period?: number;
  /** Cycle day of ovulation; temperature rises the day after. */
  ovulationDay?: number;
  temps?: boolean;
  mucus?: boolean;
  lh?: boolean;
}

/** Generates `specs` consecutive cycles starting at `start`, plus the first period day of the next one. */
function generate(start: string, specs: CycleSpec[], opts: { closeLast?: boolean } = {}): DayEntry[] {
  const entries: DayEntry[] = [];
  let cursor = start;
  for (const spec of specs) {
    const period = spec.period ?? 5;
    const ov = spec.ovulationDay;
    for (let day = 1; day <= spec.length; day++) {
      const data: DayData = {};
      if (day <= period) data.bleeding = { value: day <= 2 ? 'medium' : 'light' };
      if (spec.temps && ov) data.temperature = { value: day <= ov ? 36.4 + (day % 3) * 0.05 : 36.85 };
      if (spec.mucus && ov && day > period) {
        if (day >= ov - 3 && day <= ov) data.mucus = { sensation: 'wet', appearance: 'eggwhite' };
        else if (day >= ov - 5 && day < ov - 3) data.mucus = { sensation: 'moist', appearance: 'creamy' };
        else data.mucus = { sensation: 'dry', appearance: 'none' };
      }
      if (spec.lh && ov && day === ov - 1) data.lh = 'positive';
      if (Object.keys(data).length) entries.push({ date: addDays(cursor, day - 1), data });
    }
    cursor = addDays(cursor, spec.length);
  }
  if (opts.closeLast !== false) entries.push({ date: cursor, data: { bleeding: { value: 'heavy' } } });
  return entries;
}

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaultSettings(), ...patch });

const readings = (values: number[], start = '2026-01-01') =>
  values.map((value, i) => ({ date: addDays(start, i), value }));

// ---------------------------------------------------------------- temperature rule

describe('Sensiplan temperature rule', () => {
  const low = [36.4, 36.45, 36.5, 36.4, 36.35, 36.45]; // cover line 36.50

  it('confirms with the regular rule (3 higher, third ≥ 0.2 above)', () => {
    const r = evaluateTemperature(readings([...low, 36.6, 36.65, 36.7]));
    expect(r).toMatchObject({ status: 'confirmed', rule: 'regular', coverline: 36.5, firstHigh: '2026-01-07', confirmedOn: '2026-01-09' });
  });

  it('applies the 1st exception when the third reading is not 0.2 above', () => {
    const r = evaluateTemperature(readings([...low, 36.55, 36.6, 36.65, 36.55]));
    expect(r).toMatchObject({ status: 'confirmed', rule: 'exception1', confirmedOn: '2026-01-10' });
  });

  it('keeps the 1st exception pending until the fourth reading exists', () => {
    const r = evaluateTemperature(readings([...low, 36.55, 36.6, 36.65]));
    expect(r?.status).toBe('pending');
  });

  it('applies the 2nd exception when one reading drops to the cover line', () => {
    const r = evaluateTemperature(readings([...low, 36.6, 36.5, 36.65, 36.75]));
    expect(r).toMatchObject({ status: 'confirmed', rule: 'exception2', bracketed: '2026-01-08', confirmedOn: '2026-01-10' });
  });

  it('never combines both exceptions', () => {
    // Drop + last reading only 0.15 above: neither exception alone is satisfied.
    const r = evaluateTemperature(readings([...low, 36.6, 36.5, 36.6, 36.65]));
    expect(r?.status).not.toBe('confirmed');
  });

  it('needs six previous readings', () => {
    expect(evaluateTemperature(readings([36.4, 36.4, 36.4, 36.4, 36.4, 36.9, 36.9, 36.9]))).toBeNull();
  });

  it('skips excluded (disturbed) readings when building the cover line', () => {
    const entries: DayEntry[] = [
      { date: '2026-03-01', data: { bleeding: { value: 'heavy' } } },
      ...[36.4, 36.45, 36.5, 36.4, 36.35, 36.45, 37.2, 36.6, 36.65, 36.7].map((value, i) => ({
        date: addDays('2026-03-02', i),
        data: { temperature: { value, ...(i === 6 && { exclude: true, disturbances: ['alcohol'] }) } } as DayData,
      })),
    ];
    const [cycle] = buildCycles(entries, settings(), '2026-03-12');
    expect(cycle!.temperature).toMatchObject({ status: 'confirmed', rule: 'regular', coverline: 36.5, firstHigh: '2026-03-09' });
    expect(cycle!.ignoredExclusions).toEqual([]);
  });

  const cycleOf = (temps: (number | NonNullable<DayData['temperature']>)[]) => {
    const entries: DayEntry[] = [
      { date: '2026-03-01', data: { bleeding: { value: 'heavy' } } },
      ...temps.map((t, i) => ({ date: addDays('2026-03-02', i), data: { temperature: typeof t === 'number' ? { value: t } : t } as DayData })),
    ];
    return buildCycles(entries, settings(), addDays('2026-03-02', temps.length))[0]!;
  };

  it('rounds readings to 0.05 °C before comparing (Sensiplan)', () => {
    // 36.44 → 36.45 cover line; 36.63 → 36.65 is exactly 0.2 above (raw it would be 0.19).
    const c = cycleOf([36.4, 36.44, 36.35, 36.4, 36.3, 36.4, 36.55, 36.6, 36.63]);
    expect(c.temperature).toMatchObject({ status: 'confirmed', rule: 'regular', coverline: 36.45, confirmedOn: '2026-03-10' });
  });

  it('does not count a reading that only rounds to the cover line as higher', () => {
    // 36.41 → 36.40 and 36.42 → 36.40: equal, not higher.
    const c = cycleOf([36.4, 36.41, 36.35, 36.4, 36.3, 36.4, 36.42, 36.6, 36.7, 36.8]);
    expect(c.temperature).toMatchObject({ status: 'confirmed', firstHigh: '2026-03-09' });
  });

  it('still counts a reading marked excluded without a disturbance', () => {
    const c = cycleOf([36.4, 36.45, 36.5, 36.4, 36.35, 36.45, { value: 37.2, exclude: true }, 36.6, 36.65, 36.7]);
    expect(c.ignoredExclusions).toEqual(['2026-03-08']);
    expect(c.temperature?.firstHigh).toBe('2026-03-08');
  });

  it('sets aside a reading judged disturbed whatever its value, once a disturbance is noted', () => {
    const c = cycleOf([36.4, 36.45, 36.5, 36.4, 36.35, 36.45, 36.6, { value: 36.5, exclude: true, disturbances: ['sleep'] }, 36.65, 36.75]);
    expect(c.ignoredExclusions).toEqual([]);
    expect(c.temperature).toMatchObject({ status: 'confirmed', rule: 'regular', highDates: ['2026-03-08', '2026-03-10', '2026-03-11'] });
  });

  it('sets aside a disturbed reading however few readings come before it', () => {
    const c = cycleOf([{ value: 37.0, exclude: true, disturbances: ['time'] }, 36.4, 36.45, 36.5, 36.4, 36.35, 36.45, 36.6, 36.65, 36.7]);
    expect(c.ignoredExclusions).toEqual([]);
    expect(c.temperature).toMatchObject({ status: 'confirmed', coverline: 36.5, lowDates: ['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'] });
  });
});

// ---------------------------------------------------------------- mucus

describe('mucus', () => {
  it('maps observations to Sensiplan categories', () => {
    expect(mucusCategory({ sensation: 'dry', appearance: 'none' })).toBe(0);
    expect(mucusCategory({ sensation: 'nothing', appearance: 'none' })).toBe(1);
    expect(mucusCategory({ sensation: 'moist', appearance: 'none' })).toBe(2);
    expect(mucusCategory({ sensation: 'dry', appearance: 'creamy' })).toBe(3);
    expect(mucusCategory({ sensation: 'nothing', appearance: 'eggwhite' })).toBe(4);
    expect(mucusCategory({ sensation: 'wet', appearance: 'none' })).toBe(4);
  });

  const obs = (cats: MucusCategory[]) => new Map(cats.map((c, i) => [addDays('2026-01-01', i), c] as const));

  it('finds the peak as the last day of best quality followed by 3 lower days', () => {
    const peaks = findMucusPeaks(obs([0, 1, 2, 3, 4, 4, 3, 2, 1]), '2026-01-01', '2026-01-09');
    expect(peaks).toEqual([{ peak: '2026-01-06', category: 4, confirmedOn: '2026-01-09' }]);
  });

  it('restarts the count when best quality returns', () => {
    const peaks = findMucusPeaks(obs([1, 4, 3, 4, 3, 2, 1]), '2026-01-01', '2026-01-07');
    expect(peaks.map((p) => p.peak)).toEqual(['2026-01-04']);
  });

  it('does not confirm a peak with missing observations', () => {
    const m = obs([1, 4, 3]);
    m.set('2026-01-05', 1);
    expect(findMucusPeaks(m, '2026-01-01', '2026-01-05')).toEqual([]);
  });
});

// ---------------------------------------------------------------- cycles & stats

describe('cycles', () => {
  it('detects period starts and cycle lengths', () => {
    const entries = generate('2026-01-01', [{ length: 28 }, { length: 30 }, { length: 27 }]);
    const cycles = buildCycles(entries, settings(), '2026-03-30');
    expect(cycles.map((c) => [c.start, c.length, c.periodLength])).toEqual([
      ['2026-01-01', 28, 5],
      ['2026-01-29', 30, 5],
      ['2026-02-28', 27, 5],
      ['2026-03-27', null, 1],
    ]);
  });

  it('ignores spotting and mid-cycle bleeding for period starts', () => {
    const entries = generate('2026-01-01', [{ length: 28 }]);
    entries.push({ date: '2026-01-14', data: { bleeding: { value: 'spotting' } } });
    entries.push({ date: '2026-01-12', data: { bleeding: { value: 'light' } } });
    const cycles = buildCycles(entries, settings(), '2026-01-30');
    expect(cycles.map((c) => c.start)).toEqual(['2026-01-01', '2026-01-29']);
    expect(cycles[0]!.intermenstrualBleeding).toEqual(['2026-01-12', '2026-01-14']);
  });

  it('respects the bleeding exclude flag', () => {
    const entries = generate('2026-01-01', [{ length: 28 }], { closeLast: false });
    entries.push({ date: '2026-01-29', data: { bleeding: { value: 'heavy', exclude: true } } });
    expect(buildCycles(entries, settings(), '2026-01-30')).toHaveLength(1);
  });

  it('computes ovulation and luteal length from a temperature shift + mucus', () => {
    const entries = generate('2026-01-01', [{ length: 29, ovulationDay: 16, temps: true, mucus: true }]);
    const [c] = buildCycles(entries, settings(), '2026-01-31');
    expect(c!.temperature?.status).toBe('confirmed');
    expect(c!.ovulation).toEqual({ date: '2026-01-16', method: 'temperature+mucus', confirmed: true });
    expect(c!.ovulationDay).toBe(16);
    expect(c!.lutealLength).toBe(13);
    expect(c!.mucusPeak?.peak).toBe('2026-01-16');
    // Double check: temperature confirmed on day 19, mucus on day 19 → infertile from that evening.
    expect(c!.postOvulatoryInfertileFrom).toBe('2026-01-19');
  });

  it('uses LH as a non-confirming ovulation estimate', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 14, lh: true }]);
    const [c] = buildCycles(entries, settings(), '2026-01-29');
    expect(c!.ovulation).toEqual({ date: '2026-01-14', method: 'lh', confirmed: false });
    expect(c!.lutealLength).toBeNull();
  });

  it('classifies regularity with FIGO thresholds', () => {
    const reg = computeStats(buildCycles(generate('2026-01-01', [{ length: 27 }, { length: 29 }, { length: 31 }]), settings(), '2026-06-01'));
    expect(reg).toMatchObject({ count: 3, mean: 29, regularity: 'regular', frequency: 'normal', variation: 4 });
    const irr = computeStats(buildCycles(generate('2026-01-01', [{ length: 24 }, { length: 40 }, { length: 30 }]), settings(), '2026-06-01'));
    expect(irr.regularity).toBe('irregular');
  });

  it('excludes flagged cycles from statistics', () => {
    const entries = generate('2026-01-01', [{ length: 45 }, { length: 28 }, { length: 28 }, { length: 28 }]);
    const stats = computeStats(buildCycles(entries, settings({ excludedCycles: ['2026-01-01'] }), '2026-06-01'));
    expect(stats).toMatchObject({ count: 3, mean: 28, regularity: 'regular' });
  });
});

// ---------------------------------------------------------------- predictions

describe('predictions', () => {
  it('falls back to defaults with low confidence and no history', () => {
    const a = analyze([{ date: '2026-05-01', data: { bleeding: { value: 'heavy' } } }], settings(), '2026-05-03');
    expect(a.basis).toBe('defaults');
    expect(a.confidence).toBe('low');
    expect(a.warnings).toContain('few-cycles');
    expect(a.predictions[1]!.start.date).toBe('2026-05-29');
    expect(a.current).toMatchObject({ cycleDay: 3, phase: 'period' });
  });

  it('learns personal cycle length and ranges', () => {
    const specs = [30, 31, 30, 29, 30, 31, 30].map((length) => ({ length }));
    const entries = generate('2026-01-01', specs);
    const lastStart = entries.at(-1)!.date;
    const a = analyze(entries, settings(), addDays(lastStart, 2));
    expect(a.basis).toBe('personal');
    expect(a.confidence).toBe('high');
    expect(a.predictions[1]!.start.date).toBe(addDays(lastStart, 30));
    expect(a.predictions[1]!.start.earliest).toBe(addDays(lastStart, 29));
    // Ovulation predicted backwards from the next period with the default luteal length (13).
    expect(a.predictions[0]!.ovulation.date).toBe(addDays(lastStart, 30 - 13 - 1));
  });

  it('uses personal luteal length once ovulation has been confirmed in 2+ cycles', () => {
    const specs = Array.from({ length: 4 }, () => ({ length: 30, ovulationDay: 19, temps: true, mucus: true }));
    const entries = generate('2026-01-01', specs);
    const lastStart = entries.at(-1)!.date;
    const a = analyze(entries, settings(), addDays(lastStart, 1));
    expect(a.stats.lutealMean).toBe(11);
    expect(a.predictions[0]!.ovulation.date).toBe(addDays(lastStart, 18));
    expect(a.predictions[0]!.fertileStart <= addDays(lastStart, 13)).toBe(true);
  });

  it('switches to ovulation + luteal once the shift is confirmed in the current cycle', () => {
    const history = Array.from({ length: 3 }, () => ({ length: 28, ovulationDay: 15, temps: true, mucus: true }));
    const current = generate('2026-04-01', [{ length: 20, ovulationDay: 12, temps: true, mucus: true }], { closeLast: false });
    const entries = [...generate('2026-01-07', history), ...current];
    const a = analyze(entries, settings(), '2026-04-20');
    const cur = a.cycles.at(-1)!;
    expect(cur.ovulation?.date).toBe('2026-04-12');
    // luteal 13 → next period = ovulation + 14
    expect(a.predictions[1]!.start.date).toBe('2026-04-26');
    expect(a.current!.phase).toBe('luteal');
  });

  it('detects a late period and suggests a test after unprotected sex in the fertile window', () => {
    const entries = generate('2026-01-01', [{ length: 28 }, { length: 28 }, { length: 28 }]);
    const lastStart = entries.at(-1)!.date; // 2026-03-26
    entries.push({ date: addDays(lastStart, 12), data: { sex: 'unprotected' } });
    const a = analyze(entries, settings(), addDays(lastStart, 33));
    expect(a.current!.phase).toBe('late');
    expect(a.current!.daysLate).toBeGreaterThan(0);
    expect(a.current!.suggestPregnancyTest).toBe(true);
  });

  it('pauses predictions in paused mode', () => {
    const entries = generate('2026-01-01', [{ length: 28 }]);
    expect(analyze(entries, settings({ paused: true }), '2026-02-01').predictions).toEqual([]);
  });
});

// ---------------------------------------------------------------- NFP

describe('Sensiplan evaluation', () => {
  const avoid = settings({ goal: 'avoid', nfpAcknowledged: true });

  it('is unavailable unless explicitly enabled', () => {
    const entries = generate('2026-01-01', [{ length: 28 }]);
    expect(analyze(entries, settings({ goal: 'avoid' }), '2026-01-30').nfp.kind).toBe('unavailable');
  });

  it('applies the 5-day rule only after a cycle with a temperature shift', () => {
    const first = analyze(generate('2026-01-01', [{ length: 28 }]), avoid, '2026-01-31');
    expect(first.nfp).toMatchObject({ kind: 'fertile', reason: 'no-shift-previous-cycle' });

    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    expect(analyze(entries, avoid, '2026-01-31').nfp).toMatchObject({ kind: 'infertile-pre', rule: '5-day', lastDay: '2026-02-02' });
    expect(analyze(entries, avoid, '2026-02-03').nfp.kind).toBe('fertile');
  });

  it('ends the pre-ovulatory phase at the first mucus sign', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    entries.push({ date: '2026-02-01', data: { mucus: { sensation: 'moist', appearance: 'none' } } });
    expect(analyze(entries, avoid, '2026-02-01').nfp).toMatchObject({ kind: 'fertile', reason: 'mucus-observed' });
  });

  it('uses minus-8 when a first higher reading was early', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 11, temps: true, mucus: true }]);
    // First higher reading on day 12 → minus-8 = day 4.
    expect(analyze(entries, avoid, '2026-01-30').nfp).toMatchObject({ kind: 'infertile-pre', rule: 'minus-8', lastDay: '2026-02-01' });
  });

  it('caps the infertile days at the shortest cycle minus 21 (calendar rule)', () => {
    // 24-day cycle, first higher reading on day 13: minus-8 would allow 5 days, the calendar rule 3.
    const entries = generate('2026-01-01', [{ length: 24, ovulationDay: 12, temps: true, mucus: true }]);
    const start = entries.at(-1)!.date;
    expect(analyze(entries, avoid, addDays(start, 1)).nfp).toMatchObject({ kind: 'infertile-pre', rule: 'shortest-cycle', lastDay: addDays(start, 2) });
    expect(analyze(entries, avoid, addDays(start, 3)).nfp.kind).toBe('fertile');

    // 21-day cycle: no infertile days at the start at all.
    const short = generate('2026-01-01', [{ length: 21, ovulationDay: 9, temps: true, mucus: true }]);
    expect(analyze(short, avoid, short.at(-1)!.date).nfp).toMatchObject({ kind: 'fertile', reason: 'short-cycles' });
  });

  it('declares post-ovulatory infertility only after the double check', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }], { closeLast: false });
    expect(analyze(entries, avoid, '2026-01-17').nfp.kind).toBe('fertile');
    expect(analyze(entries, avoid, '2026-01-18')).toMatchObject({ nfp: { kind: 'infertile-post', since: '2026-01-18', fromEvening: true } });
    expect(analyze(entries, avoid, '2026-01-20').nfp).toMatchObject({ kind: 'infertile-post', fromEvening: false });
  });

  it('does not declare post-ovulatory infertility from temperature alone', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true }], { closeLast: false });
    expect(analyze(entries, avoid, '2026-01-25').nfp.kind).toBe('fertile');
  });

  // Day 1 = 2026-01-01. Low readings until day 12, higher from day 13: rule complete on day 15.
  const doubleCheckCycle = (mucusByDay: Record<number, MucusCategory>, lastDay: number) => {
    const sensation = ['dry', 'nothing', 'moist', 'dry', 'wet'] as const;
    const appearance = ['none', 'none', 'none', 'creamy', 'eggwhite'] as const;
    const entries: DayEntry[] = [];
    for (let day = 1; day <= lastDay; day++) {
      const data: DayData = { temperature: { value: day <= 12 ? 36.4 : 36.7 } };
      if (day === 1) data.bleeding = { value: 'heavy' };
      const m = mucusByDay[day];
      if (m !== undefined) data.mucus = { sensation: sensation[m], appearance: appearance[m] };
      entries.push({ date: addDays('2026-01-01', day - 1), data });
    }
    return buildCycles(entries, settings(), addDays('2026-01-01', lastDay - 1))[0]!;
  };

  it('restarts the mucus evaluation when the peak quality returns before the double check', () => {
    // Peak day 8 (3 lower days after it), but S+ again on day 13: new peak, confirmed on day 16.
    const mucus = { 8: 4, 9: 0, 10: 0, 11: 0, 12: 0, 13: 4, 14: 0, 15: 0, 16: 0 } as const;
    expect(doubleCheckCycle(mucus, 15).postOvulatoryInfertileFrom).toBeNull();
    const c = doubleCheckCycle(mucus, 16);
    expect(c.mucusPeak?.peak).toBe('2026-01-13');
    expect(c.postOvulatoryInfertileFrom).toBe('2026-01-16');
  });

  it('keeps the peak when only lower-quality mucus returns', () => {
    const c = doubleCheckCycle({ 8: 4, 9: 0, 10: 0, 11: 0, 12: 3, 13: 0, 14: 0, 15: 0 }, 15);
    expect(c.mucusPeak?.peak).toBe('2026-01-08');
    expect(c.postOvulatoryInfertileFrom).toBe('2026-01-15');
  });

  it('counts cycles excluded from statistics for minus-8', () => {
    const entries = generate('2026-01-01', [
      { length: 28, ovulationDay: 11, temps: true, mucus: true },
      { length: 28, ovulationDay: 15, temps: true, mucus: true },
    ]);
    const start = entries.at(-1)!.date;
    const a = analyze(entries, { ...avoid, excludedCycles: ['2026-01-01'] }, addDays(start, 1));
    // Earliest first higher reading on day 12 (in the excluded cycle) → last infertile day 4.
    expect(a.nfp).toMatchObject({ kind: 'infertile-pre', rule: 'minus-8', lastDay: addDays(start, 3) });
  });

  it('leaves out of minus-8 a cycle whose first higher reading follows a missing day', () => {
    const entries = generate('2026-01-01', [
      { length: 28, ovulationDay: 11, temps: true, mucus: true },
      { length: 28, ovulationDay: 15, temps: true, mucus: true },
    ]);
    // No reading on day 11: the rise seen on day 12 may have started the day before.
    delete entries.find((e) => e.date === '2026-01-11')!.data.temperature;
    const start = entries.at(-1)!.date;
    expect(analyze(entries, avoid, addDays(start, 1)).nfp).toMatchObject({ kind: 'infertile-pre', rule: '5-day', lastDay: addDays(start, 4) });
  });

  it('has no infertile days at the start of the first cycle after hormonal contraception', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    const a = analyze(entries, { ...avoid, afterHormonalContraception: ['2026-01-29'] }, '2026-01-31');
    expect(a.nfp).toMatchObject({ kind: 'fertile', reason: 'after-hormonal-contraception' });
  });

  it('waits one more higher reading in the first cycle after hormonal contraception', () => {
    const afterPill = settings({ afterHormonalContraception: ['2026-01-01'] });
    const pending = buildCycles(generate('2026-01-01', [{ length: 18, ovulationDay: 15, temps: true, mucus: true }], { closeLast: false }), afterPill, '2026-01-18')[0]!;
    expect(pending.temperature?.status).toBe('pending');
    expect(pending.postOvulatoryInfertileFrom).toBeNull();

    const [c] = buildCycles(generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }], { closeLast: false }), afterPill, '2026-01-28');
    expect(c!.afterHormonalContraception).toBe(true);
    expect(c!.temperature).toMatchObject({ status: 'confirmed', confirmedOn: '2026-01-19', extraDay: true });
    expect(c!.postOvulatoryInfertileFrom).toBe('2026-01-19');
  });

  it('keeps asking for the extra reading until the first confirmed rise after hormonal contraception', () => {
    const entries = generate('2026-01-01', [
      { length: 30 }, // no temperature rise in the first cycle
      { length: 28, ovulationDay: 15, temps: true, mucus: true },
      { length: 28, ovulationDay: 15, temps: true, mucus: true },
    ]);
    const cycles = buildCycles(entries, settings({ afterHormonalContraception: ['2026-01-01'] }), entries.at(-1)!.date);
    expect(cycles.map((c) => c.extraReading)).toEqual([true, true, false, false]);
    expect(cycles[1]!.temperature).toMatchObject({ status: 'confirmed', extraDay: true, confirmedOn: addDays(cycles[1]!.start, 18) });
    expect(cycles[2]!.temperature).toMatchObject({ status: 'confirmed', confirmedOn: addDays(cycles[2]!.start, 17) });
  });

  it('applies the rules after hormones to the cycle running when they stopped and to the next one', () => {
    const entries = generate('2026-01-01', [{ length: 28 }, { length: 28 }]);
    const cycles = buildCycles(entries, settings({ hormonesStopped: ['2026-01-10'] }), entries.at(-1)!.date);
    expect(cycles.map((c) => [c.afterHormonalContraception, c.firstAfterHormones])).toEqual([[true, false], [true, true], [false, false]]);
  });

  it('starts the minus-8 count again after hormonal contraception, leaving out the first three cycles', () => {
    // 13 cycles of 38 days, first higher reading on day 25: minus-8 and the calendar rule give day 17.
    const entries = generate('2025-01-01', Array.from({ length: 13 }, () => ({ length: 38, ovulationDay: 24, temps: true, mucus: true })));
    const start = entries.at(-1)!.date;
    expect(analyze(entries, avoid, addDays(start, 9)).nfp).toMatchObject({ kind: 'infertile-pre', rule: 'minus-8', lastDay: addDays(start, 16) });

    // Hormones stopped before the 6th cycle: only cycles 9–13 count, so the 5-day rule applies.
    const after = { ...avoid, afterHormonalContraception: [addDays('2025-01-01', 38 * 5)] };
    expect(analyze(entries, after, addDays(start, 4)).nfp).toMatchObject({ kind: 'infertile-pre', rule: '5-day', lastDay: addDays(start, 4) });
    expect(analyze(entries, after, addDays(start, 9)).nfp.kind).toBe('fertile');
  });

  it('has no infertile days at the start of the first cycle after a pause', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    const a = analyze(entries, { ...avoid, historyRestarts: ['2026-01-20'] }, '2026-01-31');
    expect(a.nfp).toMatchObject({ kind: 'fertile', reason: 'after-pause' });
  });

  it('evaluates bleeding outside the period like fertile mucus', () => {
    // Peak on day 8, temperature rule complete on day 15, spotting on day 14.
    const entries = (lastDay: number): DayEntry[] =>
      Array.from({ length: lastDay }, (_, i) => {
        const day = i + 1;
        const data: DayData = {
          temperature: { value: day <= 12 ? 36.4 : 36.7 },
          mucus: day === 8 ? { sensation: 'wet', appearance: 'eggwhite' } : { sensation: 'dry', appearance: 'none' },
        };
        if (day === 1) data.bleeding = { value: 'heavy' };
        if (day === 14) data.bleeding = { value: 'spotting' };
        return { date: addDays('2026-01-01', i), data };
      });
    const cycleAt = (lastDay: number) => buildCycles(entries(lastDay), settings(), addDays('2026-01-01', lastDay - 1))[0]!;
    // Three dry days after the bleeding are needed: days 15, 16 and 17.
    expect(cycleAt(16).postOvulatoryInfertileFrom).toBeNull();
    const c = cycleAt(17);
    expect(c.mucusPeak).toMatchObject({ peak: '2026-01-14', bleeding: true });
    expect(c.postOvulatoryInfertileFrom).toBe('2026-01-17');
  });

  it('ends the pre-ovulatory phase at bleeding outside the period', () => {
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    // Spotting on cycle day 4, three days after a one-day period.
    entries.push({ date: '2026-02-01', data: { bleeding: { value: 'spotting' } } });
    expect(analyze(entries.slice(0, -1), avoid, '2026-02-01').nfp).toMatchObject({ kind: 'infertile-pre', rule: '5-day', lastDay: '2026-02-02' });
    expect(analyze(entries, avoid, '2026-02-01').nfp).toMatchObject({ kind: 'fertile', reason: 'bleeding-observed' });
  });

  it('needs a mucus observation on every day until the temperature rule is complete', () => {
    // Peak day 8, temperature rule complete on day 15, nothing noted on day 12.
    const c = doubleCheckCycle({ 8: 4, 9: 0, 10: 0, 11: 0, 13: 0, 14: 0, 15: 0 }, 15);
    expect(c.postOvulatoryInfertileFrom).toBeNull();
    expect(c.mucusGaps).toEqual(['2026-01-12']);
  });

  it('lets the user mark the first day of a period', () => {
    const entries = generate('2026-01-01', [{ length: 28 }]);
    entries.push({ date: '2026-01-27', data: { bleeding: { value: 'spotting', firstDay: true } } });
    expect(buildCycles(entries, settings(), '2026-01-30').map((c) => c.start)).toEqual(['2026-01-01', '2026-01-27']);
  });

  it('gives no infertile days while the first day of the period is in doubt', () => {
    // A single light bleed on day 22, the real period a week later.
    const entries = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    const light = entries.find((e) => e.date === '2026-01-22')!;
    light.data.bleeding = { value: 'light' };
    const doubtful = analyze(entries, avoid, '2026-01-30');
    expect(doubtful.cycles.at(-1)).toMatchObject({ start: '2026-01-22', startUncertain: true });
    expect(doubtful.nfp).toMatchObject({ kind: 'fertile', reason: 'cycle-start-unconfirmed' });

    // "No, it was not a period": the real period starts the cycle, the bleed stays a fertile sign.
    light.data.bleeding = { value: 'light', exclude: true };
    const fixed = analyze(entries, avoid, '2026-01-30');
    expect(fixed.cycles.map((c) => [c.start, c.startUncertain])).toEqual([['2026-01-01', false], ['2026-01-29', false]]);
    expect(fixed.cycles[0]!.intermenstrualBleeding).toEqual(['2026-01-22']);
    expect(fixed.nfp).toMatchObject({ kind: 'infertile-pre', rule: '5-day' });
  });
});

// ---------------------------------------------------------------- hormonal contraception & forecasts

describe('hormonal contraception and forecasts', () => {
  const regular = { length: 28, ovulationDay: 15, temps: true, mucus: true };

  it('predicts and evaluates nothing while hormonal contraception is in use', () => {
    const entries = generate('2026-01-01', [{ length: 20 }, { length: 41 }, { length: 16 }]);
    const a = analyze(entries, settings({ hormonalContraception: true, goal: 'avoid', nfpAcknowledged: true }), addDays(entries.at(-1)!.date, 3));
    expect(a).toMatchObject({ current: null, predictions: [], warnings: [], nfp: { kind: 'unavailable', reason: 'hormonal-contraception' } });

    // The charts show the log only: no temperature shift, peak or ovulation, in any cycle.
    const charted = generate('2026-01-01', [{ length: 28, ovulationDay: 15, temps: true, mucus: true }]);
    const today = addDays(charted.at(-1)!.date, 3);
    expect(analyze(charted, settings(), today).cycles[0]).toMatchObject({ ovulationDay: 15, postOvulatoryInfertileFrom: '2026-01-18' });
    expect(analyze(charted, settings({ hormonalContraception: true }), today).cycles[0]).toMatchObject({
      length: 28,
      temperature: null,
      mucusPeak: null,
      ovulation: null,
      lutealLength: null,
      postOvulatoryInfertileFrom: null,
    });
  });

  it('hides the calendar forecast of the fertile days while the Sensiplan evaluation is on', () => {
    const entries = generate('2026-01-01', [regular, regular, regular]);
    const today = addDays(entries.at(-1)!.date, 9);
    expect(analyze(entries, settings(), today)).toMatchObject({ forecastHidden: null, current: { phase: 'fertile' } });

    const a = analyze(entries, settings({ goal: 'avoid', nfpAcknowledged: true }), today);
    expect(a).toMatchObject({ forecastHidden: 'sensiplan', current: { phase: 'cycle' } });
    // The next period is still predicted, and a partner does not get the forecast either.
    expect(a.predictions[1]!.start.date).toBe(addDays(entries.at(-1)!.date, 28));
    const view = buildPartnerView(a, entries, 'Alice', ['fertility', 'history'], false);
    expect(view.predictions[1]).toHaveProperty('start');
    expect(view.predictions[1]).not.toHaveProperty('fertileStart');
  });

  it('hides it for the first three cycles after hormonal contraception, unless trying to conceive', () => {
    const marked = (goal: Settings['goal']) => settings({ goal, afterHormonalContraception: ['2026-01-01'] });
    const two = generate('2026-01-01', [regular, regular]);
    const today = addDays(two.at(-1)!.date, 9);
    expect(analyze(two, marked('track'), today)).toMatchObject({ forecastHidden: 'after-hormones', confidence: 'low' });
    expect(analyze(two, marked('conceive'), today).forecastHidden).toBeNull();

    const three = generate('2026-01-01', [regular, regular, regular]);
    expect(analyze(three, marked('track'), addDays(three.at(-1)!.date, 9)).forecastHidden).toBeNull();
  });

  it('uses only the cycles since hormonal contraception for the statistics', () => {
    const entries = generate('2026-01-01', [{ length: 40 }, { length: 40 }, { length: 28 }, { length: 28 }, { length: 28 }]);
    const stats = computeStats(buildCycles(entries, settings({ afterHormonalContraception: ['2026-03-22'] }), '2026-07-01'));
    expect(stats).toMatchObject({ count: 3, mean: 28 });
  });

  it('expects ovulation on the same cycle day in the current and the following cycles', () => {
    // Average cycle 28.3 days, luteal phase 12.6 days.
    const specs = [[28, 15], [29, 16], [28, 16], [29, 16], [28, 16]].map(([length, ovulationDay]) => ({ length: length!, ovulationDay, temps: true, mucus: true }));
    const entries = generate('2026-01-01', specs);
    const a = analyze(entries, settings(), addDays(entries.at(-1)!.date, 1));
    expect(a.stats.lutealMean).toBe(12.6);
    expect(new Set(a.predictions.map((p) => diffDays(p.start.date, p.ovulation.date) + 1))).toEqual(new Set([15]));
  });
});
