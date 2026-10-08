// Cycle engine: turns daily observations into cycles, ovulation evaluations,
// statistics and predictions. Pure functions, shared by browser and server.
//
// References:
//  - Sensiplan temperature rule and exceptions, mucus peak rule, double check,
//    5-day / minus-8 rules (Arbeitsgruppe NFP, "Natural & Safe").
//  - Fertile window = 5 days before ovulation + ovulation day (Wilcox, NEJM 1995), +1 day margin.
//  - Luteal phase averages ~12.4 days in real-world data (Bull et al., npj Digit Med 2019).
//  - FIGO 2018: normal frequency 24–38 days, regular if shortest–longest ≤ 7–9 days.

import { addDays, dateRange, diffDays, maxDate } from './dates.ts';
import type { DayData, DayEntry, Settings } from './schema.ts';

// ---------------------------------------------------------------- constants

/** Days without period bleeding needed before new bleeding counts as a new period. */
export const MIN_BLEEDING_GAP = 7;
/** Bleeding sooner than this after a period start is intermenstrual bleeding. */
export const MIN_CYCLE_LENGTH = 15;
/** Cycles longer than this are kept but not used for statistics. */
export const MAX_PLAUSIBLE_CYCLE = 90;
/** How many recent usable cycles feed the statistics. */
export const STATS_WINDOW = 12;
/** Population luteal length when the user has no confirmed cycles yet. */
export const DEFAULT_LUTEAL = 13;
export const DEFAULT_LUTEAL_SD = 2;
export const TEMP_SHIFT_MIN = 0.2; // °C, Sensiplan
const EPS = 1e-9;

/** Sensiplan evaluates readings rounded to 0.05 °C steps (36.42 → 36.40, 36.43 → 36.45, 36.48 → 36.50). */
export const roundReading = (celsius: number) => Math.round(celsius * 20) / 20;

// ---------------------------------------------------------------- types

/** Sensiplan mucus categories: t (dry) < ∅ (nothing) < f (moist) < S (creamy) < S+ (fertile quality). */
export type MucusCategory = 0 | 1 | 2 | 3 | 4;
export const MUCUS_LABELS = ['t', '∅', 'f', 'S', 'S+'] as const;

export interface TemperatureShift {
  status: 'confirmed' | 'pending';
  /** First higher reading. */
  firstHigh: string;
  /** Highest of the six readings before the first higher one. */
  coverline: number;
  /** The six readings used for the cover line. */
  lowDates: string[];
  /** Higher readings counted by the rule. */
  highDates: string[];
  /** Reading ignored under the 2nd exception. */
  bracketed?: string;
  rule?: 'regular' | 'exception1' | 'exception2';
  /** Day the rule completed (post-ovulatory evaluation possible from that evening). */
  confirmedOn?: string;
  /** First cycle after hormonal contraception: one more higher reading was awaited. */
  extraDay?: boolean;
}

export interface MucusPeak {
  peak: string;
  category: MucusCategory;
  /** Third day of lower quality after the peak. */
  confirmedOn: string;
}

export type OvulationMethod = 'temperature+mucus' | 'temperature' | 'mucus' | 'lh';

export interface Ovulation {
  date: string;
  method: OvulationMethod;
  /** Only a temperature shift confirms that ovulation happened. */
  confirmed: boolean;
}

export interface Cycle {
  start: string;
  /** Last day of the cycle, or null for the current cycle. */
  end: string | null;
  length: number | null;
  periodLength: number;
  excluded: boolean;
  /** Marked as the first cycle after hormonal contraception. */
  afterHormonalContraception: boolean;
  /** Readings marked "exclude" that the temperature rule still counts (no disturbance noted). */
  ignoredExclusions: string[];
  /** Completed cycle outside plausible bounds; not used for statistics. */
  implausible: boolean;
  intermenstrualBleeding: string[];
  temperature: TemperatureShift | null;
  mucusPeak: MucusPeak | null;
  firstPositiveLh: string | null;
  ovulation: Ovulation | null;
  /** Day of the cycle (1-based) of the estimated ovulation. */
  ovulationDay: number | null;
  lutealLength: number | null;
  /** Sensiplan double check: infertile from the evening of this date. */
  postOvulatoryInfertileFrom: string | null;
}

export type Regularity = 'unknown' | 'regular' | 'borderline' | 'irregular';
export type Frequency = 'unknown' | 'normal' | 'frequent' | 'infrequent';

export interface Stats {
  /** Number of usable completed cycles in the window. */
  count: number;
  mean: number | null;
  median: number | null;
  sd: number | null;
  min: number | null;
  max: number | null;
  /** Shortest-to-longest difference (FIGO regularity). */
  variation: number | null;
  periodMean: number | null;
  lutealMean: number | null;
  lutealSd: number | null;
  lutealCount: number;
  regularity: Regularity;
  frequency: Frequency;
}

export type Confidence = 'low' | 'medium' | 'high';

export interface Range {
  /** Most likely date. */
  date: string;
  earliest: string;
  latest: string;
}

export interface PredictedCycle {
  start: Range;
  ovulation: Range;
  fertileStart: string;
  fertileEnd: string;
  /** The 3 days with the highest conception probability. */
  peakFertileStart: string;
  peakFertileEnd: string;
  periodEnd: string;
}

export type NfpStatus =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'infertile-pre'; rule: '5-day' | 'minus-8'; lastDay: string }
  | { kind: 'fertile'; reason: string }
  | { kind: 'infertile-post'; since: string; fromEvening: boolean };

export interface CurrentStatus {
  cycleStart: string;
  cycleDay: number;
  inPeriod: boolean;
  phase: 'period' | 'follicular' | 'fertile' | 'peak-fertile' | 'luteal' | 'late';
  daysLate: number;
  /** A temperature shift is being watched but not complete yet. */
  temperaturePending: TemperatureShift | null;
  lhSurgeToday: boolean;
  suggestPregnancyTest: boolean;
  positivePregnancyTest: string | null;
}

export interface Analysis {
  cycles: Cycle[];
  stats: Stats;
  /** Based on the user's own data vs. defaults. */
  basis: 'defaults' | 'personal';
  confidence: Confidence;
  current: CurrentStatus | null;
  /** Current cycle (index 0) followed by upcoming cycles. */
  predictions: PredictedCycle[];
  nfp: NfpStatus;
  warnings: string[];
}

// ---------------------------------------------------------------- helpers

export function mucusCategory(m: NonNullable<DayData['mucus']>): MucusCategory {
  if (m.appearance === 'eggwhite' || m.sensation === 'wet') return 4;
  if (m.appearance === 'creamy') return 3;
  if (m.sensation === 'moist') return 2;
  if (m.sensation === 'nothing') return 1;
  return 0;
}

const isPeriodBleeding = (d: DayData | undefined) =>
  !!d?.bleeding && !d.bleeding.exclude && d.bleeding.value !== 'spotting';

const isAnyBleeding = (d: DayData | undefined) => !!d?.bleeding && !d.bleeding.exclude;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function range(date: string, spread: number): Range {
  return { date, earliest: addDays(date, -spread), latest: addDays(date, spread) };
}

// ---------------------------------------------------------------- cycles

/** Period start dates, oldest first. */
export function findPeriodStarts(byDate: Map<string, DayData>, dates: string[]): string[] {
  const starts: string[] = [];
  let lastBleeding: string | null = null;
  for (const date of dates) {
    if (!isPeriodBleeding(byDate.get(date))) continue;
    const gapOk = lastBleeding === null || diffDays(lastBleeding, date) > MIN_BLEEDING_GAP;
    const lastStart = starts[starts.length - 1];
    const lengthOk = lastStart === undefined || diffDays(lastStart, date) >= MIN_CYCLE_LENGTH;
    if (gapOk && lengthOk) starts.push(date);
    lastBleeding = date;
  }
  return starts;
}

/** Sensiplan temperature rule on the valid (non-excluded) readings of one cycle. */
export function evaluateTemperature(readings: { date: string; value: number }[]): TemperatureShift | null {
  let pending: TemperatureShift | null = null;
  for (let i = 6; i < readings.length; i++) {
    const low = readings.slice(i - 6, i);
    const cover = Math.max(...low.map((r) => r.value));
    const first = readings[i]!;
    if (first.value <= cover + EPS) continue;

    const base = {
      firstHigh: first.date,
      coverline: cover,
      lowDates: low.map((r) => r.date),
    };
    const above = (k: number) => {
      const r = readings[i + k];
      return r === undefined ? undefined : r.value > cover + EPS;
    };
    const aboveBy = (k: number) => {
      const r = readings[i + k];
      return r === undefined ? undefined : r.value >= cover + TEMP_SHIFT_MIN - EPS;
    };
    const at = (k: number) => readings[i + k]!.date;

    const a1 = above(1);
    const a2 = above(2);
    if (a1 === undefined || (a1 && a2 === undefined)) {
      pending ??= { status: 'pending', ...base, highDates: readings.slice(i).map((r) => r.date) };
      continue;
    }

    if (a1 && a2) {
      if (aboveBy(2)) {
        return { status: 'confirmed', ...base, highDates: [at(0), at(1), at(2)], rule: 'regular', confirmedOn: at(2) };
      }
      // 1st exception: third reading not 0.2 above → a fourth reading above the cover line.
      const a3 = above(3);
      if (a3 === undefined) {
        pending ??= { status: 'pending', ...base, highDates: [at(0), at(1), at(2)] };
        continue;
      }
      if (a3) {
        return { status: 'confirmed', ...base, highDates: [at(0), at(1), at(2), at(3)], rule: 'exception1', confirmedOn: at(3) };
      }
      continue; // Exceptions cannot be combined.
    }

    // 2nd exception: one of the next two readings drops to/below the cover line and is
    // bracketed; three readings above remain and the last must be 0.2 above.
    const dropIndex = a1 ? 2 : 1;
    const other = a1 ? 1 : 2;
    const aOther = above(other);
    if (!a1 && aOther === undefined) {
      pending ??= { status: 'pending', ...base, highDates: [at(0)] };
      continue;
    }
    if (!aOther) continue;
    const a3 = above(3);
    if (a3 === undefined) {
      pending ??= { status: 'pending', ...base, highDates: [at(0), at(other)], bracketed: at(dropIndex) };
      continue;
    }
    if (a3 && aboveBy(3)) {
      return {
        status: 'confirmed',
        ...base,
        highDates: [at(0), at(other), at(3)].sort(),
        bracketed: at(dropIndex),
        rule: 'exception2',
        confirmedOn: at(3),
      };
    }
  }
  return pending;
}

/**
 * Mucus peak days: last day of the best quality within a patch of mucus, followed by
 * three consecutive days of observed lower quality.
 */
export function findMucusPeaks(obs: Map<string, MucusCategory>, from: string, to: string): MucusPeak[] {
  const peaks: MucusPeak[] = [];
  let patchBest = -1;
  for (const date of dateRange(from, to)) {
    const cat = obs.get(date);
    if (cat === undefined) continue;
    if (cat <= 1) {
      patchBest = -1;
      continue;
    }
    if (cat < patchBest) continue;
    patchBest = cat;
    const next = [1, 2, 3].map((k) => obs.get(addDays(date, k)));
    if (next.every((c) => c !== undefined && c < cat)) {
      peaks.push({ peak: date, category: cat, confirmedOn: addDays(date, 3) });
    }
  }
  return peaks;
}

function buildCycle(
  start: string,
  nextStart: string | null,
  lastDate: string,
  byDate: Map<string, DayData>,
  excluded: Set<string>,
  afterPill: Set<string>,
): Cycle {
  const end = nextStart ? addDays(nextStart, -1) : null;
  const to = end ?? lastDate;
  const days = dateRange(start, maxDate(start, to));
  const length = nextStart ? diffDays(start, nextStart) : null;

  // Period length: bleeding days from the start, tolerating a single-day gap.
  let periodLast = start;
  for (const date of days) {
    if (diffDays(periodLast, date) > 2) break;
    if (isAnyBleeding(byDate.get(date))) periodLast = date;
  }
  const periodLength = diffDays(start, periodLast) + 1;
  const intermenstrualBleeding = days.filter((d) => d > addDays(periodLast, 2) && isAnyBleeding(byDate.get(d)));

  const readings: { date: string; value: number }[] = [];
  const ignoredExclusions: string[] = [];
  const mucus = new Map<string, MucusCategory>();
  let firstPositiveLh: string | null = null;
  for (const date of days) {
    const d = byDate.get(date);
    if (!d) continue;
    if (d.temperature) {
      const value = roundReading(d.temperature.value);
      if (d.temperature.exclude) {
        // Sensiplan sets aside a reading the user judges disturbed, provided the disturbance is
        // noted. A reading marked excluded without one still counts.
        if (d.temperature.disturbances?.length) continue;
        ignoredExclusions.push(date);
      }
      readings.push({ date, value });
    }
    if (d.mucus && !d.mucus.exclude) mucus.set(date, mucusCategory(d.mucus));
    if (d.lh === 'positive' && !firstPositiveLh) firstPositiveLh = date;
  }

  const afterHormonalContraception = afterPill.has(start);
  let temperature = evaluateTemperature(readings);
  if (afterHormonalContraception && temperature?.status === 'confirmed') temperature = awaitExtraDay(temperature, readings);
  const peaks = findMucusPeaks(mucus, start, to);
  const confirmedTemp = temperature?.status === 'confirmed' ? temperature : null;

  // Double check: the peak counts once the temperature rule is complete and three lower days have
  // passed, unless mucus of the peak's quality returns before then (the evaluation restarts at
  // the new peak). The first peak that holds is the cycle's peak; whichever sign completes later
  // decides when the infertile phase begins.
  const doubleCheck = confirmedTemp
    ? peaks
        .map((p) => ({ peak: p, from: maxDate(confirmedTemp.confirmedOn!, p.confirmedOn) }))
        .find(({ peak, from }) => !dateRange(addDays(peak.peak, 1), from).some((d) => (mucus.get(d) ?? -1) >= peak.category))
    : undefined;
  const mucusPeak = doubleCheck?.peak ?? peaks.at(-1) ?? null;

  let ovulation: Ovulation | null = null;
  if (confirmedTemp) {
    const date = addDays(confirmedTemp.firstHigh, -1);
    const peakNear = mucusPeak && Math.abs(diffDays(mucusPeak.peak, date)) <= 3;
    ovulation = { date, method: peakNear ? 'temperature+mucus' : 'temperature', confirmed: true };
  } else if (mucusPeak) {
    ovulation = { date: mucusPeak.peak, method: 'mucus', confirmed: false };
  } else if (firstPositiveLh) {
    ovulation = { date: addDays(firstPositiveLh, 1), method: 'lh', confirmed: false };
  }
  if (ovulation && end && ovulation.date > end) ovulation = null;

  const ovulationDay = ovulation ? diffDays(start, ovulation.date) + 1 : null;
  const luteal = length !== null && ovulation?.confirmed && ovulationDay ? length - ovulationDay : null;

  const postOvulatoryInfertileFrom = doubleCheck?.from ?? null;

  return {
    start,
    end,
    length,
    periodLength,
    excluded: excluded.has(start),
    afterHormonalContraception,
    ignoredExclusions,
    implausible: length !== null && (length < MIN_CYCLE_LENGTH || length > MAX_PLAUSIBLE_CYCLE),
    intermenstrualBleeding,
    temperature,
    mucusPeak,
    firstPositiveLh,
    ovulation,
    ovulationDay,
    lutealLength: luteal !== null && luteal >= 5 && luteal <= 20 ? luteal : null,
    postOvulatoryInfertileFrom: postOvulatoryInfertileFrom && (!end || postOvulatoryInfertileFrom <= end) ? postOvulatoryInfertileFrom : null,
  };
}

/**
 * First cycle after hormonal contraception: Sensiplan waits for one more reading above the cover
 * line after the temperature rule is complete. Until it exists (or if it isn't higher), the
 * shift stays pending.
 */
function awaitExtraDay(shift: TemperatureShift, readings: { date: string; value: number }[]): TemperatureShift {
  const next = readings.find((r) => r.date > shift.confirmedOn!);
  if (!next || next.value <= shift.coverline + EPS) {
    const { firstHigh, coverline, lowDates, highDates, bracketed } = shift;
    return { status: 'pending', firstHigh, coverline, lowDates, highDates, bracketed };
  }
  return { ...shift, highDates: [...shift.highDates, next.date], confirmedOn: next.date, extraDay: true };
}

export function buildCycles(
  entries: DayEntry[],
  settings: Pick<Settings, 'excludedCycles'> & Partial<Pick<Settings, 'afterHormonalContraception'>>,
  today: string,
): Cycle[] {
  const byDate = new Map(entries.map((e) => [e.date, e.data]));
  const dates = [...byDate.keys()].sort();
  const starts = findPeriodStarts(byDate, dates);
  const excluded = new Set(settings.excludedCycles);
  const afterPill = new Set(settings.afterHormonalContraception ?? []);
  const lastDate = maxDate(dates.at(-1) ?? today, today);
  return starts.map((s, i) => buildCycle(s, starts[i + 1] ?? null, lastDate, byDate, excluded, afterPill));
}

// ---------------------------------------------------------------- statistics

export function computeStats(cycles: Cycle[]): Stats {
  const usable = cycles.filter((c) => c.length !== null && !c.excluded && !c.implausible).slice(-STATS_WINDOW);
  const lengths = usable.map((c) => c.length!);
  const lutealAll = cycles
    .filter((c) => !c.excluded && c.lutealLength !== null)
    .slice(-STATS_WINDOW)
    .map((c) => c.lutealLength!);
  const periods = cycles.filter((c) => !c.excluded && c.end !== null).slice(-STATS_WINDOW).map((c) => c.periodLength);

  const count = lengths.length;
  const m = count ? mean(lengths) : null;
  const variation = count ? Math.max(...lengths) - Math.min(...lengths) : null;

  let regularity: Regularity = 'unknown';
  if (count >= 3 && variation !== null) {
    regularity = variation <= 7 ? 'regular' : variation <= 9 ? 'borderline' : 'irregular';
  }
  let frequency: Frequency = 'unknown';
  if (count >= 3 && m !== null) frequency = m < 24 ? 'frequent' : m > 38 ? 'infrequent' : 'normal';

  return {
    count,
    mean: m === null ? null : round1(m),
    median: count ? median(lengths) : null,
    sd: count >= 2 ? round1(sd(lengths)) : null,
    min: count ? Math.min(...lengths) : null,
    max: count ? Math.max(...lengths) : null,
    variation,
    periodMean: periods.length ? round1(mean(periods)) : null,
    lutealMean: lutealAll.length ? round1(mean(lutealAll)) : null,
    lutealSd: lutealAll.length >= 2 ? round1(sd(lutealAll)) : null,
    lutealCount: lutealAll.length,
    regularity,
    frequency,
  };
}

/** Cycle length used for predictions: trimmed mean once there is enough history. */
function predictionLength(cycles: Cycle[], fallback: number): number {
  const lengths = cycles
    .filter((c) => c.length !== null && !c.excluded && !c.implausible)
    .slice(-STATS_WINDOW)
    .map((c) => c.length!);
  if (!lengths.length) return fallback;
  if (lengths.length >= 5) {
    const s = [...lengths].sort((a, b) => a - b).slice(1, -1);
    return mean(s);
  }
  return mean(lengths);
}

function confidenceOf(stats: Stats): Confidence {
  if (stats.regularity === 'irregular' || stats.count < 3) return 'low';
  if (stats.count >= 6 && (stats.sd ?? 99) <= 2) return 'high';
  if ((stats.sd ?? 99) <= 4) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------- predictions & status

export function analyze(entries: DayEntry[], settings: Settings, today: string): Analysis {
  const cycles = buildCycles(entries, settings, today);
  const stats = computeStats(cycles);
  const warnings: string[] = [];
  const basis = stats.count > 0 ? 'personal' : 'defaults';
  const confidence = confidenceOf(stats);

  if (stats.count < 3) warnings.push('few-cycles');
  if (stats.regularity === 'irregular') warnings.push('irregular');
  if (stats.frequency === 'frequent') warnings.push('frequent');
  if (stats.frequency === 'infrequent') warnings.push('infrequent');
  if (cycles.some((c) => c.implausible && !c.excluded)) warnings.push('implausible-cycle');

  const current = cycles.at(-1);
  const nfp = nfpStatus(cycles, settings, today, entries);

  if (!current || settings.paused || today < current.start) {
    return { cycles, stats, basis, confidence, current: null, predictions: [], nfp, warnings };
  }

  const cycleLen = predictionLength(cycles, settings.defaultCycleLength);
  const cycleSpread = stats.count >= 3 ? Math.max(1, Math.round(stats.sd ?? 0)) : stats.count >= 1 ? 3 : 4;
  const personalLuteal = stats.lutealCount >= 2;
  const luteal = personalLuteal ? stats.lutealMean! : DEFAULT_LUTEAL;
  const lutealSpread = personalLuteal ? Math.max(1, Math.round(stats.lutealSd ?? 1)) : DEFAULT_LUTEAL_SD;
  const periodLen = Math.round(stats.periodMean ?? settings.defaultPeriodLength);

  // ---- current cycle
  const confirmedOv = current.ovulation?.confirmed ? current.ovulation : null;
  const lh = !confirmedOv && current.firstPositiveLh ? current.firstPositiveLh : null;
  const mucusPeak = !confirmedOv && !lh && current.mucusPeak ? current.mucusPeak.peak : null;

  let nextStart: Range;
  let ovulation: Range;
  if (confirmedOv) {
    ovulation = range(confirmedOv.date, 0);
    nextStart = range(addDays(confirmedOv.date, Math.round(luteal) + 1), lutealSpread);
  } else {
    nextStart = range(addDays(current.start, Math.round(cycleLen)), cycleSpread);
    if (lh) {
      // LH surge precedes ovulation by ~24–36 h.
      ovulation = { date: addDays(lh, 1), earliest: lh, latest: addDays(lh, 2) };
    } else if (mucusPeak) {
      ovulation = range(mucusPeak, 1);
    } else {
      const spread = Math.round(Math.sqrt(cycleSpread ** 2 + lutealSpread ** 2));
      ovulation = range(addDays(nextStart.date, -Math.round(luteal) - 1), spread);
      // Ovulation can't precede the period's end in practice.
      if (ovulation.earliest <= addDays(current.start, periodLen - 1)) ovulation.earliest = addDays(current.start, periodLen);
    }
  }

  // Current period: over once a later day was logged without bleeding, else assume the usual length.
  const byDate = new Map(entries.map((e) => [e.date, e.data]));
  const loggedPeriodEnd = addDays(current.start, current.periodLength - 1);
  const loggedAfter = dateRange(addDays(loggedPeriodEnd, 1), today).some((d) => byDate.has(d));
  const expectedEnd = addDays(current.start, periodLen - 1);
  const periodEnd = loggedAfter || loggedPeriodEnd > expectedEnd ? loggedPeriodEnd : expectedEnd;

  const predictions: PredictedCycle[] = [
    {
      start: { date: current.start, earliest: current.start, latest: current.start },
      ovulation,
      ...fertileWindow(ovulation),
      periodEnd,
    },
  ];

  // ---- late period
  const daysLate = Math.max(0, diffDays(nextStart.latest, today));
  let base = nextStart;
  if (daysLate > 0) base = { date: addDays(today, 1), earliest: addDays(today, 1), latest: addDays(today, 1 + cycleSpread) };

  // ---- upcoming cycles
  for (let k = 0; k < 3; k++) {
    const spread = Math.round(cycleSpread * Math.sqrt(k + 1));
    const start = k === 0 ? base : range(addDays(base.date, Math.round(cycleLen * k)), spread);
    const ovSpread = Math.round(Math.sqrt(spread ** 2 + lutealSpread ** 2));
    const ov = range(addDays(start.date, Math.round(cycleLen - luteal) - 1), ovSpread);
    const minOv = addDays(start.date, periodLen);
    if (ov.earliest < minOv) ov.earliest = minOv;
    predictions.push({ start, ovulation: ov, ...fertileWindow(ov), periodEnd: addDays(start.date, periodLen - 1) });
  }

  // ---- status today
  const cycleDay = diffDays(current.start, today) + 1;
  const inPeriod = today <= predictions[0]!.periodEnd;
  const cur = predictions[0]!;
  let phase: CurrentStatus['phase'];
  if (daysLate > 0) phase = 'late';
  else if (inPeriod) phase = 'period';
  else if (today >= cur.peakFertileStart && today <= cur.peakFertileEnd) phase = 'peak-fertile';
  else if (today >= cur.fertileStart && today <= cur.fertileEnd) phase = 'fertile';
  else if (today > cur.fertileEnd) phase = 'luteal';
  else phase = 'follicular';

  const unprotectedInWindow = dateRange(cur.fertileStart, cur.fertileEnd).some((d) => byDate.get(d)?.sex === 'unprotected');
  const positivePregnancyTest =
    dateRange(current.start, today).find((d) => byDate.get(d)?.pregnancyTest === 'positive') ?? null;

  if (daysLate > 0) warnings.push('late');

  return {
    cycles,
    stats,
    basis,
    confidence,
    current: {
      cycleStart: current.start,
      cycleDay,
      inPeriod,
      phase,
      daysLate,
      temperaturePending: current.temperature?.status === 'pending' ? current.temperature : null,
      lhSurgeToday: byDate.get(today)?.lh === 'positive',
      suggestPregnancyTest: daysLate > 0 && unprotectedInWindow && !positivePregnancyTest,
      positivePregnancyTest,
    },
    predictions,
    nfp,
    warnings,
  };
}

function fertileWindow(ov: Range) {
  return {
    fertileStart: addDays(ov.earliest, -5),
    fertileEnd: addDays(ov.latest, 1),
    peakFertileStart: addDays(ov.date, -2),
    peakFertileEnd: ov.date,
  };
}

// ---------------------------------------------------------------- Sensiplan evaluation

/**
 * Minus-8 needs the exact first higher reading: a confirmed shift, and the day before it measured
 * and counted (after a gap, the rise may have started on the missing day).
 */
const fullyEvaluated = (c: Cycle) =>
  c.temperature?.status === 'confirmed' && c.temperature.lowDates.at(-1) === addDays(c.temperature.firstHigh, -1);

export function nfpStatus(cycles: Cycle[], settings: Settings, today: string, entries: DayEntry[]): NfpStatus {
  if (settings.goal !== 'avoid' || !settings.nfpAcknowledged) {
    return { kind: 'unavailable', reason: 'not-enabled' };
  }
  if (!settings.track.temperature || !settings.track.mucus) {
    return { kind: 'unavailable', reason: 'needs-temperature-and-mucus' };
  }
  const current = cycles.at(-1);
  if (!current || today < current.start) return { kind: 'unavailable', reason: 'no-cycle' };
  if (settings.paused) return { kind: 'unavailable', reason: 'paused' };

  // Post-ovulatory: double check complete.
  const post = current.postOvulatoryInfertileFrom;
  if (post && today >= post) {
    return { kind: 'infertile-post', since: post, fromEvening: today === post };
  }
  if (current.ovulation || current.temperature) {
    return { kind: 'fertile', reason: post ? 'double-check-pending' : 'evaluation-in-progress' };
  }

  // Pre-ovulatory: 5-day rule / minus-8 rule. None in the first cycle after hormonal contraception.
  if (current.afterHormonalContraception) return { kind: 'fertile', reason: 'after-hormonal-contraception' };
  const previous = cycles.at(-2);
  // Every fully evaluated cycle counts for minus-8, including those excluded from the statistics.
  const tempCycles = cycles.slice(0, -1).filter(fullyEvaluated);
  if (!previous || previous.temperature?.status !== 'confirmed') {
    return { kind: 'fertile', reason: 'no-shift-previous-cycle' };
  }
  const earliestFirstHigh = Math.min(...tempCycles.map((c) => diffDays(c.start, c.temperature!.firstHigh) + 1));
  const minus8 = earliestFirstHigh - 8;
  let lastInfertileDay: number;
  let rule: '5-day' | 'minus-8';
  if (tempCycles.length >= 12) {
    lastInfertileDay = minus8;
    rule = 'minus-8';
  } else if (minus8 < 5) {
    lastInfertileDay = minus8;
    rule = 'minus-8';
  } else {
    lastInfertileDay = 5;
    rule = '5-day';
  }

  // Any mucus sensation/sign (f or better) or cervix change ends the infertile phase.
  const byDate = new Map(entries.map((e) => [e.date, e.data]));
  const sign = dateRange(current.start, today).find((d) => {
    const data = byDate.get(d);
    return (data?.mucus && !data.mucus.exclude && mucusCategory(data.mucus) >= 2) ||
      (data?.cervix && (data.cervix.opening === 'medium' || data.cervix.opening === 'open' || data.cervix.firmness === 'soft'));
  });
  let lastDay = addDays(current.start, lastInfertileDay - 1);
  if (sign && sign <= lastDay) lastDay = addDays(sign, -1);
  if (lastInfertileDay >= 1 && today <= lastDay) return { kind: 'infertile-pre', rule, lastDay };
  return { kind: 'fertile', reason: sign ? 'mucus-observed' : 'pre-ovulatory-phase-ended' };
}
