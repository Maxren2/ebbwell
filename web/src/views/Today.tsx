import { useState } from 'react';
import { addDays, diffDays } from '../../../shared/dates.ts';
import type { Analysis, NfpStatus } from '../../../shared/engine.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { CONFIDENCE, METHOD, WARNINGS, fmtDate, fmtLong, fmtRange, fmtTemp, relDays } from '../format.ts';
import { Icon, useToast } from '../ui.tsx';

export function Today() {
  const { analysis, today, days, me, settings } = useStore();
  const current = analysis.current;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{fmtLong(today)}</h1>
          <div className="sub">Hi {me.name.split(' ')[0]}</div>
        </div>
      </header>

      <div className="stack">
        {analysis.cycles.length === 0 ? (
          <Welcome />
        ) : settings.paused ? (
          <div className="card">
            <h2>Predictions paused</h2>
            <p className="muted">Pregnancy / pause mode is on. You can keep logging; turn it off in Settings to resume predictions.</p>
          </div>
        ) : current ? (
          <>
            <Ring analysis={analysis} today={today} />
            <Alerts analysis={analysis} />
            {settings.goal === 'avoid' && <NfpCard status={analysis.nfp} />}
            <NextCards analysis={analysis} today={today} />
          </>
        ) : null}

        <TodayLog />

        {analysis.cycles.length > 0 && !days.has(today) && !current?.inPeriod && <PeriodStartButton />}

        {analysis.warnings
          .filter((w) => WARNINGS[w])
          .map((w) => (
            <div className="card tone-warn" key={w}>
              <h2>{WARNINGS[w]!.title}</h2>
              <p className="small">{WARNINGS[w]!.body}</p>
            </div>
          ))}

        <p className="hint center">
          Lune is a journal, not a medical device or contraceptive. Predictions are estimates.
        </p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ ring

function Ring({ analysis, today }: { analysis: Analysis; today: string }) {
  const current = analysis.current!;
  const cur = analysis.predictions[0]!;
  const next = analysis.predictions[1];
  const start = current.cycleStart;
  const length = Math.max(current.cycleDay, next ? diffDays(start, next.start.date) : 28);
  const idx = (d: string) => Math.min(length, Math.max(0, diffDays(start, d)));

  const R = 44;
  const arc = (from: number, to: number, color: string, width = 7, key?: string) => (
    <circle
      key={key}
      cx="50"
      cy="50"
      r={R}
      fill="none"
      stroke={color}
      strokeWidth={width}
      strokeLinecap="butt"
      pathLength={length}
      strokeDasharray={`${Math.max(0, to - from)} ${length}`}
      strokeDashoffset={-from}
      transform="rotate(-90 50 50)"
    />
  );
  const angle = (i: number) => ((i + 0.5) / length) * 2 * Math.PI - Math.PI / 2;
  const at = (i: number) => ({ x: 50 + R * Math.cos(angle(i)), y: 50 + R * Math.sin(angle(i)) });
  const t = at(idx(today));
  const ov = at(idx(cur.ovulation.date));
  const confirmed = analysis.cycles.at(-1)?.ovulation?.confirmed;

  const phase = {
    period: { label: 'Period', color: 'var(--period)' },
    follicular: { label: 'Before fertile window', color: 'var(--text)' },
    fertile: { label: 'Fertile window', color: 'var(--fertile)' },
    'peak-fertile': { label: 'Peak fertility', color: 'var(--fertile)' },
    luteal: { label: confirmed ? 'After ovulation' : 'Likely after ovulation', color: 'var(--ovulation)' },
    late: { label: `Period ${current.daysLate} day${current.daysLate > 1 ? 's' : ''} late`, color: 'var(--warn)' },
  }[current.phase];

  return (
    <div className="hero" role="img" aria-label={`Cycle day ${current.cycleDay}. ${phase.label}.`}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        {arc(0, length, 'var(--surface-2)')}
        {arc(idx(cur.fertileStart), idx(cur.fertileEnd) + 1, 'var(--fertile-soft)')}
        {arc(idx(cur.peakFertileStart), idx(cur.peakFertileEnd) + 1, 'var(--fertile)')}
        {arc(0, idx(cur.periodEnd) + 1, 'var(--period)')}
        <circle cx={ov.x} cy={ov.y} r="3.2" fill="var(--surface)" stroke="var(--ovulation)" strokeWidth="1.6" strokeDasharray={confirmed ? undefined : '1.5 1.2'} />
        <circle cx={t.x} cy={t.y} r="5" fill="var(--surface)" stroke="var(--text)" strokeWidth="2" />
      </svg>
      <div className="inner">
        <span className="day">Cycle day</span>
        <span className="big">{current.cycleDay}</span>
        <span className="phase" style={{ color: phase.color }}>
          {phase.label}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ cards

function NextCards({ analysis, today }: { analysis: Analysis; today: string }) {
  const cur = analysis.predictions[0]!;
  const next = analysis.predictions[1]!;
  const cycle = analysis.cycles.at(-1)!;
  const ovPast = cur.ovulation.latest < today;

  return (
    <div className="grid-2">
      <div className="card tone-period">
        <h3>Next period</h3>
        <div className="stat">
          <div className="value">{fmtDate(next.start.date)}</div>
          <div className="label">
            {relDays(today, next.start.date)} · {fmtRange(next.start)}
          </div>
        </div>
        <p>
          <span className={`chip ${analysis.confidence}`}>{CONFIDENCE[analysis.confidence]}</span>
        </p>
      </div>
      <div className="card tone-ovulation">
        <h3>Ovulation</h3>
        {cycle.ovulation?.confirmed ? (
          <div className="stat">
            <div className="value">{fmtDate(cycle.ovulation.date)}</div>
            <div className="label">{METHOD[cycle.ovulation.method]}</div>
          </div>
        ) : (
          <div className="stat">
            <div className="value">{ovPast ? 'Likely passed' : fmtDate(cur.ovulation.date)}</div>
            <div className="label">
              {ovPast ? `expected ${fmtRange(cur.ovulation)}` : `${relDays(today, cur.ovulation.date)} · ${fmtRange(cur.ovulation)}`}
              {cycle.ovulation && ` · ${METHOD[cycle.ovulation.method]}`}
            </div>
          </div>
        )}
        <p className="small muted">
          Fertile {fmtDate(cur.fertileStart)} – {fmtDate(cur.fertileEnd)}
        </p>
      </div>
    </div>
  );
}

function Alerts({ analysis }: { analysis: Analysis }) {
  const { settings } = useStore();
  const c = analysis.current!;
  const out: { tone: string; title: string; body: string }[] = [];
  if (c.positivePregnancyTest) {
    out.push({
      tone: 'tone-ovulation',
      title: 'Positive pregnancy test logged',
      body: `On ${fmtDate(c.positivePregnancyTest)}. You can turn on pregnancy / pause mode in Settings to stop predictions.`,
    });
  } else if (c.suggestPregnancyTest) {
    out.push({
      tone: 'tone-warn',
      title: 'Consider a pregnancy test',
      body: 'Your period is late and unprotected sex was logged during the fertile window.',
    });
  } else if (c.phase === 'late') {
    out.push({
      tone: 'tone-warn',
      title: `Period ${c.daysLate} day${c.daysLate > 1 ? 's' : ''} later than expected`,
      body: 'Stress, illness, travel or a later ovulation can delay a period. A temperature that stays high for 18+ days after ovulation can indicate pregnancy.',
    });
  }
  if (c.lhSurgeToday) {
    out.push({ tone: 'tone-fertile', title: 'LH surge today', body: 'Ovulation usually follows within 24–36 hours.' });
  }
  const pend = c.temperaturePending;
  if (pend && settings.track.temperature) {
    out.push({
      tone: 'tone-ovulation',
      title: 'Watching for a temperature shift',
      body: `${pend.highDates.length} higher reading${pend.highDates.length > 1 ? 's' : ''} above the cover line (${fmtTemp(pend.coverline, settings.temperatureUnit)}) so far. Keep measuring to confirm ovulation.`,
    });
  }
  return (
    <>
      {out.map((a) => (
        <div className={`card ${a.tone}`} key={a.title}>
          <h2>{a.title}</h2>
          <p className="small">{a.body}</p>
        </div>
      ))}
    </>
  );
}

const NFP_REASON: Record<string, string> = {
  'not-enabled': 'Enable the Sensiplan evaluation in Settings to see it.',
  'needs-temperature-and-mucus': 'Sensiplan needs both temperature and mucus tracking.',
  'no-cycle': 'Log your period first.',
  paused: 'Paused mode is on.',
  'double-check-pending': 'Waiting for both temperature and mucus to confirm.',
  'evaluation-in-progress': 'Post-ovulatory evaluation not complete: consider yourself fertile.',
  'no-shift-previous-cycle': 'No temperature shift was confirmed in the previous cycle, so the 5-day rule does not apply.',
  'mucus-observed': 'A mucus sign was observed: the fertile phase has started.',
  'pre-ovulatory-phase-ended': 'The pre-ovulatory infertile days are over.',
};

function NfpCard({ status }: { status: NfpStatus }) {
  let tone = 'tone-fertile';
  let title: string;
  let body: string;
  switch (status.kind) {
    case 'unavailable':
      tone = '';
      title = 'Sensiplan evaluation off';
      body = NFP_REASON[status.reason] ?? status.reason;
      break;
    case 'infertile-pre':
      tone = 'tone-ovulation';
      title = `Infertile until the end of ${fmtDate(status.lastDay)}`;
      body = `Pre-ovulatory phase, ${status.rule} rule — ends earlier at the first mucus sign.`;
      break;
    case 'infertile-post':
      tone = 'tone-ovulation';
      title = status.fromEvening ? 'Infertile from this evening' : 'Infertile until your next period';
      body = `Double check complete (temperature + mucus) on ${fmtDate(status.since)}.`;
      break;
    case 'fertile':
      title = 'Fertile';
      body = NFP_REASON[status.reason] ?? status.reason;
      break;
  }
  return (
    <div className={`card ${tone}`}>
      <h3>Sensiplan evaluation</h3>
      <h2>{title}</h2>
      <p className="small">{body}</p>
      <p className="hint">Only reliable if you have learned the method and log daily, following the rules correctly.</p>
    </div>
  );
}

// ------------------------------------------------------------------ today log

function TodayLog() {
  const { days, today, settings } = useStore();
  const d = days.get(today);
  const items: string[] = [];
  if (d?.bleeding) items.push(d.bleeding.value === 'spotting' ? 'Spotting' : `${d.bleeding.value[0]!.toUpperCase()}${d.bleeding.value.slice(1)} flow`);
  if (d?.temperature) items.push(fmtTemp(d.temperature.value, settings.temperatureUnit));
  if (d?.mucus) items.push('Mucus');
  if (d?.lh) items.push(`LH ${d.lh}`);
  if (d?.sex) items.push('Sex');
  if (d?.symptoms?.length) items.push(`${d.symptoms.length} symptom${d.symptoms.length > 1 ? 's' : ''}`);
  if (d?.mood?.length) items.push('Mood');
  if (d?.note) items.push('Note');

  return (
    <button className="card spread" style={{ textAlign: 'left', width: '100%' }} onClick={() => navigate(`/day/${today}`)}>
      <div>
        <h2>{d ? "Today's log" : 'Log today'}</h2>
        <p className="small muted">{items.length ? items.join(' · ') : settings.track.temperature ? 'Temperature, bleeding, mucus, symptoms…' : 'Bleeding, symptoms, mood…'}</p>
      </div>
      <span className="icon-btn" aria-hidden="true">
        <Icon name={d ? 'right' : 'plus'} />
      </span>
    </button>
  );
}

function PeriodStartButton() {
  const { saveDay, today, days } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn period block"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await saveDay(today, { ...days.get(today), bleeding: { value: 'medium' } });
          toast('Period logged for today');
        } catch (e) {
          toast(`Could not save: ${(e as Error).message}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="drop" /> My period started today
    </button>
  );
}

// ------------------------------------------------------------------ onboarding

function Welcome() {
  const { saveDay, today, settings, saveSettings } = useStore();
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [length, setLength] = useState(settings.defaultCycleLength);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card stack">
      <div>
        <h2>Welcome to Lune</h2>
        <p className="muted small">
          Your data stays on your own server, encrypted. Start with the first day of your last period — predictions improve with every cycle
          you log.
        </p>
      </div>
      <label className="field">
        <span>First day of your last period</span>
        <input type="date" value={date} max={today} min={addDays(today, -120)} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Usual cycle length (days) — a starting guess</span>
        <input type="number" inputMode="numeric" min={18} max={60} value={length} onChange={(e) => setLength(Number(e.target.value))} />
      </label>
      <button
        className="btn primary"
        disabled={busy || !date}
        onClick={async () => {
          setBusy(true);
          try {
            if (length >= 18 && length <= 60) await saveSettings({ defaultCycleLength: Math.round(length) });
            await saveDay(date, { bleeding: { value: 'medium' } });
            toast('Saved. Log the other period days from the calendar.');
          } catch (e) {
            toast(`Could not save: ${(e as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        Start
      </button>
    </div>
  );
}
