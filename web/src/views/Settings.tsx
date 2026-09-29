import { useEffect, useRef, useState } from 'react';
import { LANGUAGES, LANGUAGE_NAMES } from '../../../shared/i18n/index.ts';
import type { Settings } from '../../../shared/schema.ts';
import { ApiError, api, leaveApp, signOut, type SessionInfo } from '../api.ts';
import { isStandalone } from '../device.ts';
import { fmtDateTime } from '../format.ts';
import { deviceLanguage, useT } from '../i18n.tsx';
import { useStore } from '../store.tsx';
import { Seg, Switch, useToast } from '../ui.tsx';
import { LockSection, NotificationsSection, SharingSection } from './SettingsExtra.tsx';
import { AccountSection, AdminSection } from './Admin.tsx';

function deviceName(ua: string, unknown: string): string {
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : unknown;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

function LanguageField({ value, onChange }: { value: Settings['language']; onChange: (v: Settings['language']) => void }) {
  const t = useT();
  const s = t.settings;
  return (
    <label className="field">
      <span>{s.language}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as Settings['language'])}>
        <option value="auto">
          {s.languageAuto} ({LANGUAGE_NAMES[deviceLanguage()]})
        </option>
        {LANGUAGES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The feedback address; GitHub issue forms also take the template and field values from the query. */
function feedbackLink(base: string, kind: 'bug' | 'feature'): string {
  const url = new URL(base);
  if (url.hostname === 'github.com' && url.pathname.endsWith('/issues/new')) {
    url.searchParams.set('template', `${kind}.yml`);
    url.searchParams.set('version', __APP_VERSION__);
    if (kind === 'bug') url.searchParams.set('device', deviceName(navigator.userAgent, 'Other') + (isStandalone() ? ' · installed app' : ' · browser'));
  }
  return url.href;
}

export function SettingsView() {
  const { settings, saveSettings, me } = useStore();
  const t = useT();
  const s = t.settings;
  const toast = useToast();

  const update = async (patch: Partial<Settings>) => {
    try {
      await saveSettings(patch);
    } catch (e) {
      toast(t.common.couldNotSave((e as Error).message));
    }
  };
  const track = (k: keyof Settings['track'], v: boolean) => update({ track: { ...settings.track, [k]: v } });

  return (
    <>
      <header className="page-header">
        <h1>{s.title}</h1>
        <span className="sub">{me.name}</span>
      </header>

      <div className="stack">
        {settings.mode === 'partner' ? (
          <>
            <section className="card stack">
              <h3>{s.mode.title}</h3>
              <p className="small muted">{s.mode.partnerBody}</p>
              <button className="btn" onClick={() => update({ mode: 'own' })}>
                {s.mode.startTracking}
              </button>
            </section>
            <section className="card stack">
              <LanguageField value={settings.language} onChange={(language) => update({ language })} />
            </section>
          </>
        ) : (
          <>
            <section className="card stack">
              <h3>{s.goal}</h3>
              <Seg
                label={s.goal}
                allowNone={false}
                value={settings.goal}
                options={['track', 'conceive', 'avoid'] as const}
                labels={s.goals}
                onChange={(v) => v && update({ goal: v })}
              />
              {settings.goal === 'avoid' && <NfpAcknowledge />}
              <Switch label={s.pause} hint={s.pauseHint} checked={settings.paused} onChange={(v) => update({ paused: v })} />
            </section>

            <section className="card">
              <h3>{s.whatToTrack}</h3>
              <Switch label={s.track.temperature} hint={s.track.temperatureHint} checked={settings.track.temperature} onChange={(v) => track('temperature', v)} />
              <Switch label={s.track.mucus} hint={s.track.mucusHint} checked={settings.track.mucus} onChange={(v) => track('mucus', v)} />
              <Switch label={s.track.cervix} checked={settings.track.cervix} onChange={(v) => track('cervix', v)} />
              <Switch label={s.track.lh} checked={settings.track.lh} onChange={(v) => track('lh', v)} />
              <Switch label={s.track.pregnancyTest} checked={settings.track.pregnancyTest} onChange={(v) => track('pregnancyTest', v)} />
              <Switch label={s.track.sex} checked={settings.track.sex} onChange={(v) => track('sex', v)} />
              <Switch label={s.track.symptoms} checked={settings.track.symptoms} onChange={(v) => track('symptoms', v)} />
              <Switch label={s.track.mood} checked={settings.track.mood} onChange={(v) => track('mood', v)} />
            </section>

            <section className="card stack">
              <h3>{s.units}</h3>
              <LanguageField value={settings.language} onChange={(language) => update({ language })} />
              <Seg
                label={s.temperatureUnit}
                allowNone={false}
                value={settings.temperatureUnit}
                options={['C', 'F'] as const}
                labels={{ C: '°C', F: '°F' }}
                onChange={(v) => v && update({ temperatureUnit: v })}
              />
              <div className="grid-2">
                <NumberSetting label={s.cycleLength} value={settings.defaultCycleLength} min={18} max={60} onSave={(v) => update({ defaultCycleLength: v })} />
                <NumberSetting label={s.periodLength} value={settings.defaultPeriodLength} min={1} max={12} onSave={(v) => update({ defaultPeriodLength: v })} />
              </div>
            </section>
          </>
        )}

        <NotificationsSection />
        <LockSection />
        <SharingSection />
        {settings.mode === 'own' && <DataSection />}
        <AccountSection />
        {me.account.isAdmin && <AdminSection />}
        <SecuritySection />

        {me.feedbackUrl && (
          <section className="card stack">
            <h3>{s.feedback.title}</h3>
            <p className="small muted">{s.feedback.body}</p>
            <div className="grid-2">
              <a className="btn" href={feedbackLink(me.feedbackUrl, 'bug')} target="_blank" rel="noopener noreferrer">
                {s.feedback.bug}
              </a>
              <a className="btn" href={feedbackLink(me.feedbackUrl, 'feature')} target="_blank" rel="noopener noreferrer">
                {s.feedback.feature}
              </a>
            </div>
          </section>
        )}

        <section className="card stack">
          <h3>{s.about.title}</h3>
          <p className="small muted">{s.about.body}</p>
          <p className="small muted">
            {s.about.sources} Bull et al. 2019 (npj Digital Medicine), Wilcox et al. 1995 (NEJM), Frank-Herrmann et al. 2007 (Human Reproduction),
            FIGO 2018.
          </p>
          <p className="small muted">
            {s.about.license}{' '}
            <a href="https://github.com/Maxren2/ebbwell" target="_blank" rel="noopener noreferrer">
              {s.about.source}
            </a>
            {' · '}
            {s.about.version(__APP_VERSION__)}
          </p>
        </section>
      </div>
    </>
  );
}

function NumberSetting(props: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(props.value));
  useEffect(() => setV(String(props.value)), [props.value]);
  const n = Number(v);
  const ok = Number.isInteger(n) && n >= props.min && n <= props.max;
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        value={v}
        aria-invalid={!ok}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => ok && n !== props.value && props.onSave(n)}
      />
    </label>
  );
}

function NfpAcknowledge() {
  const { settings, saveSettings } = useStore();
  const t = useT();
  const s = t.settings;
  if (settings.nfpAcknowledged) {
    return (
      <div className="card tone-ovulation small">
        {s.nfpOn}{' '}
        <button className="btn" style={{ minHeight: 32, marginTop: 8 }} onClick={() => saveSettings({ nfpAcknowledged: false })}>
          {t.common.turnOff}
        </button>
      </div>
    );
  }
  return (
    <div className="card tone-warn stack small">
      <strong>{s.nfpBeforeTitle}</strong>
      <p>{s.nfpBeforeBody}</p>
      <label className="check">
        <input type="checkbox" onChange={(e) => e.target.checked && saveSettings({ nfpAcknowledged: true })} />
        <span>{s.nfpAck}</span>
      </label>
    </div>
  );
}

function DataSection() {
  const { reload } = useStore();
  const d = useT().settings.data;
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');

  const onFile = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text());
      if (mode === 'replace' && !confirm(d.confirmReplace)) return;
      const res = await api.importData({ ...payload, mode });
      await reload();
      toast(d.imported(res.imported));
    } catch (e) {
      toast(d.importFailed((e as Error).message));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="card stack">
      <h3>{d.title}</h3>
      <p className="small muted">{d.body}</p>
      <div className="grid-2">
        <a className="btn" href="/api/export" download>
          {d.exportJson}
        </a>
        <a className="btn" href="/api/export?format=csv" download>
          {d.exportCsv}
        </a>
      </div>
      <div className="divider" />
      <Seg
        label={d.importMode}
        allowNone={false}
        value={mode}
        options={['merge', 'replace'] as const}
        labels={{ merge: d.merge, replace: d.replace }}
        onChange={(v) => v && setMode(v)}
      />
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button className="btn" onClick={() => fileRef.current?.click()}>
        {d.import}
      </button>
    </section>
  );
}

function SecuritySection() {
  const t = useT();
  const s = t.settings;
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [events, setEvents] = useState<{ at: number; event: string }[]>([]);
  const [confirmText, setConfirmText] = useState('');
  const [leaving, setLeaving] = useState(false);

  const load = async () => {
    try {
      const [ss, a] = await Promise.all([api.sessions(), api.audit()]);
      setSessions(ss);
      setEvents(a);
    } catch {
      /* shown as empty */
    }
  };
  useEffect(() => void load(), []);

  const revoke = async (id: string) => {
    await api.revokeSession(id);
    toast(id === 'others' ? s.devices.othersSignedOut : s.devices.signedOut);
    void load();
  };

  return (
    <>
      <section className="card stack">
        <h3>{s.devices.title}</h3>
        <div className="list">
          {sessions?.map((x) => (
            <div key={x.id} className="spread">
              <div>
                <div>
                  {deviceName(x.userAgent, s.devices.unknown)} {x.current && <span className="chip high">{s.devices.thisDevice}</span>}
                </div>
                <div className="small muted">{s.devices.lastActive(fmtDateTime(x.lastSeenAt))}</div>
              </div>
              {!x.current && (
                <button className="btn" style={{ minHeight: 34 }} onClick={() => revoke(x.id)}>
                  {t.common.signOut}
                </button>
              )}
            </div>
          ))}
        </div>
        {sessions && sessions.length > 1 && (
          <button className="btn" onClick={() => revoke('others')}>
            {s.devices.signOutOthers}
          </button>
        )}
        <details>
          <summary className="small">{s.devices.activity}</summary>
          <div className="list small muted">
            {events.map((e) => (
              <div key={`${e.at}-${e.event}`} className="spread">
                <span>{t.events[e.event] ?? e.event}</span>
                <span>{fmtDateTime(e.at)}</span>
              </div>
            ))}
          </div>
        </details>
        <button
          className="btn primary"
          disabled={leaving}
          onClick={async () => {
            setLeaving(true);
            try {
              await signOut();
            } catch (e) {
              setLeaving(false);
              toast((e as Error).message);
            }
          }}
        >
          {t.common.signOut}
        </button>
      </section>

      <section className="card stack">
        <h3>{s.deleteAll.title}</h3>
        <p className="small muted">{s.deleteAll.body}</p>
        <label className="field">
          <span>{s.deleteAll.confirm}</span>
          <input type="text" autoComplete="off" dir="ltr" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
        <button
          className="btn danger"
          disabled={confirmText !== 'DELETE'}
          onClick={async () => {
            try {
              const { redirect } = await api.deleteAccount();
              leaveApp(redirect);
            } catch (e) {
              toast(e instanceof ApiError && e.message === 'last-admin' ? s.deleteAll.lastAdmin : (e as Error).message);
            }
          }}
        >
          {s.deleteAll.button}
        </button>
      </section>
    </>
  );
}
