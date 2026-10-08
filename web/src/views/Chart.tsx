import { useState } from 'react';
import { addDays, dateRange, diffDays } from '../../../shared/dates.ts';
import { MUCUS_LABELS, mucusCategory, roundReading, type Cycle } from '../../../shared/engine.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { fmtDate, fmtTemp, toDisplayTemp } from '../format.ts';
import { useT } from '../i18n.tsx';
import { Icon } from '../ui.tsx';

const COL = 24;
const LEFT = 46;
const TOP = 12;
const PLOT_H = 210;
const ROW = 22;

export function ChartView() {
  const { analysis, today } = useStore();
  const t = useT();
  const [index, setIndex] = useState<number | null>(null);
  const cycles = analysis.cycles;
  const i = index ?? cycles.length - 1;
  const cycle = cycles[i];

  return (
    <>
      <header className="page-header">
        <h1>{t.chart.title}</h1>
      </header>
      {!cycle ? (
        <div className="card">
          <p className="muted">{t.chart.empty}</p>
        </div>
      ) : (
        <div className="stack">
          <div className="card spread">
            <button className="icon-btn" aria-label={t.chart.previous} disabled={i === 0} onClick={() => setIndex(i - 1)}>
              <Icon name="left" />
            </button>
            <div className="center">
              <h2 style={{ margin: 0 }}>
                {fmtDate(cycle.start)} – {cycle.end ? fmtDate(cycle.end) : t.chart.now}
              </h2>
              <div className="small muted">
                {cycle.length ? t.common.days(cycle.length) : t.chart.current(diffDays(cycle.start, today) + 1)}
                {cycle.excluded && t.chart.excluded}
              </div>
            </div>
            <button className="icon-btn" aria-label={t.chart.next} disabled={i >= cycles.length - 1} onClick={() => setIndex(i + 1)}>
              <Icon name="right" />
            </button>
          </div>
          <div className="card">
            <CycleChart cycle={cycle} to={cycle.end ?? today} />
          </div>
          <Evaluation cycle={cycle} />
        </div>
      )}
    </>
  );
}

function Evaluation({ cycle }: { cycle: Cycle }) {
  const { settings } = useStore();
  const t = useT();
  const c = t.chart;
  const unit = settings.temperatureUnit;
  const temp = cycle.temperature;
  const day = (d: string) => diffDays(cycle.start, d) + 1;
  return (
    <div className="card list small">
      <div>
        <strong>{c.temperature}</strong>
        {!temp
          ? c.noShift
          : temp.status === 'confirmed'
            ? c.shiftConfirmed(day(temp.confirmedOn!), c.rules[temp.rule!], day(temp.firstHigh), fmtTemp(temp.coverline, unit))
            : c.shiftPending(temp.highDates.length, fmtTemp(temp.coverline, unit))}
        {cycle.afterHormonalContraception && c.afterPill}
      </div>
      {cycle.ignoredExclusions.length > 0 && <div>{c.exclusionIgnored(cycle.ignoredExclusions.map((d) => c.dayN(day(d))).join(', '))}</div>}
      <div>
        <strong>{c.mucusPeak}</strong>
        {cycle.mucusPeak
          ? c.peakFound(day(cycle.mucusPeak.peak), MUCUS_LABELS[cycle.mucusPeak.category], day(cycle.mucusPeak.confirmedOn))
          : c.peakNone}
      </div>
      <div>
        <strong>{c.ovulation}</strong>
        {cycle.ovulation && cycle.ovulationDay !== null ? c.ovulationFound(cycle.ovulationDay, t.method[cycle.ovulation.method]) : c.ovulationNone}
        {cycle.lutealLength !== null && c.luteal(cycle.lutealLength)}
      </div>
      {cycle.postOvulatoryInfertileFrom && (
        <div>
          <strong>{c.doubleCheck}</strong>
          {c.doubleCheckDone(day(cycle.postOvulatoryInfertileFrom))}
        </div>
      )}
      {cycle.intermenstrualBleeding.length > 0 && (
        <div>
          <strong>{c.bleedingBetween}</strong>
          {cycle.intermenstrualBleeding.map((d) => c.dayN(day(d))).join(', ')}.
        </div>
      )}
    </div>
  );
}

function CycleChart({ cycle, to }: { cycle: Cycle; to: string }) {
  const { days, settings } = useStore();
  const c = useT().chart;
  const unit = settings.temperatureUnit;
  const dates = dateRange(cycle.start, to);
  const n = Math.max(dates.length, 28);
  const width = LEFT + n * COL + 8;

  // Plotted as evaluated: rounded to 0.05 °C, excluded only where the temperature rule accepts it.
  const ignored = new Set(cycle.ignoredExclusions);
  const readings = dates
    .map((d, i) => {
      const t = days.get(d)?.temperature;
      return t && { i, d, value: toDisplayTemp(roundReading(t.value), unit), excluded: !!t.exclude && !ignored.has(d) };
    })
    .filter((r): r is NonNullable<typeof r> => !!r);
  const values = readings.map((r) => r.value);
  const step = unit === 'F' ? 0.2 : 0.1;
  const minSpan = unit === 'F' ? 1.6 : 0.9;
  let lo = values.length ? Math.min(...values) - step : unit === 'F' ? 97.2 : 36.2;
  let hi = values.length ? Math.max(...values) + step : lo + minSpan;
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const y = (v: number) => TOP + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
  const x = (i: number) => LEFT + i * COL + COL / 2;

  const t = cycle.temperature;
  const high = new Set(t?.highDates);
  const low = new Set(t?.lowDates);
  // The curve breaks at an excluded reading and at a day without one (Sensiplan): its neighbours
  // are not joined.
  const segments: (typeof readings)[] = [];
  readings.forEach((r, k) => {
    if (r.excluded) return;
    const prev = readings[k - 1];
    if (!prev || prev.excluded || prev.i !== r.i - 1) segments.push([]);
    segments.at(-1)!.push(r);
  });
  const peak = cycle.mucusPeak?.peak;
  const rowsTop = TOP + PLOT_H + 10;
  const height = rowsTop + ROW * 4 + 6;
  const ticks = Math.round((hi - lo) / step);

  return (
    // Time runs left to right in every language.
    <div className="chart-scroll" dir="ltr">
      <svg className="chart" width={width} height={height} role="img" aria-label={c.aria}>
        {/* grid */}
        {Array.from({ length: ticks + 1 }, (_, k) => {
          const v = lo + k * step;
          return (
            <g key={k}>
              <line x1={LEFT} x2={width - 8} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth={k % 2 ? 0.5 : 1} />
              {k % 2 === 0 && (
                <text x={LEFT - 6} y={y(v) + 4} fontSize="10" textAnchor="end">
                  {v.toFixed(unit === 'F' ? 1 : 2)}
                </text>
              )}
            </g>
          );
        })}

        {/* ovulation column */}
        {cycle.ovulation && (
          <rect
            x={LEFT + diffDays(cycle.start, cycle.ovulation.date) * COL}
            y={TOP}
            width={COL}
            height={PLOT_H}
            fill="var(--ovulation-soft)"
            opacity={cycle.ovulation.confirmed ? 1 : 0.6}
          />
        )}

        {/* cover line */}
        {t && (
          <g>
            <line
              x1={x(diffDays(cycle.start, t.lowDates[0]!)) - COL / 2}
              x2={width - 8}
              y1={y(toDisplayTemp(t.coverline, unit))}
              y2={y(toDisplayTemp(t.coverline, unit))}
              stroke="var(--ovulation)"
              strokeWidth="1.5"
              strokeDasharray="5 4"
            />
            <text x={width - 10} y={y(toDisplayTemp(t.coverline, unit)) - 5} fontSize="10" textAnchor="end" style={{ fill: 'var(--ovulation)' }}>
              {c.coverLine}
            </text>
          </g>
        )}

        {/* temperature curve (valid readings only) */}
        {segments
          .filter((s) => s.length > 1)
          .map((s) => (
            <polyline
              key={s[0]!.d}
              fill="none"
              stroke="var(--text)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              points={s.map((r) => `${x(r.i)},${y(r.value)}`).join(' ')}
            />
          ))}
        {readings.map((r) => {
          const cx = x(r.i);
          const cy = y(r.value);
          if (r.excluded) {
            return (
              <g key={r.d} stroke="var(--muted)" strokeWidth="1.5">
                <circle cx={cx} cy={cy} r="4" fill="var(--surface)" />
                <line x1={cx - 3} y1={cy - 3} x2={cx + 3} y2={cy + 3} />
              </g>
            );
          }
          const fill = high.has(r.d) ? 'var(--ovulation)' : low.has(r.d) ? 'var(--fertile)' : 'var(--text)';
          return (
            <circle
              key={r.d}
              cx={cx}
              cy={cy}
              r="4"
              fill={fill}
              stroke="var(--surface)"
              strokeWidth="1.5"
              onClick={() => navigate(`/day/${r.d}`)}
            />
          );
        })}

        {/* rows */}
        {[c.rows.day, c.rows.bleeding, c.rows.mucus, c.rows.tests].map((label, k) => (
          <text key={k} x={4} y={rowsTop + k * ROW + 15} fontSize="10" fontWeight="600">
            {label}
          </text>
        ))}
        {Array.from({ length: n }, (_, i) => {
          const d = addDays(cycle.start, i);
          const data = days.get(d);
          const cx = x(i);
          const m = data?.mucus && !data.mucus.exclude ? mucusCategory(data.mucus) : null;
          const afterPeak = peak ? diffDays(peak, d) : null;
          const b = data?.bleeding;
          const bleedH = b ? { spotting: 4, light: 8, medium: 12, heavy: 16 }[b.value] : 0;
          return (
            <g key={d} onClick={() => i < dates.length && navigate(`/day/${d}`)}>
              <text x={cx} y={rowsTop + 15} fontSize="10" textAnchor="middle" fontWeight={i % 7 === 0 ? 700 : 400}>
                {i + 1}
              </text>
              {b && (
                <rect
                  x={cx - 6}
                  y={rowsTop + ROW + (18 - bleedH) / 2 + 2}
                  width="12"
                  height={bleedH}
                  rx="3"
                  fill={b.exclude ? 'none' : 'var(--period)'}
                  stroke="var(--period)"
                />
              )}
              {m !== null && (
                <text
                  x={cx}
                  y={rowsTop + 2 * ROW + 15}
                  fontSize="10"
                  textAnchor="middle"
                  fontWeight={m >= 3 ? 700 : 400}
                  style={{ fill: m >= 3 ? 'var(--fertile)' : undefined }}
                >
                  {afterPeak === 0 ? 'P' : MUCUS_LABELS[m]}
                </text>
              )}
              {afterPeak !== null && afterPeak >= 1 && afterPeak <= 3 && (
                <text x={cx} y={rowsTop + 2 * ROW + 4} fontSize="8" textAnchor="middle">
                  {afterPeak}
                </text>
              )}
              {data?.lh === 'positive' && (
                <text x={cx} y={rowsTop + 3 * ROW + 15} fontSize="9" textAnchor="middle" fontWeight="700" style={{ fill: 'var(--fertile)' }}>
                  LH
                </text>
              )}
              {data?.sex && data.lh !== 'positive' && (
                <text x={cx} y={rowsTop + 3 * ROW + 15} fontSize="11" textAnchor="middle">
                  {data.sex === 'unprotected' ? '♥' : '♡'}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
