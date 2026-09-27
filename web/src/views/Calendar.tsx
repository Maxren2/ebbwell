import { useMemo, useState } from 'react';
import { addDays, toEpochDay } from '../../../shared/dates.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { buildMarks } from '../marks.ts';
import { fmtDate, fmtMonth } from '../format.ts';
import { Icon } from '../ui.tsx';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  const [month, setMonth] = useState(() => monthStart(today));
  const marks = useMemo(() => buildMarks(analysis, days, today), [analysis, days, today]);

  // Monday-first grid covering the month.
  const weekday = (new Date(`${month}T00:00:00Z`).getUTCDay() + 6) % 7;
  const gridStart = addDays(month, -weekday);
  const nextMonth = shiftMonth(month, 1);
  const cells = Math.ceil((weekday + (toEpochDay(nextMonth) - toEpochDay(month))) / 7) * 7;

  return (
    <>
      <header className="page-header">
        <h1>Calendar</h1>
        {month !== monthStart(today) && (
          <button className="btn" onClick={() => setMonth(monthStart(today))}>
            Today
          </button>
        )}
      </header>

      <div className="card">
        <div className="cal-head">
          <button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
            <Icon name="left" />
          </button>
          <h2 aria-live="polite">{fmtMonth(month)}</h2>
          <button className="icon-btn" aria-label="Next month" onClick={() => setMonth(nextMonth)}>
            <Icon name="right" />
          </button>
        </div>
        <div className="cal-grid">
          {DOW.map((d) => (
            <div className="cal-dow" key={d}>
              {d}
            </div>
          ))}
          {Array.from({ length: cells }, (_, i) => {
            const date = addDays(gridStart, i);
            const m = marks.get(date);
            const data = days.get(date);
            const future = date > today;
            const cls = [
              'cal-day',
              date < month || date >= nextMonth ? 'out' : '',
              date === today ? 'today' : '',
              ...(m ?? []),
            ]
              .filter(Boolean)
              .join(' ');
            const dots = data ? [data.temperature, data.mucus, data.sex, data.lh === 'positive' ? 1 : undefined, data.note].filter(Boolean).length : 0;
            const label = [
              fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long' }),
              m?.has('period') && 'period',
              m?.has('spotting') && 'spotting',
              m?.has('pred-period') && 'predicted period',
              m?.has('peak') ? 'peak fertility' : m?.has('fertile') && 'fertile window',
              m?.has('ovulation') && (m.has('estimated') ? 'estimated ovulation' : 'confirmed ovulation'),
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <button
                key={date}
                className={cls}
                aria-label={label}
                disabled={future}
                onClick={() => navigate(`/day/${date}`)}
              >
                {Number(date.slice(8))}
                {dots > 0 && (
                  <span className="marks" aria-hidden="true">
                    {Array.from({ length: Math.min(dots, 3) }, (_, k) => (
                      <i key={k} />
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="card legend" style={{ marginTop: 12 }}>
        <span>
          <i className="dot" style={{ background: 'var(--period)' }} /> Period
        </span>
        <span>
          <i className="dot pred" style={{ background: 'var(--period-soft)', outline: '1.5px solid var(--period)' }} /> Predicted period
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--fertile-soft)' }} /> Fertile window
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--fertile)' }} /> Peak fertility
        </span>
        <span>
          <i className="dot" style={{ border: '2px solid var(--ovulation)' }} /> Ovulation (dashed = estimated)
        </span>
        <span>
          <i className="dot" style={{ background: 'var(--muted)', width: 5, height: 5 }} /> Logged data
        </span>
      </div>
    </>
  );
}
