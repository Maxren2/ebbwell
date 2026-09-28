import { useEffect, useState } from 'react';
import { addDays } from '../../../shared/dates.ts';
import { MUCUS_LABELS, mucusCategory } from '../../../shared/engine.ts';
import {
  BLEEDING, DISTURBANCES, MOODS, MUCUS_APPEARANCE, MUCUS_SENSATION, SYMPTOMS, isEmptyDay, type DayData,
} from '../../../shared/schema.ts';
import { goBack, navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { fmtLong, fromDisplayTemp, toDisplayTemp } from '../format.ts';
import { useT } from '../i18n.tsx';
import { Chips, Icon, Seg, useToast } from '../ui.tsx';

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
  const t = useT();
  const tx = t.day;
  const L = t.labels;
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
      toast(tx.saved);
      goBack('/');
    } catch (e) {
      toast(t.common.couldNotSave((e as Error).message));
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
        <button className="icon-btn" aria-label={tx.previous} onClick={() => navigate(`/day/${addDays(date, -1)}`, { replace: true })}>
          <Icon name="left" />
        </button>
        <div className="center">
          <h1 style={{ fontSize: '1.15rem' }}>{fmtLong(date)}</h1>
          {date === today && <div className="sub">{t.common.today}</div>}
        </div>
        <button className="icon-btn" aria-label={tx.next} disabled={nextDay > today} onClick={() => navigate(`/day/${nextDay}`, { replace: true })}>
          <Icon name="right" />
        </button>
      </header>

      <div className="stack">
        <section className="card">
          <div className="section-title">
            <span className="dot" style={{ background: 'var(--period)' }} /> {tx.bleeding}
          </div>
          <Seg
            label={tx.bleeding}
            tone="period"
            value={draft.bleeding?.value}
            options={BLEEDING}
            labels={L.bleeding}
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
                {tx.notPeriod}
                <div className="hint">{tx.notPeriodHint}</div>
              </span>
            </label>
          )}
        </section>

        {track.temperature && (
          <section className="card">
            <div className="section-title">
              <Icon name="thermo" /> {tx.temperature}
            </div>
            <div className="grid-2">
              <label className="field">
                <span>°{unit}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  placeholder={unit === 'F' ? '97.70' : '36.50'}
                  value={tempText}
                  aria-invalid={tempInvalid}
                  onChange={(e) => onTemp(e.target.value)}
                />
              </label>
              <label className="field">
                <span>{tx.timeMeasured}</span>
                <input
                  type="time"
                  value={temp?.time ?? ''}
                  disabled={!temp}
                  onChange={(e) => temp && set('temperature', { ...temp, time: e.target.value || undefined })}
                />
              </label>
            </div>
            {tempInvalid && (
              <p className="small" style={{ color: 'var(--danger)' }}>
                {tx.tempRange(tempRange[0]!, tempRange[1]!)}
              </p>
            )}
            {temp && (
              <>
                <div className="field">
                  <span>{tx.disturbedQuestion}</span>
                  <Chips
                    label={tx.disturbances}
                    value={temp.disturbances}
                    options={DISTURBANCES}
                    labels={L.disturbances}
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
                    {tx.exclude}
                    <div className="hint">{tx.excludeHint}</div>
                  </span>
                </label>
              </>
            )}
            <p className="hint">{tx.measureHint}</p>
          </section>
        )}

        {track.mucus && (
          <section className="card">
            <div className="section-title spread">
              <span>{tx.mucus}</span>
              {mucus && (
                <span className="badge" title={tx.sensiplanCategory}>
                  {MUCUS_LABELS[mucusCategory(mucus)]}
                </span>
              )}
            </div>
            <div className="field">
              <span>{tx.sensation}</span>
              <Seg
                label={tx.sensationShort}
                tone="fertile"
                value={mucus?.sensation}
                options={MUCUS_SENSATION}
                labels={L.sensation}
                onChange={(v) => set('mucus', v ? { appearance: mucus?.appearance ?? 'none', ...mucus, sensation: v } : undefined)}
              />
            </div>
            <div className="field">
              <span>{tx.appearance}</span>
              <Seg
                label={tx.appearance}
                tone="fertile"
                value={mucus?.appearance}
                options={MUCUS_APPEARANCE}
                labels={L.appearance}
                onChange={(v) =>
                  set('mucus', v ? { sensation: mucus?.sensation ?? 'nothing', ...mucus, appearance: v } : mucus && { ...mucus, appearance: 'none' })
                }
              />
            </div>
            <p className="hint">{tx.mucusHint}</p>
          </section>
        )}

        {track.cervix && (
          <section className="card">
            <div className="section-title">{tx.cervix}</div>
            <Seg
              label={tx.opening}
              value={draft.cervix?.opening}
              options={['closed', 'medium', 'open'] as const}
              labels={L.opening}
              onChange={(v) => set('cervix', { ...draft.cervix, opening: v })}
            />
            <Seg
              label={tx.firmness}
              value={draft.cervix?.firmness}
              options={['hard', 'soft'] as const}
              labels={L.firmness}
              onChange={(v) => set('cervix', { ...draft.cervix, firmness: v })}
            />
            <Seg
              label={tx.position}
              value={draft.cervix?.position}
              options={['low', 'medium', 'high'] as const}
              labels={L.position}
              onChange={(v) => set('cervix', { ...draft.cervix, position: v })}
            />
          </section>
        )}

        {(track.lh || track.pregnancyTest || track.sex) && (
          <section className="card">
            {track.lh && (
              <div className="field">
                <span>{tx.lh}</span>
                <Seg label={tx.lhShort} value={draft.lh} options={['negative', 'positive'] as const} labels={L.test} onChange={(v) => set('lh', v)} />
              </div>
            )}
            {track.pregnancyTest && (
              <div className="field">
                <span>{tx.pregnancyTest}</span>
                <Seg
                  label={tx.pregnancyTest}
                  value={draft.pregnancyTest}
                  options={['negative', 'positive'] as const}
                  labels={L.test}
                  onChange={(v) => set('pregnancyTest', v)}
                />
              </div>
            )}
            {track.sex && (
              <div className="field">
                <span>{tx.sex}</span>
                <Seg label={tx.sex} value={draft.sex} options={['protected', 'unprotected'] as const} labels={L.sex} onChange={(v) => set('sex', v)} />
              </div>
            )}
          </section>
        )}

        {track.symptoms && (
          <section className="card">
            <div className="section-title">{tx.symptoms}</div>
            <Chips label={tx.symptoms} value={draft.symptoms} options={SYMPTOMS} labels={L.symptoms} onChange={(v) => set('symptoms', v)} />
          </section>
        )}

        {track.mood && (
          <section className="card">
            <div className="section-title">{tx.mood}</div>
            <Chips label={tx.mood} value={draft.mood} options={MOODS} labels={L.mood} onChange={(v) => set('mood', v)} />
          </section>
        )}

        <section className="card">
          <label className="field">
            <span>{tx.note}</span>
            <textarea maxLength={2000} dir="auto" value={draft.note ?? ''} onChange={(e) => set('note', e.target.value || undefined)} />
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
              {tx.clear}
            </button>
          )}
          <button className="btn primary" disabled={busy || tempInvalid} onClick={save}>
            {isEmptyDay(clean(draft)) && saved ? tx.saveDelete : t.common.save}
          </button>
        </div>
      </div>
    </div>
  );
}
