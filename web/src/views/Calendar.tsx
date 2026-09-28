import { useMemo, useState } from 'react';
import { addDays, toEpochDay } from '../../../shared/dates.ts';
import type { DayData } from '../../../shared/schema.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { buildMarks, marksInputFromAnalysis, type MarkInput } from '../marks.ts';
import { fmtDate, fmtMonth, weekdayNames } from '../format.ts';
import { useI18n, useT } from '../i18n.tsx';
import { Icon } from '../ui.tsx';

function monthStart(date: string) {
  return `${date.slice(0, 7)}-01`;
}

function shiftMonth(first: string, delta: number) {
  const [y, m] = first.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
}

export function CalendarView() {
  const { analysis, days, today } = useStore();
  const t = useT();
  const input = useMemo(() => marksInputFromAnalysis(analysis), [analysis]);
  return (
    <>
      <header className="page-header">
        <h1>{t.calendar.title}</h1>
      </header>
      <MonthCalendar input={input} days={days} today={today} onSelect={(date) => navigate(`/day/${date}`)} />
      <Legend />
    </>
  );
}

/** Month grid; read-only when `onSelect` is omitted (partner view). */
export function MonthCalendar(props: { input: MarkInput; days: Map<string, DayData>; today: string; onSelect?: (date: string) => void }) {
  const { input, days, today, onSelect } = props;
  const { t, lang } = useI18n();
  const a = t.calendar.aria;
  const [month, setMonth] = useState(() => monthStart(today));
  const marks = useMemo(() => buildMarks(input, days, today), [input, days, today]);
  const dow = useMemo(() => weekdayNames(), [lang]);

  // Monday-first grid covering the month.
  const weekday = (new Date(`${month}T00:00:00Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(month, -weekday);
  const nextMonth = shiftMonth(month, 1);
  const cells = Math.ceil((weekday + (toEpochDay(nextMonth) - toEpochDay(month))) / 7) * 7;

  return (
    <div className="card">
      <div className="cal-head">
        <button className="icon-btn" aria-label={t.calendar.previous} onClick={() => setMonth(shiftMonth(month, -1))}>
          <Icon name="left" />
        </button>
        <button className="linklike cal-title" onClick={() => setMonth(monthStart(today))} aria-live="polite" title={t.calendar.thisMonth}>
          {fmtMonth(month)}
        </button>
        <button className="icon-btn" aria-label={t.calendar.next} onClick={() => setMonth(nextMonth)}>
          <Icon name="right" />
        </button>
      </div>
      <div className="cal-grid">
        {dow.map((d, i) => (
          <div className="cal-dow" key={i}>
            {d}
          </div>
        ))}
        {Array.from({ length: cells }, (_, i) => {
          const date = addDays(gridStart, i);
          const m = marks.get(date);
          const data = days.get(date);
          const cls = ['cal-day', date < month || date >= nextMonth ? 'out' : '', date === today ? 'today' : '', ...(m ?? [])]
            .filter(Boolean)
            .join(' ');
          const dots = data
            ? [data.temperature, data.mucus, data.sex, data.lh === 'positive' ? 1 : undefined, data.note, data.symptoms?.length ? 1 : undefined].filter(Boolean).length
            : 0;
          const label = [
            fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' }),
            m?.has('period') && a.period,
            m?.has('spotting') && a.spotting,
            m?.has('pred-period') && a.predicted,
            m?.has('peak') ? a.peak : m?.has('fertile') && a.fertile,
            m?.has('ovulation') && (m.has('estimated') ? a.ovulationEstimated : a.ovulationConfirmed),
          ]
            .filter(Boolean)
            .join(lang === 'ar' ? '، ' : ', ');
          const content = (
            <>
              {Number(date.slice(8))}
              {dots > 0 && (
                <span className="marks" aria-hidden="true">
                  {Array.from({ length: Math.min(dots, 3) }, (_, k) => (
                    <i key={k} />
                  ))}
                </span>
              )}
            </>
          );
          return onSelect ? (
            <button key={date} className={cls} aria-label={label} disabled={date > today} onClick={() => onSelect(date)}>
              {content}
            </button>
          ) : (
            <div key={date} className={cls} role="img" aria-label={label}>
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Legend({ fertility = true }: { fertility?: boolean }) {
  const l = useT().calendar.legend;
  return (
    <div className="card legend" style={{ marginTop: 12 }}>
      <span>
        <i className="dot" style={{ background: 'var(--period)' }} /> {l.period}
      </span>
      <span>
        <i className="dot" style={{ background: 'var(--period-soft)', outline: '1.5px solid var(--period)' }} /> {l.predicted}
      </span>
      {fertility && (
        <>
          <span>
            <i className="dot" style={{ background: 'var(--fertile-soft)' }} /> {l.fertile}
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--fertile)' }} /> {l.peak}
          </span>
          <span>
            <i className="dot" style={{ border: '2px solid var(--ovulation)' }} /> {l.ovulation}
          </span>
        </>
      )}
      <span>
        <i className="dot" style={{ background: 'var(--muted)', width: 5, height: 5 }} /> {l.logged}
      </span>
    </div>
  );
}
