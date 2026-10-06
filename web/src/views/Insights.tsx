import { useState } from 'react';
import { diffDays } from '../../../shared/dates.ts';
import { useStore } from '../store.tsx';
import { fmtDate } from '../format.ts';
import { useT } from '../i18n.tsx';
import { useToast } from '../ui.tsx';

export function Insights() {
  const { analysis, settings, saveSettings, today } = useStore();
  const t = useT();
  const x = t.insights;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = analysis.stats;
  const cycles = [...analysis.cycles].reverse();
  const maxLen = Math.max(35, ...cycles.map((c) => c.length ?? diffDays(c.start, today) + 1));

  const toggle = async (key: 'excludedCycles' | 'afterHormonalContraception', start: string, on: boolean) => {
    setBusy(true);
    try {
      const set = new Set(settings[key]);
      if (on) set.add(start);
      else set.delete(start);
      await saveSettings({ [key]: [...set].sort() });
    } catch (e) {
      toast(t.common.couldNotSave((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <h1>{x.title}</h1>
        <span className={`chip ${analysis.confidence}`}>{t.confidence[analysis.confidence]}</span>
      </header>

      <div className="stack">
        <div className="grid-2">
          <Stat label={x.averageCycle} value={s.mean !== null ? t.common.d(s.mean) : '—'} sub={s.sd !== null ? x.sd(s.sd) : x.cycleCount(s.count)} />
          <Stat label={x.shortestLongest} value={s.min !== null ? t.common.d(`${s.min}–${s.max}`) : '—'} sub={x.lastCycles(s.count)} />
          <Stat label={x.periodLength} value={s.periodMean !== null ? t.common.d(s.periodMean) : '—'} sub={x.average} />
          <Stat
            label={x.luteal}
            value={s.lutealMean !== null ? t.common.d(s.lutealMean) : '—'}
            sub={s.lutealCount ? x.fromConfirmed(s.lutealCount) : x.needsShift}
          />
        </div>

        <div className="card">
          <h3>{x.regularity}</h3>
          <h2>{x.regularityLabel[s.regularity]}</h2>
          <p className="small muted">{x.regularityBody[s.regularity]}</p>
          {s.frequency === 'frequent' && <p className="small">{x.frequent}</p>}
          {s.frequency === 'infrequent' && <p className="small">{x.infrequent}</p>}
        </div>

        <details className="card">
          <summary>{x.howTitle}</summary>
          <div className="small muted stack" style={{ marginTop: 10 }}>
            {x.how.map((h) => (
              <p key={h.label}>
                <strong>{h.label}</strong> {h.text}
              </p>
            ))}
          </div>
        </details>

        <div className="card">
          <h3>{x.cycles}</h3>
          {cycles.length === 0 && <p className="muted small">{x.noCycles}</p>}
          {cycles.map((c) => {
            const len = c.length ?? diffDays(c.start, today) + 1;
            const pct = (d: number) => `${(d / maxLen) * 100}%`;
            return (
              <div key={c.start} className={`cycle-row ${c.excluded ? 'excluded' : ''}`}>
                <div className="spread">
                  <strong>{fmtDate(c.start, { day: 'numeric', month: 'short', year: 'numeric' })}</strong>
                  <span className="small muted">
                    {c.length ? t.common.days(c.length) : x.current}
                    {c.implausible && x.checkEntries}
                  </span>
                </div>
                <div className="cycle-bar" aria-hidden="true">
                  <i style={{ insetInlineStart: 0, width: pct(len), background: 'var(--border)' }} />
                  <i style={{ insetInlineStart: 0, width: pct(c.periodLength), background: 'var(--period)' }} />
                  {c.ovulationDay !== null && (
                    <i
                      style={{
                        insetInlineStart: pct(c.ovulationDay - 1),
                        width: pct(1),
                        minWidth: 4,
                        background: 'var(--ovulation)',
                        opacity: c.ovulation?.confirmed ? 1 : 0.5,
                      }}
                    />
                  )}
                </div>
                <div className="spread small muted">
                  <span>
                    {x.period(c.periodLength)}
                    {c.ovulation && c.ovulationDay !== null && x.ovulationDay(c.ovulationDay, t.methodShort[c.ovulation.method])}
                    {c.lutealLength !== null && x.lutealShort(c.lutealLength)}
                  </span>
                  <span className="row">
                    <label className="row" style={{ whiteSpace: 'nowrap' }} title={x.afterPillHint}>
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={c.afterHormonalContraception}
                        onChange={(e) => toggle('afterHormonalContraception', c.start, e.target.checked)}
                      />
                      {x.afterPill}
                    </label>
                    {c.end && (
                      <label className="row" style={{ whiteSpace: 'nowrap' }}>
                        <input type="checkbox" disabled={busy} checked={c.excluded} onChange={(e) => toggle('excludedCycles', c.start, e.target.checked)} />
                        {x.exclude}
                      </label>
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="label">{sub}</div>
    </div>
  );
}
