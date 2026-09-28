import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../../shared/schema.ts';
import { api, type SessionInfo } from '../api.ts';
import { useStore } from '../store.tsx';
import { Seg, Switch, useToast } from '../ui.tsx';
import { LockSection, NotificationsSection, SharingSection } from './SettingsExtra.tsx';
import { AccountSection, AdminSection } from './Admin.tsx';

const GOALS = { track: 'Track', conceive: 'Conceive', avoid: 'Avoid pregnancy' } as const;

function deviceName(ua: string): string {
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

const EVENTS: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  export: 'Data exported',
  'import-merge': 'Data imported (merge)',
  'import-replace': 'Data imported (replace)',
  'sessions-revoked': 'Sessions revoked',
  'login-reauth': 'Signed in again (PIN reset allowed)',
  'lock-enabled': 'App lock turned on',
  'lock-disabled': 'App lock turned off',
  'pin-changed': 'PIN changed',
  'unlock-failed': 'Wrong PIN entered',
  'lock-lockout': 'Signed out after wrong PINs',
  'biometric-added': 'Biometric unlock added',
  'biometric-removed': 'Biometric unlock removed',
  'push-subscribed': 'Notifications enabled on a device',
  'share-invite-created': 'Partner invite created',
  'share-accepted': 'Partner invite accepted',
  'share-started': 'Partner started viewing your cycle',
  'share-updated': 'Sharing settings changed',
  'share-ended': 'Sharing ended',
  'login-local': 'Signed in with password',
  'login-local-2fa': 'Signed in with password + 2FA code',
  'login-local-recovery-code': 'Signed in with a recovery code',
  '2fa-failed': 'Wrong 2FA code entered',
  '2fa-enabled': 'Two-factor authentication turned on',
  '2fa-disabled': 'Two-factor authentication turned off',
  '2fa-recovery-renewed': 'New recovery codes created',
  '2fa-reset-by-admin': 'Two-factor reset by an administrator',
  '2fa-reset-cli': 'Two-factor reset from the server',
  'admin-2fa-reset': "You reset someone's two-factor",
  'login-failed': 'Wrong password entered',
  'login-locked': 'Account locked after wrong passwords',
  'password-changed': 'Password changed',
  'password-reset-by-admin': 'Password reset by an administrator',
  'password-reset-cli': 'Password reset from the server',
  'account-created-by-admin': 'Account created by an administrator',
  'admin-user-created': 'You created an account',
  'admin-password-reset': "You reset someone's password",
  'admin-granted': 'You granted administrator rights',
  'admin-revoked': 'You removed administrator rights',
  'admin-user-disabled': 'You disabled an account',
  'admin-user-enabled': 'You enabled an account',
  'admin-user-deleted': 'You deleted an account',
};

export function SettingsView() {
  const { settings, saveSettings, me } = useStore();
  const toast = useToast();

  const update = async (patch: Partial<Settings>) => {
    try {
      await saveSettings(patch);
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    }
  };
  const track = (k: keyof Settings['track'], v: boolean) => update({ track: { ...settings.track, [k]: v } });

  return (
    <>
      <header className="page-header">
        <h1>Settings</h1>
        <span className="sub">{me.name}</span>
      </header>

      <div className="stack">
        <section className="card stack">
          <h3>Goal</h3>
          <Seg
            label="Goal"
            allowNone={false}
            value={settings.goal}
            options={['track', 'conceive', 'avoid'] as const}
            labels={GOALS}
            onChange={(v) => v && update({ goal: v })}
          />
          {settings.goal === 'avoid' && <NfpAcknowledge />}
          <Switch
            label="Pregnancy / pause mode"
            hint="Stops predictions (pregnancy, postpartum, breastfeeding…). You can keep logging."
            checked={settings.paused}
            onChange={(v) => update({ paused: v })}
          />
        </section>

        <section className="card">
          <h3>What to track</h3>
          <Switch label="Basal temperature" hint="Confirms ovulation — the key to reliable predictions." checked={settings.track.temperature} onChange={(v) => track('temperature', v)} />
          <Switch label="Cervical mucus" hint="Identifies the fertile window as it happens." checked={settings.track.mucus} onChange={(v) => track('mucus', v)} />
          <Switch label="Cervix" checked={settings.track.cervix} onChange={(v) => track('cervix', v)} />
          <Switch label="LH tests" checked={settings.track.lh} onChange={(v) => track('lh', v)} />
          <Switch label="Pregnancy tests" checked={settings.track.pregnancyTest} onChange={(v) => track('pregnancyTest', v)} />
          <Switch label="Sex" checked={settings.track.sex} onChange={(v) => track('sex', v)} />
          <Switch label="Symptoms" checked={settings.track.symptoms} onChange={(v) => track('symptoms', v)} />
          <Switch label="Mood" checked={settings.track.mood} onChange={(v) => track('mood', v)} />
        </section>

        <section className="card stack">
          <h3>Units & defaults</h3>
          <Seg
            label="Temperature unit"
            allowNone={false}
            value={settings.temperatureUnit}
            options={['C', 'F'] as const}
            labels={{ C: '°C', F: '°F' }}
            onChange={(v) => v && update({ temperatureUnit: v })}
          />
          <div className="grid-2">
            <NumberSetting label="Cycle length until learned" value={settings.defaultCycleLength} min={18} max={60} onSave={(v) => update({ defaultCycleLength: v })} />
            <NumberSetting label="Period length until learned" value={settings.defaultPeriodLength} min={1} max={12} onSave={(v) => update({ defaultPeriodLength: v })} />
          </div>
        </section>

        <NotificationsSection />
        <LockSection />
        <SharingSection />
        <DataSection />
        <AccountSection />
        {me.account.isAdmin && <AdminSection />}
        <SecuritySection />

        <section className="card stack">
          <h3>About</h3>
          <p className="small muted">
            Ebbwell estimates cycles from your own history and confirms ovulation from body signs (Sensiplan temperature and mucus rules). It is
            not a medical device and not a contraceptive. See a clinician for missed periods, very irregular cycles, heavy bleeding or pain.
          </p>
          <p className="small muted">
            Sources: Bull et al. 2019 (npj Digital Medicine), Wilcox et al. 1995 (NEJM), Frank-Herrmann et al. 2007 (Human Reproduction), FIGO
            2018 menstrual definitions.
          </p>
          <p className="small muted">
            Free software (AGPL-3.0-or-later).{' '}
            <a href="https://github.com/Maxren2/ebbwell" target="_blank" rel="noopener noreferrer">
              Source code
            </a>
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
  if (settings.nfpAcknowledged) {
    return (
      <div className="card tone-ovulation small">
        Sensiplan evaluation is on (5-day / minus-8 rules, double check).{' '}
        <button className="btn" style={{ minHeight: 32, marginTop: 8 }} onClick={() => saveSettings({ nfpAcknowledged: false })}>
          Turn off
        </button>
      </div>
    );
  }
  return (
    <div className="card tone-warn stack small">
      <strong>Before relying on Ebbwell to avoid pregnancy</strong>
      <p>
        The symptothermal method (Sensiplan) is highly effective only with correct use: daily temperature at waking, daily mucus observation,
        and the rules learned from a qualified teacher or the official book. Typical use is less effective than perfect use. Ebbwell shows the
        rule evaluation; mistakes in observations lead to mistakes in the result.
      </p>
      <label className="check">
        <input type="checkbox" onChange={(e) => e.target.checked && saveSettings({ nfpAcknowledged: true })} />
        <span>I have learned the method and understand Ebbwell is not a medical device.</span>
      </label>
    </div>
  );
}

function DataSection() {
  const { reload } = useStore();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');

  const onFile = async (file: File) => {
    try {
      const payload = JSON.parse(await file.text());
      if (mode === 'replace' && !confirm('Replace ALL your current entries with this file?')) return;
      const res = await api.importData({ ...payload, mode });
      await reload();
      toast(`Imported ${res.imported} days`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <section className="card stack">
      <h3>Your data</h3>
      <p className="small muted">Stored encrypted on your server. Exports are unencrypted — keep them somewhere safe.</p>
      <div className="grid-2">
        <a className="btn" href="/api/export" download>
          Export JSON
        </a>
        <a className="btn" href="/api/export?format=csv" download>
          Export CSV
        </a>
      </div>
      <div className="divider" />
      <Seg
        label="Import mode"
        allowNone={false}
        value={mode}
        options={['merge', 'replace'] as const}
        labels={{ merge: 'Merge', replace: 'Replace all' }}
        onChange={(v) => v && setMode(v)}
      />
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button className="btn" onClick={() => fileRef.current?.click()}>
        Import an Ebbwell JSON export…
      </button>
    </section>
  );
}

function SecuritySection() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [events, setEvents] = useState<{ at: number; event: string }[]>([]);
  const [confirmText, setConfirmText] = useState('');

  const load = async () => {
    try {
      const [s, a] = await Promise.all([api.sessions(), api.audit()]);
      setSessions(s);
      setEvents(a);
    } catch {
      /* shown as empty */
    }
  };
  useEffect(() => void load(), []);

  const revoke = async (id: string) => {
    await api.revokeSession(id);
    toast(id === 'others' ? 'Other devices signed out' : 'Device signed out');
    void load();
  };

  const fmt = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return (
    <>
      <section className="card stack">
        <h3>Signed-in devices</h3>
        <div className="list">
          {sessions?.map((s) => (
            <div key={s.id} className="spread">
              <div>
                <div>
                  {deviceName(s.userAgent)} {s.current && <span className="chip high">This device</span>}
                </div>
                <div className="small muted">Last active {fmt(s.lastSeenAt)}</div>
              </div>
              {!s.current && (
                <button className="btn" style={{ minHeight: 34 }} onClick={() => revoke(s.id)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
        {sessions && sessions.length > 1 && (
          <button className="btn" onClick={() => revoke('others')}>
            Sign out all other devices
          </button>
        )}
        <details>
          <summary className="small">Recent activity</summary>
          <div className="list small muted">
            {events.map((e) => (
              <div key={`${e.at}-${e.event}`} className="spread">
                <span>{EVENTS[e.event] ?? e.event}</span>
                <span>{fmt(e.at)}</span>
              </div>
            ))}
          </div>
        </details>
        <button
          className="btn primary"
          onClick={async () => {
            const { redirect } = await api.logout();
            location.assign(redirect);
          }}
        >
          Sign out
        </button>
      </section>

      <section className="card stack">
        <h3>Delete everything</h3>
        <p className="small muted">Permanently deletes all your entries, settings and sessions from the server. Export first if you want a copy.</p>
        <label className="field">
          <span>Type DELETE to confirm</span>
          <input type="text" autoComplete="off" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        </label>
        <button
          className="btn danger"
          disabled={confirmText !== 'DELETE'}
          onClick={async () => {
            const { redirect } = await api.deleteAccount();
            location.assign(redirect);
          }}
        >
          Delete all my data
        </button>
      </section>
    </>
  );
}
