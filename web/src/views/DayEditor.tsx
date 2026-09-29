import { useEffect, useRef, useState } from 'react';
import { addDays } from '../../../shared/dates.ts';
import { MUCUS_LABELS, mucusCategory } from '../../../shared/engine.ts';
import {
  BLEEDING, DISTURBANCES, MOODS, MUCUS_APPEARANCE, MUCUS_SENSATION, SYMPTOMS, isEmptyDay, type DayData,
} from '../../../shared/schema.ts';
import { goBack, navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { applyQuickEntry, isEmptyQuickEntry, onlyTracked, parseQuickEntry, type QuickEntry } from '../../../shared/quickentry.ts';
import { fmtLong, fmtTemp, fromDisplayTemp, toDisplayTemp } from '../format.ts';
import { useI18n, useT } from '../i18n.tsx';
import { Chips, Icon, Seg, useToast } from '../ui.tsx';
import { voiceInputChoice } from '../device.ts';
import { MAX_RECORDING_SECONDS, prepareVoice, startRecording, transcribe, voiceSupported, type Recording } from '../voice.ts';

const SAMPLE_RATE_16K = 16_000;

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
        <QuickEntryCard
          key={date}
          onFill={(q) => {
            setDraft((d) => applyQuickEntry(d, q));
            if (q.temperature) setTempText(String(toDisplayTemp(q.temperature.value, unit)));
          }}
        />

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

/**
 * A sentence, typed, dictated with the keyboard's microphone, or spoken to Whisper on this
 * device (Settings → Voice input), fills in the form below.
 */
function QuickEntryCard({ onFill }: { onFill: (q: QuickEntry) => void }) {
  const { settings, me } = useStore();
  const { lang } = useI18n();
  const t = useT();
  const x = t.day.quick;
  const L = t.labels;
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ heard?: string; filled: string[]; unknown: string[]; error?: string } | null>(null);
  const voiceModel = me.voice && voiceInputChoice() === 'whisper' && voiceSupported() ? me.voice.model : null;
  const [phase, setPhase] = useState<'idle' | 'recording' | 'working'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState<number | null>(null);
  const recording = useRef<Recording | null>(null);

  useEffect(() => () => recording.current?.cancel(), []);

  const fill = (input: string, heard?: string) => {
    const q = onlyTracked(parseQuickEntry(input, lang), settings.track);
    const temp = q.temperature;
    const filled = [
      temp && `${fmtTemp(temp.value, settings.temperatureUnit)}${temp.time ? ` (${temp.time})` : ''}`,
      q.bleeding && x.pair(t.day.bleeding, L.bleeding[q.bleeding]),
      q.sensation && L.sensation[q.sensation],
      q.appearance && L.appearance[q.appearance],
      q.lh && x.pair(t.day.lhShort, L.test[q.lh]),
      q.pregnancyTest && x.pair(t.day.pregnancyTest, L.test[q.pregnancyTest]),
      q.sex && x.pair(t.day.sex, L.sex[q.sex]),
      ...q.symptoms.map((v) => L.symptoms[v]),
      ...q.mood.map((v) => L.mood[v]),
      ...q.disturbances.map((v) => L.disturbances[v]),
    ].filter((v): v is string => !!v);
    if (!isEmptyQuickEntry(q)) {
      onFill(q);
      setText('');
    } else if (heard) setText(heard); // let the user correct what was heard
    setResult({ heard, filled, unknown: q.unknown });
  };

  const stop = async () => {
    const rec = recording.current;
    if (!rec || !voiceModel) return;
    recording.current = null;
    setPhase('working');
    try {
      const audio = await rec.stop();
      const heard = audio.length > SAMPLE_RATE_16K / 4 ? await transcribe(voiceModel, audio, lang, setProgress) : '';
      if (heard) fill(heard, heard);
      else setResult({ filled: [], unknown: [], error: x.nothingHeard });
    } catch (e) {
      setResult({ filled: [], unknown: [], error: x.voiceFailed((e as Error).message) });
    } finally {
      setPhase('idle');
      setProgress(null);
    }
  };

  const start = async () => {
    if (!voiceModel) return;
    setResult(null);
    try {
      recording.current = await startRecording();
    } catch (e) {
      const denied = (e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError';
      setResult({ filled: [], unknown: [], error: denied ? x.micDenied : x.voiceFailed((e as Error).message) });
      return;
    }
    setPhase('recording');
    setSeconds(0);
    // Download / warm up the model while the user speaks.
    void prepareVoice(voiceModel, setProgress).catch(() => {});
  };

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORDING_SECONDS) void stop();
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  return (
    <section className="card stack">
      <h3>{x.title}</h3>
      <textarea
        rows={2}
        dir="auto"
        maxLength={500}
        placeholder={x.placeholder}
        aria-label={x.title}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="hint">{voiceModel ? x.hintVoice : x.hint}</p>
      <div className={voiceModel ? 'grid-2' : 'stack'}>
        {voiceModel && (
          <button
            className={`btn${phase === 'recording' ? ' primary' : ''}`}
            disabled={phase === 'working'}
            aria-pressed={phase === 'recording'}
            onClick={phase === 'recording' ? stop : start}
          >
            <Icon name={phase === 'recording' ? 'stop' : 'mic'} />
            {phase === 'recording' ? x.stop(seconds) : x.speak}
          </button>
        )}
        <button className="btn" disabled={!text.trim() || phase !== 'idle'} onClick={() => fill(text)}>
          {x.fill}
        </button>
      </div>
      {phase === 'working' && (
        <p className="small muted" role="status">
          {progress !== null && progress < 1 ? x.preparing(Math.round(progress * 100)) : x.recognising}
        </p>
      )}
      {result && (
        <div className="small" role="status">
          {result.error && <p className="muted">{result.error}</p>}
          {result.heard && (
            <p className="muted">
              {x.heard} <q dir="auto">{result.heard}</q>
            </p>
          )}
          {!result.error &&
            (result.filled.length ? (
              <p>
                <strong>{x.filled}</strong> {result.filled.join(' · ')}
              </p>
            ) : (
              <p className="muted">{x.nothing}</p>
            ))}
          {result.filled.length > 0 && result.unknown.length > 0 && (
            <p className="muted">
              {x.notUnderstood} {result.unknown.join(' ')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
