import { useEffect, useState } from 'react';
import { addDays } from '../../../shared/dates.ts';
import { MUCUS_LABELS, mucusCategory } from '../../../shared/engine.ts';
import {
  BLEEDING, DISTURBANCES, MOODS, MUCUS_APPEARANCE, MUCUS_SENSATION, SYMPTOMS, isEmptyDay, type DayData,
} from '../../../shared/schema.ts';
import { goBack, navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { LABELS, fmtLong, fromDisplayTemp, toDisplayTemp } from '../format.ts';
import { Chips, Icon, Seg, useToast } from '../ui.tsx';

const YES_NO = { negative: 'Negative', positive: 'Positive' } as const;
const SEX = { protected: 'Protected', unprotected: 'Unprotected' } as const;

/** Drops undefined keys and empty arrays/objects so the stored record stays minimal. */
function clean(d: DayData): DayData {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== false && !(Array.isArray(x) && !x.length)));
      if (!Object.keys(inner).length) continue;
      out[k] = inner;
    } else out[k] = v;
  }
  return out as DayData;
}

export function DayEditor({ date }: { date: string }) {
  const { days, saveDay, settings, today } = useStore();
  const toast = useToast();
  const unit = settings.temperatureUnit;
  const track = settings.track;
  const saved = days.get(date);

  const [draft, setDraft] = useState<DayData>(saved ?? {});
  const [tempText, setTempText] = useState(saved?.temperature ? String(toDisplayTemp(saved.temperature.value, unit)) : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = days.get(date);
    setDraft(s ?? {});
    setTempText(s?.temperature ? String(toDisplayTemp(s.temperature.value, unit)) : '');
  }, [date]); // Reset only when switching days, not on every store update.

  const set = <K extends keyof DayData>(k: K, v: DayData[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const tempNum = Number(tempText.replace(',', '.'));
  const tempRange = unit === 'F' ? [93.2, 107.6] : [34, 42];
  const tempInvalid = tempText.trim() !== '' && (!Number.isFinite(tempNum) || tempNum < tempRange[0]! || tempNum > tempRange[1]!);

  const onTemp = (text: string) => {
    setTempText(text);
    const n = Number(text.replace(',', '.'));
    if (text.trim() === '') set('temperature', undefined);
    else if (Number.isFinite(n) && n >= tempRange[0]! && n <= tempRange[1]!) {
      set('temperature', { ...draft.temperature, value: fromDisplayTemp(n, unit) });
    }
  };

  const save = async () => {
    if (tempInvalid) return;
    setBusy(true);
    try {
      await saveDay(date, clean(draft));
      toast('Saved');
      goBack('/');
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const temp = draft.temperature;
  const mucus = draft.mucus;
  const nextDay = addDays(date, 1);

  return (
    <div className="editor">
      <header className="page-header">
        <button className="icon-btn" aria-label="Previous day" onClick={() => navigate(`/day/${addDays(date, -1)}`, { replace: true })}>
          <Icon name="left" />
        </button>
        <div className="center">
          <h1 style={{ fontSize: '1.15rem' }}>{fmtLong(date)}</h1>
          {date === today && <div className="sub">Today</div>}
        </div>
        <button
          className="icon-btn"
          aria-label="Next day"
          disabled={nextDay > today}
          onClick={() => navigate(`/day/${nextDay}`, { replace: true })}
        >
          <Icon name="right" />
        </button>
      </header>

      <div className="stack">
        <section className="card">
          <div className="section-title">
            <span className="dot" style={{ background: 'var(--period)' }} /> Bleeding
          </div>
          <Seg
            label="Bleeding"
            tone="period"
            value={draft.bleeding?.value}
            options={BLEEDING}
            labels={LABELS.bleeding}
            onChange={(v) => set('bleeding', v ? { ...draft.bleeding, value: v } : undefined)}
          />
          {draft.bleeding && (
            <label className="check">
              <input
                type="checkbox"
                checked={!!draft.bleeding.exclude}
                onChange={(e) => set('bleeding', { ...draft.bleeding!, exclude: e.target.checked || undefined })}
              />
              <span>
                Not part of a period
                <div className="hint">e.g. breakthrough bleeding — won't start a new cycle.</div>
              </span>
            </label>
          )}
        </section>

        {track.temperature && (
          <section className="card">
            <div className="section-title">
              <Icon name="thermo" /> Basal temperature
            </div>
            <div className="grid-2">
              <label className="field">
                <span>°{unit}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={unit === 'F' ? '97.70' : '36.50'}
                  value={tempText}
                  aria-invalid={tempInvalid}
                  onChange={(e) => onTemp(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Time measured</span>
                <input
                  type="time"
                  value={temp?.time ?? ''}
                  disabled={!temp}
                  onChange={(e) => temp && set('temperature', { ...temp, time: e.target.value || undefined })}
                />
              </label>
            </div>
            {tempInvalid && <p className="small" style={{ color: 'var(--danger)' }}>Enter a value between {tempRange[0]} and {tempRange[1]}.</p>}
            {temp && (
              <>
                <div className="field">
                  <span>Anything that may have disturbed it?</span>
                  <Chips
                    label="Disturbances"
                    value={temp.disturbances}
                    options={DISTURBANCES}
                    labels={LABELS.disturbances}
                    onChange={(v) => set('temperature', { ...temp, disturbances: v, exclude: v.length ? true : temp.exclude })}
                  />
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!temp.exclude}
                    onChange={(e) => set('temperature', { ...temp, exclude: e.target.checked || undefined })}
                  />
                  <span>
                    Exclude from evaluation
                    <div className="hint">Disturbed readings are skipped by the temperature rule (Sensiplan).</div>
                  </span>
                </label>
              </>
            )}
            <p className="hint">Measure right after waking, before getting up, at the same time each day, same method.</p>
          </section>
        )}

        {track.mucus && (
          <section className="card">
            <div className="section-title spread">
              <span>Cervical mucus</span>
              {mucus && <span className="badge" title="Sensiplan category">{MUCUS_LABELS[mucusCategory(mucus)]}</span>}
            </div>
            <div className="field">
              <span>Sensation (vulva)</span>
              <Seg
                label="Sensation"
                tone="fertile"
                value={mucus?.sensation}
                options={MUCUS_SENSATION}
                labels={LABELS.sensation}
                onChange={(v) => set('mucus', v ? { appearance: mucus?.appearance ?? 'none', ...mucus, sensation: v } : undefined)}
              />
            </div>
            <div className="field">
              <span>Appearance</span>
              <Seg
                label="Appearance"
                tone="fertile"
                value={mucus?.appearance}
                options={MUCUS_APPEARANCE}
                labels={LABELS.appearance}
                onChange={(v) =>
                  set('mucus', v ? { sensation: mucus?.sensation ?? 'nothing', ...mucus, appearance: v } : mucus && { ...mucus, appearance: 'none' })
                }
              />
            </div>
            <p className="hint">Record the most fertile quality observed during the day.</p>
          </section>
        )}

        {track.cervix && (
          <section className="card">
            <div className="section-title">Cervix</div>
            <Seg
              label="Opening"
              value={draft.cervix?.opening}
              options={['closed', 'medium', 'open'] as const}
              labels={{ closed: 'Closed', medium: 'Partly open', open: 'Open' }}
              onChange={(v) => set('cervix', { ...draft.cervix, opening: v })}
            />
            <Seg
              label="Firmness"
              value={draft.cervix?.firmness}
              options={['hard', 'soft'] as const}
              labels={{ hard: 'Firm', soft: 'Soft' }}
              onChange={(v) => set('cervix', { ...draft.cervix, firmness: v })}
            />
            <Seg
              label="Position"
              value={draft.cervix?.position}
              options={['low', 'medium', 'high'] as const}
              labels={{ low: 'Low', medium: 'Middle', high: 'High' }}
              onChange={(v) => set('cervix', { ...draft.cervix, position: v })}
            />
          </section>
        )}

        {(track.lh || track.pregnancyTest || track.sex) && (
          <section className="card">
            {track.lh && (
              <div className="field">
                <span>Ovulation (LH) test</span>
                <Seg label="LH test" value={draft.lh} options={['negative', 'positive'] as const} labels={YES_NO} onChange={(v) => set('lh', v)} />
              </div>
            )}
            {track.pregnancyTest && (
              <div className="field">
                <span>Pregnancy test</span>
                <Seg
                  label="Pregnancy test"
                  value={draft.pregnancyTest}
                  options={['negative', 'positive'] as const}
                  labels={YES_NO}
                  onChange={(v) => set('pregnancyTest', v)}
                />
              </div>
            )}
            {track.sex && (
              <div className="field">
                <span>Sex</span>
                <Seg label="Sex" value={draft.sex} options={['protected', 'unprotected'] as const} labels={SEX} onChange={(v) => set('sex', v)} />
              </div>
            )}
          </section>
        )}

        {track.symptoms && (
          <section className="card">
            <div className="section-title">Symptoms</div>
            <Chips label="Symptoms" value={draft.symptoms} options={SYMPTOMS} labels={LABELS.symptoms} onChange={(v) => set('symptoms', v)} />
          </section>
        )}

        {track.mood && (
          <section className="card">
            <div className="section-title">Mood</div>
            <Chips label="Mood" value={draft.mood} options={MOODS} labels={LABELS.mood} onChange={(v) => set('mood', v)} />
          </section>
        )}

        <section className="card">
          <label className="field">
            <span>Note</span>
            <textarea maxLength={2000} value={draft.note ?? ''} onChange={(e) => set('note', e.target.value || undefined)} />
          </label>
        </section>

        <div className="sticky-actions">
          {saved && (
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => {
                setDraft({});
                setTempText('');
              }}
            >
              Clear
            </button>
          )}
          <button className="btn primary" disabled={busy || tempInvalid} onClick={save}>
            {isEmptyDay(clean(draft)) && saved ? 'Save (delete day)' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
