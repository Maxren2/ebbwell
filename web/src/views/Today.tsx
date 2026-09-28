import { useState } from 'react';
import { addDays, diffDays } from '../../../shared/dates.ts';
import type { Analysis, NfpStatus } from '../../../shared/engine.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { fmtDate, fmtLong, fmtRange, fmtTemp, relDays } from '../format.ts';
import { useT } from '../i18n.tsx';
import { Icon, useToast } from '../ui.tsx';
import { PartnerCards } from './Partner.tsx';

export function Today() {
  const { analysis, today, days, me, settings } = useStore();
  const t = useT();
  const current = analysis.current;

  return (
    <>
      <header className="page-header">
        <div>
          <h1>{fmtLong(today)}</h1>
          <div className="sub">{t.today.hi(me.name.split(' ')[0]!)}</div>
        </div>
      </header>

      <div className="stack">
        <PartnerCards />
        {analysis.cycles.length === 0 ? (
          <Welcome />
        ) : settings.paused ? (
          <div className="card">
            <h2>{t.today.pausedTitle}</h2>
            <p className="muted">{t.today.pausedBody}</p>
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
          .filter((w) => t.warnings[w])
          .map((w) => (
            <div className="card tone-warn" key={w}>
              <h2>{t.warnings[w]!.title}</h2>
              <p className="small">{t.warnings[w]!.body}</p>
            </div>
          ))}

        <p className="hint center">{t.today.disclaimer}</p>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ ring

function Ring({ analysis, today }: { analysis: Analysis; today: string }) {
  const tr = useT().today;
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
  const pos = at(idx(today));
  const ov = at(idx(cur.ovulation.date));
  const confirmed = analysis.cycles.at(-1)?.ovulation?.confirmed;

  const phase = {
    period: { label: tr.phase.period, color: 'var(--period)' },
    follicular: { label: tr.phase.follicular, color: 'var(--text)' },
    fertile: { label: tr.phase.fertile, color: 'var(--fertile)' },
    'peak-fertile': { label: tr.phase.peakFertile, color: 'var(--fertile)' },
    luteal: { label: confirmed ? tr.phase.lutealConfirmed : tr.phase.lutealLikely, color: 'var(--ovulation)' },
    late: { label: tr.phase.late(current.daysLate), color: 'var(--warn)' },
  }[current.phase];

  return (
    <div className="hero" role="img" aria-label={tr.ringLabel(current.cycleDay, phase.label)}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        {arc(0, length, 'var(--surface-2)')}
        {arc(idx(cur.fertileStart), idx(cur.fertileEnd) + 1, 'var(--fertile-soft)')}
        {arc(idx(cur.peakFertileStart), idx(cur.peakFertileEnd) + 1, 'var(--fertile)')}
        {arc(0, idx(cur.periodEnd) + 1, 'var(--period)')}
        <circle cx={ov.x} cy={ov.y} r="3.2" fill="var(--surface)" stroke="var(--ovulation)" strokeWidth="1.6" strokeDasharray={confirmed ? undefined : '1.5 1.2'} />
        <circle cx={pos.x} cy={pos.y} r="5" fill="var(--surface)" stroke="var(--text)" strokeWidth="2" />
      </svg>
      <div className="inner">
        <span className="day">{tr.cycleDay}</span>
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
  const t = useT();
  const cur = analysis.predictions[0]!;
  const next = analysis.predictions[1]!;
  const cycle = analysis.cycles.at(-1)!;
  const ovPast = cur.ovulation.latest < today;

  return (
    <div className="grid-2">
      <div className="card tone-period">
        <h3>{t.today.nextPeriod}</h3>
        <div className="stat">
          <div className="value">{fmtDate(next.start.date)}</div>
          <div className="label">
            {relDays(today, next.start.date)} · {fmtRange(next.start)}
          </div>
        </div>
        <p>
          <span className={`chip ${analysis.confidence}`}>{t.confidence[analysis.confidence]}</span>
        </p>
      </div>
      <div className="card tone-ovulation">
        <h3>{t.today.ovulation}</h3>
        {cycle.ovulation?.confirmed ? (
          <div className="stat">
            <div className="value">{fmtDate(cycle.ovulation.date)}</div>
            <div className="label">{t.method[cycle.ovulation.method]}</div>
          </div>
        ) : (
          <div className="stat">
            <div className="value">{ovPast ? t.today.likelyPassed : fmtDate(cur.ovulation.date)}</div>
            <div className="label">
              {ovPast ? t.today.expected(fmtRange(cur.ovulation)) : `${relDays(today, cur.ovulation.date)} · ${fmtRange(cur.ovulation)}`}
              {cycle.ovulation && ` · ${t.method[cycle.ovulation.method]}`}
            </div>
          </div>
        )}
        <p className="small muted">{t.today.fertile(fmtDate(cur.fertileStart), fmtDate(cur.fertileEnd))}</p>
      </div>
    </div>
  );
}

function Alerts({ analysis }: { analysis: Analysis }) {
  const { settings } = useStore();
  const t = useT().today.alerts;
  const c = analysis.current!;
  const out: { tone: string; title: string; body: string }[] = [];
  if (c.positivePregnancyTest) {
    out.push({ tone: 'tone-ovulation', title: t.positiveTestTitle, body: t.positiveTestBody(fmtDate(c.positivePregnancyTest)) });
  } else if (c.suggestPregnancyTest) {
    out.push({ tone: 'tone-warn', title: t.considerTestTitle, body: t.considerTestBody });
  } else if (c.phase === 'late') {
    out.push({ tone: 'tone-warn', title: t.lateTitle(c.daysLate), body: t.lateBody });
  }
  if (c.lhSurgeToday) {
    out.push({ tone: 'tone-fertile', title: t.lhTitle, body: t.lhBody });
  }
  const pend = c.temperaturePending;
  if (pend && settings.track.temperature) {
    out.push({
      tone: 'tone-ovulation',
      title: t.watchingTitle,
      body: t.watchingBody(pend.highDates.length, fmtTemp(pend.coverline, settings.temperatureUnit)),
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

function NfpCard({ status }: { status: NfpStatus }) {
  const t = useT().today.nfp;
  let tone = 'tone-fertile';
  let title: string;
  let body: string;
  switch (status.kind) {
    case 'unavailable':
      tone = '';
      title = t.off;
      body = t.reasons[status.reason] ?? status.reason;
      break;
    case 'infertile-pre':
      tone = 'tone-ovulation';
      title = t.infertileUntil(fmtDate(status.lastDay));
      body = t.preBody(t.rules[status.rule]);
      break;
    case 'infertile-post':
      tone = 'tone-ovulation';
      title = status.fromEvening ? t.fromEvening : t.untilNextPeriod;
      body = t.postBody(fmtDate(status.since));
      break;
    case 'fertile':
      title = t.fertile;
      body = t.reasons[status.reason] ?? status.reason;
      break;
  }
  return (
    <div className={`card ${tone}`}>
      <h3>{t.title}</h3>
      <h2>{title}</h2>
      <p className="small">{body}</p>
      <p className="hint">{t.hint}</p>
    </div>
  );
}

// ------------------------------------------------------------------ today log

function TodayLog() {
  const { days, today, settings } = useStore();
  const t = useT().today.log;
  const d = days.get(today);
  const items: string[] = [];
  if (d?.bleeding) items.push(t.flow[d.bleeding.value]);
  if (d?.temperature) items.push(fmtTemp(d.temperature.value, settings.temperatureUnit));
  if (d?.mucus) items.push(t.mucus);
  if (d?.lh) items.push(t.lh[d.lh]);
  if (d?.sex) items.push(t.sex);
  if (d?.symptoms?.length) items.push(t.symptoms(d.symptoms.length));
  if (d?.mood?.length) items.push(t.mood);
  if (d?.note) items.push(t.note);

  return (
    <button className="card spread" style={{ textAlign: 'start', width: '100%' }} onClick={() => navigate(`/day/${today}`)}>
      <div>
        <h2>{d ? t.logged : t.empty}</h2>
        <p className="small muted">{items.length ? items.join(' · ') : settings.track.temperature ? t.placeholderWithTemp : t.placeholder}</p>
      </div>
      <span className="icon-btn" aria-hidden="true">
        <Icon name={d ? 'right' : 'plus'} />
      </span>
    </button>
  );
}

function PeriodStartButton() {
  const { saveDay, today, days } = useStore();
  const t = useT();
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
          toast(t.today.periodLogged);
        } catch (e) {
          toast(t.common.couldNotSave((e as Error).message));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="drop" /> {t.today.periodStarted}
    </button>
  );
}

// ------------------------------------------------------------------ onboarding

function Welcome() {
  const { saveDay, today, settings, saveSettings } = useStore();
  const t = useT();
  const w = t.today.welcome;
  const toast = useToast();
  const [date, setDate] = useState(today);
  const [length, setLength] = useState(settings.defaultCycleLength);
  const [busy, setBusy] = useState(false);

  return (
    <div className="card stack">
      <div>
        <h2>{w.title}</h2>
        <p className="muted small">{w.body}</p>
      </div>
      <label className="field">
        <span>{w.lastPeriod}</span>
        <input type="date" value={date} max={today} min={addDays(today, -120)} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span>{w.cycleLength}</span>
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
            toast(w.saved);
          } catch (e) {
            toast(t.common.couldNotSave((e as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      >
        {w.start}
      </button>
    </div>
  );
}
