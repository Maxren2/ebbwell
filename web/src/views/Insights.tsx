import { useState } from 'react';
import { diffDays } from '../../../shared/dates.ts';
import type { Regularity } from '../../../shared/engine.ts';
import { useStore } from '../store.tsx';
import { CONFIDENCE, METHOD, fmtDate } from '../format.ts';
import { useToast } from '../ui.tsx';

const REGULARITY: Record<Regularity, { label: string; body: string }> = {
  unknown: { label: 'Not enough data', body: 'Regularity is assessed after 3 complete cycles.' },
  regular: { label: 'Regular', body: 'Shortest and longest cycles differ by 7 days or less (FIGO 2018).' },
  borderline: {
    label: 'Borderline',
    body: 'Cycles differ by 8–9 days: normal before 26 and after 41 years old, slightly irregular in between (FIGO 2018).',
  },
  irregular: { label: 'Irregular', body: 'Cycles differ by more than 9 days. Body signs (temperature, mucus) matter more than the calendar.' },
};

export function Insights() {
  const { analysis, settings, saveSettings, today } = useStore();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const s = analysis.stats;
  const cycles = [...analysis.cycles].reverse();
  const maxLen = Math.max(35, ...cycles.map((c) => c.length ?? diffDays(c.start, today) + 1));

  const toggleExclude = async (start: string, exclude: boolean) => {
    setBusy(true);
    try {
      const set = new Set(settings.excludedCycles);
      if (exclude) set.add(start);
      else set.delete(start);
      await saveSettings({ excludedCycles: [...set].sort() });
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <h1>Insights</h1>
        <span className={`chip ${analysis.confidence}`}>{CONFIDENCE[analysis.confidence]}</span>
      </header>

      <div className="stack">
        <div className="grid-2">
          <Stat label="Average cycle" value={s.mean !== null ? `${s.mean} d` : '—'} sub={s.sd !== null ? `± ${s.sd} days (SD)` : `${s.count} cycle(s)`} />
          <Stat label="Shortest – longest" value={s.min !== null ? `${s.min}–${s.max} d` : '—'} sub={`last ${s.count} cycle(s)`} />
          <Stat label="Period length" value={s.periodMean !== null ? `${s.periodMean} d` : '—'} sub="average" />
          <Stat
            label="Luteal phase"
            value={s.lutealMean !== null ? `${s.lutealMean} d` : '—'}
            sub={s.lutealCount ? `from ${s.lutealCount} confirmed cycle(s)` : 'needs a temperature shift'}
          />
        </div>

        <div className="card">
          <h3>Regularity</h3>
          <h2>{REGULARITY[s.regularity].label}</h2>
          <p className="small muted">{REGULARITY[s.regularity].body}</p>
          {s.frequency === 'frequent' && <p className="small">Average under 24 days — shorter than the usual range.</p>}
          {s.frequency === 'infrequent' && <p className="small">Average over 38 days — longer than the usual range.</p>}
        </div>

        <details className="card">
          <summary>How predictions work</summary>
          <div className="small muted stack" style={{ marginTop: 10 }}>
            <p>
              <strong>Next period:</strong> average of your last 12 usable cycles (trimmed of the extremes once you have 5+). The ± range comes
              from how much your cycles vary. Once ovulation is confirmed by temperature this cycle, the prediction switches to ovulation +
              your luteal phase, which is far more stable.
            </p>
            <p>
              <strong>Ovulation:</strong> counted backwards from the next period using your personal luteal length (or 13 days until 2 cycles
              are confirmed). Calendar-only estimates are often off by several days — only a temperature shift confirms ovulation. LH tests
              and the mucus peak refine the estimate.
            </p>
            <p>
              <strong>Fertile window:</strong> the 5 days before ovulation plus ovulation day (Wilcox et al., 1995), plus one day of margin,
              widened by the uncertainty.
            </p>
            <p>
              <strong>Excluded cycles</strong> (after hormonal contraception, pregnancy, illness…) are ignored in the statistics.
            </p>
          </div>
        </details>

        <div className="card">
          <h3>Cycles</h3>
          {cycles.length === 0 && <p className="muted small">No cycles yet.</p>}
          {cycles.map((c) => {
            const len = c.length ?? diffDays(c.start, today) + 1;
            const pct = (d: number) => `${(d / maxLen) * 100}%`;
            return (
              <div key={c.start} className={`cycle-row ${c.excluded ? 'excluded' : ''}`}>
                <div className="spread">
                  <strong>{fmtDate(c.start, { day: 'numeric', month: 'short', year: 'numeric' })}</strong>
                  <span className="small muted">
                    {c.length ? `${c.length} days` : 'current'}
                    {c.implausible && ' · check entries'}
                  </span>
                </div>
                <div className="cycle-bar" aria-hidden="true">
                  <i style={{ left: 0, width: pct(len), background: 'var(--border)' }} />
                  <i style={{ left: 0, width: pct(c.periodLength), background: 'var(--period)' }} />
                  {c.ovulationDay !== null && (
                    <i
                      style={{
                        left: pct(c.ovulationDay - 1),
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
                    Period {c.periodLength} d
                    {c.ovulation && ` · ovulation day ${c.ovulationDay} (${METHOD[c.ovulation.method].replace(/^(confirmed|estimated) /, '')})`}
                    {c.lutealLength !== null && ` · luteal ${c.lutealLength} d`}
                  </span>
                  {c.end && (
                    <label className="row" style={{ whiteSpace: 'nowrap' }}>
                      <input type="checkbox" disabled={busy} checked={c.excluded} onChange={(e) => toggleExclude(c.start, e.target.checked)} />
                      Exclude
                    </label>
                  )}
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
