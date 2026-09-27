import { describe, expect, it } from 'vitest';
import { addDays } from '../shared/dates.ts';
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
        data: { temperature: { value, exclude: i === 6 } } as DayData,
      })),
    ];
    const [cycle] = buildCycles(entries, settings(), '2026-03-12');
    expect(cycle!.temperature).toMatchObject({ status: 'confirmed', rule: 'regular', coverline: 36.5, firstHigh: '2026-03-09' });
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
    const entries = generate('2026-01-01', [{ length: 24, ovulationDay: 11, temps: true, mucus: true }]);
    // First higher reading on day 12 → minus-8 = day 4.
    expect(analyze(entries, avoid, '2026-01-26').nfp).toMatchObject({ kind: 'infertile-pre', rule: 'minus-8', lastDay: '2026-01-28' });
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
});
