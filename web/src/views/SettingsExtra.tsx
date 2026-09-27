import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { SCOPE_LABELS, SHARE_SCOPES, type ShareScope } from '../../../shared/partner.ts';
import type { NotificationSettings } from '../../../shared/schema.ts';
import { ApiError, LOCKED_EVENT, api, type LockStatus, type SharesInfo } from '../api.ts';
import { hasDeviceBiometric, isIos, isStandalone, pushSupported, setDeviceBiometric, urlBase64ToUint8Array } from '../device.ts';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { Switch, useToast } from '../ui.tsx';

const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

// ------------------------------------------------------------------ notifications

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function NotificationsSection() {
  const { settings, saveSettings } = useStore();
  const toast = useToast();
  const n = settings.notifications;
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  const needsInstall = isIos() && !isStandalone();

  useEffect(() => {
    currentSubscription()
      .then((s) => setSubscribed(!!s))
      .catch(() => setSubscribed(false));
  }, []);

  const update = async (patch: Partial<NotificationSettings>) => {
    try {
      await saveSettings({ notifications: { ...n, ...patch } });
    } catch (e) {
      toast(`Could not save: ${(e as Error).message}`);
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      // Must run from a tap: iOS only allows the permission prompt on a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications are blocked in your browser settings');
        return;
      }
      const { publicKey } = await api.push.info();
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      await api.push.subscribe(sub.toJSON());
      setSubscribed(true);
      toast('Notifications enabled on this device');
    } catch (e) {
      toast(`Could not enable notifications: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        await api.push.unsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack">
      <h3>Reminders</h3>
      {!supported || needsInstall ? (
        <p className="small muted">
          {needsInstall
            ? 'On iPhone and iPad, notifications work once Ebbwell is on your Home Screen: Share → Add to Home Screen, then open it from the icon.'
            : "This browser doesn't support push notifications."}
        </p>
      ) : (
        <div className="row">
          {subscribed ? (
            <>
              <span className="chip high">On for this device</span>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={busy} onClick={async () => toast(`Sent to ${(await api.push.test()).delivered} device(s)`)}>
                Test
              </button>
              <button className="btn" disabled={busy} onClick={disable}>
                Turn off
              </button>
            </>
          ) : (
            <button className="btn primary block" disabled={busy || subscribed === null} onClick={enable}>
              Enable notifications on this device
            </button>
          )}
        </div>
      )}

      <div className="divider" />
      <TimedSwitch
        label="Morning temperature"
        hint="Only if today's temperature isn't logged yet."
        value={n.temperature}
        onChange={(temperature) => update({ temperature })}
      />
      <TimedSwitch
        label="Evening check-in"
        hint="Mucus, symptoms and mood — skipped if already logged."
        value={n.log}
        onChange={(log) => update({ log })}
      />
      <Switch label="Period coming" checked={n.period.enabled} onChange={(enabled) => update({ period: { ...n.period, enabled } })} />
      {n.period.enabled && (
        <DaysBefore value={n.period.daysBefore} onChange={(daysBefore) => update({ period: { ...n.period, daysBefore } })} />
      )}
      {settings.goal !== 'track' && (
        <Switch
          label="Fertile window starting"
          checked={n.fertile.enabled}
          onChange={(enabled) => update({ fertile: { enabled } })}
        />
      )}
      <Switch
        label="Partner's period coming"
        hint="For cycles shared with you."
        checked={n.partner.enabled}
        onChange={(enabled) => update({ partner: { ...n.partner, enabled } })}
      />
      {n.partner.enabled && (
        <DaysBefore value={n.partner.daysBefore} onChange={(daysBefore) => update({ partner: { ...n.partner, daysBefore } })} />
      )}
      <label className="field">
        <span>Time for period and fertility reminders</span>
        <input type="time" value={n.time} onChange={(e) => e.target.value && update({ time: e.target.value })} />
      </label>
      <Switch
        label="Discreet wording"
        hint='Lock-screen text stays generic ("A gentle reminder from Ebbwell").'
        checked={n.discreet}
        onChange={(discreet) => update({ discreet })}
      />
      <p className="hint">Times use this device's time zone ({n.timezone}).</p>
    </section>
  );
}

function TimedSwitch(props: { label: string; hint: string; value: { enabled: boolean; time: string }; onChange: (v: { enabled: boolean; time: string }) => void }) {
  const { value } = props;
  return (
    <>
      <Switch label={props.label} hint={props.hint} checked={value.enabled} onChange={(enabled) => props.onChange({ ...value, enabled })} />
      {value.enabled && (
        <input type="time" aria-label={`${props.label} time`} value={value.time} onChange={(e) => e.target.value && props.onChange({ ...value, time: e.target.value })} />
      )}
    </>
  );
}

function DaysBefore({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select aria-label="Days before" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {[0, 1, 2, 3, 4, 5, 7].map((d) => (
        <option key={d} value={d}>
          {d === 0 ? 'On the expected day' : `${d} day${d > 1 ? 's' : ''} before`}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ app lock

const TIMEOUTS: { value: number; label: string }[] = [
  { value: 0, label: 'When I leave the app' },
  { value: 60, label: 'After 1 minute' },
  { value: 300, label: 'After 5 minutes' },
  { value: 900, label: 'After 15 minutes' },
  { value: 3600, label: 'After 1 hour' },
];

export function LockSection() {
  const { refreshLock } = useStore();
  const toast = useToast();
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [timeout, setTimeoutSec] = useState(300);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const deviceHasBiometric = hasDeviceBiometric();

  const load = async () => {
    const s = await api.lock.status();
    setStatus(s);
    if (s.timeoutSec !== null) setTimeoutSec(s.timeoutSec);
    await refreshLock();
  };
  useEffect(() => {
    void load();
    if (location.hash === '#lock') document.getElementById('lock')?.scrollIntoView();
  }, []); // Load once on mount.

  const validPin = /^\d{4,8}$/.test(pin) && pin === confirmPin;
  const needsCurrent = !!status?.enabled && !status.canReset;

  const savePin = async () => {
    setBusy(true);
    try {
      await api.lock.set(pin, timeout, needsCurrent ? currentPin : undefined);
      toast(status?.enabled ? 'PIN changed' : 'App lock enabled');
      setPin('');
      setConfirmPin('');
      setCurrentPin('');
      setEditing(false);
      await load();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 403 ? 'Current PIN is wrong' : `Could not save: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const addBiometric = async () => {
    setBusy(true);
    try {
      const options = await api.lock.registerOptions();
      const response = await startRegistration({ optionsJSON: options });
      const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'This device';
      await api.lock.registerVerify(response, name);
      setDeviceBiometric(true);
      toast('Biometric unlock enabled on this device');
      await load();
    } catch (e) {
      toast(`Could not add biometrics: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const pinForm = (
    <div className="stack">
      {needsCurrent && (
        <label className="field">
          <span>Current PIN</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
      <div className="grid-2">
        <label className="field">
          <span>New PIN (4–8 digits)</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="field">
          <span>Repeat PIN</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <button className="btn primary" disabled={busy || !validPin || (needsCurrent && currentPin.length < 4)} onClick={savePin}>
        {status?.enabled ? 'Change PIN' : 'Turn on app lock'}
      </button>
    </div>
  );

  return (
    <section className="card stack" id="lock">
      <h3>App lock</h3>
      {!status ? null : !status.enabled ? (
        <>
          <p className="small muted">
            Ask for a PIN (and Face ID / fingerprint) when opening Ebbwell, on top of your sign-in. Five wrong attempts sign the device out.
          </p>
          <label className="field">
            <span>Lock</span>
            <select value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
              {TIMEOUTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {pinForm}
        </>
      ) : (
        <>
          {status.canReset && <p className="small chip high">You just signed in again — you can set a new PIN below.</p>}
          <label className="field">
            <span>Lock</span>
            <select
              value={timeout}
              onChange={async (e) => {
                const v = Number(e.target.value);
                setTimeoutSec(v);
                await api.lock.setTimeout(v);
                await refreshLock();
              }}
            >
              {TIMEOUTS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <div className="list">
            {status.credentials.map((c) => (
              <div key={c.id} className="spread">
                <div>
                  <div>Biometrics · {c.name}</div>
                  <div className="small muted">Added {fmtDay(c.createdAt)}</div>
                </div>
                <button
                  className="btn"
                  style={{ minHeight: 34 }}
                  onClick={async () => {
                    await api.lock.removeCredential(c.id);
                    await load();
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          {'credentials' in navigator && !deviceHasBiometric && (
            <button className="btn" disabled={busy} onClick={addBiometric}>
              Use Face ID / fingerprint on this device
            </button>
          )}

          {(editing || status.canReset) && pinForm}
          <div className="grid-2">
            {!editing && !status.canReset && (
              <button className="btn" onClick={() => setEditing(true)}>
                Change PIN
              </button>
            )}
            <button
              className="btn"
              onClick={async () => {
                await api.lock.lockNow();
                window.dispatchEvent(new Event(LOCKED_EVENT));
              }}
            >
              Lock now
            </button>
          </div>
          <details>
            <summary className="small">Turn off app lock</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <label className="field">
                <span>PIN</span>
                <input type="password" inputMode="numeric" maxLength={8} value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))} />
              </label>
              <button
                className="btn danger"
                disabled={currentPin.length < 4}
                onClick={async () => {
                  try {
                    await api.lock.remove(currentPin);
                    setDeviceBiometric(false);
                    setCurrentPin('');
                    toast('App lock turned off');
                    await load();
                  } catch {
                    toast('Wrong PIN');
                  }
                }}
              >
                Turn off app lock
              </button>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ sharing

function ScopePicker({ value, onChange }: { value: ShareScope[]; onChange: (v: ShareScope[]) => void }) {
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked disabled />
        <span>
          Period predictions & cycle day
          <div className="hint">Always included.</div>
        </span>
      </label>
      {SHARE_SCOPES.map((s) => (
        <label key={s} className="check">
          <input
            type="checkbox"
            checked={value.includes(s)}
            onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((x) => x !== s))}
          />
          <span>
            {SCOPE_LABELS[s].title}
            <div className="hint">{SCOPE_LABELS[s].body}</div>
          </span>
        </label>
      ))}
    </div>
  );
}

export function SharingSection() {
  const toast = useToast();
  const [info, setInfo] = useState<SharesInfo | null>(null);
  const [scopes, setScopes] = useState<ShareScope[]>([]);
  const [invite, setInvite] = useState<{ url: string; expiresAt: number } | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = () => api.shares.list().then(setInfo).catch(() => {});
  useEffect(() => void load(), []);

  const create = async () => {
    try {
      const res = await api.shares.invite(scopes);
      setInvite(res);
      void load();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 409 ? 'Too many pending invites — revoke one first' : 'Could not create the invite');
    }
  };

  const shareLink = async (url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ebbwell', text: 'Join me on Ebbwell', url });
        return;
      } catch {
        /* cancelled: fall back to copying */
      }
    }
    await navigator.clipboard.writeText(url);
    toast('Link copied');
  };

  return (
    <section className="card stack">
      <h3>Sharing with a partner</h3>
      <p className="small muted">
        Your partner signs in to this Ebbwell with their own account and sees a read-only view. Notes and intimate details are never shared.
      </p>

      {info?.asOwner.length ? (
        <div className="list">
          {info.asOwner.map((s) => (
            <details key={s.id}>
              <summary>
                {s.name} <span className="small muted">· since {fmtDay(s.createdAt)}</span>
              </summary>
              <div className="stack" style={{ marginTop: 8 }}>
                <ScopePicker
                  value={s.scopes}
                  onChange={async (v) => {
                    await api.shares.update(s.id, v);
                    void load();
                  }}
                />
                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm(`Stop sharing with ${s.name}?`)) return;
                    await api.shares.end(s.id);
                    void load();
                  }}
                >
                  Stop sharing
                </button>
              </div>
            </details>
          ))}
        </div>
      ) : null}

      {info?.invites.map((i) => (
        <div key={i.id} className="spread small">
          <span>Pending invite · expires {fmtDay(i.expiresAt)}</span>
          <button
            className="btn"
            style={{ minHeight: 32 }}
            onClick={async () => {
              await api.shares.revokeInvite(i.id);
              if (invite) setInvite(null);
              void load();
            }}
          >
            Revoke
          </button>
        </div>
      ))}

      {invite ? (
        <div className="card tone-ovulation stack">
          <strong>Invite link (single use, valid 7 days)</strong>
          <code className="invite-url">{invite.url}</code>
          <div className="grid-2">
            <button className="btn primary" onClick={() => shareLink(invite.url)}>
              Share link
            </button>
            <button className="btn" onClick={() => setInvite(null)}>
              Done
            </button>
          </div>
        </div>
      ) : inviting ? (
        <div className="stack">
          <ScopePicker value={scopes} onChange={setScopes} />
          <button className="btn primary" onClick={create}>
            Create invite link
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => setInviting(true)}>
          Invite a partner
        </button>
      )}

      {info?.asPartner.length ? (
        <>
          <div className="divider" />
          <strong className="small">Shared with you</strong>
          <div className="list">
            {info.asPartner.map((s) => (
              <div key={s.id} className="spread">
                <span>{s.name}'s cycle</span>
                <button className="btn" style={{ minHeight: 34 }} onClick={() => navigate(`/partner/${s.id}`)}>
                  View
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}
