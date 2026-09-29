import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { SHARE_SCOPES, type ShareScope } from '../../../shared/partner.ts';
import type { NotificationSettings } from '../../../shared/schema.ts';
import { ApiError, LOCKED_EVENT, api, type LockStatus, type SharesInfo } from '../api.ts';
import {
  hasDeviceBiometric, isIos, isStandalone, pushSupported, secureContext, setDeviceBiometric, setVoiceInputChoice, urlBase64ToUint8Array, voiceInputChoice,
  type VoiceInput,
} from '../device.ts';
import { fmtDay } from '../format.ts';
import { useT } from '../i18n.tsx';
import { navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { Seg, Switch, useToast } from '../ui.tsx';
import { prepareVoice, removeVoiceModel, voiceModelCached, voiceSupported } from '../voice.ts';

// ------------------------------------------------------------------ notifications

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function NotificationsSection() {
  const { settings, saveSettings } = useStore();
  const t = useT();
  const x = t.notifications;
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
      toast(t.common.couldNotSave((e as Error).message));
    }
  };

  const enable = async () => {
    setBusy(true);
    try {
      // Must run from a tap: iOS only allows the permission prompt on a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast(x.blocked);
        return;
      }
      const { publicKey } = await api.push.info();
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      await api.push.subscribe(sub.toJSON());
      setSubscribed(true);
      toast(x.enabled);
    } catch (e) {
      toast(x.couldNotEnable((e as Error).message));
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
      <h3>{x.title}</h3>
      {!supported || needsInstall ? (
        <p className="small muted">{!secureContext() ? x.needsHttps : needsInstall ? x.needsInstall : x.unsupported}</p>
      ) : (
        <div className="row">
          {subscribed ? (
            <>
              <span className="chip high">{x.onForDevice}</span>
              <span style={{ flex: 1 }} />
              <button className="btn" disabled={busy} onClick={async () => toast(x.sent((await api.push.test()).delivered))}>
                {x.test}
              </button>
              <button className="btn" disabled={busy} onClick={disable}>
                {t.common.turnOff}
              </button>
            </>
          ) : (
            <button className="btn primary block" disabled={busy || subscribed === null} onClick={enable}>
              {x.enable}
            </button>
          )}
        </div>
      )}

      <div className="divider" />
      {settings.mode === 'own' && (
        <>
          <TimedSwitch label={x.morning} hint={x.morningHint} value={n.temperature} onChange={(temperature) => update({ temperature })} />
          <TimedSwitch label={x.evening} hint={x.eveningHint} value={n.log} onChange={(log) => update({ log })} />
          <Switch label={x.period} checked={n.period.enabled} onChange={(enabled) => update({ period: { ...n.period, enabled } })} />
          {n.period.enabled && <DaysBefore value={n.period.daysBefore} onChange={(daysBefore) => update({ period: { ...n.period, daysBefore } })} />}
          {settings.goal !== 'track' && <Switch label={x.fertile} checked={n.fertile.enabled} onChange={(enabled) => update({ fertile: { enabled } })} />}
        </>
      )}
      <Switch label={x.partner} hint={x.partnerHint} checked={n.partner.enabled} onChange={(enabled) => update({ partner: { ...n.partner, enabled } })} />
      {n.partner.enabled && <DaysBefore value={n.partner.daysBefore} onChange={(daysBefore) => update({ partner: { ...n.partner, daysBefore } })} />}
      <label className="field">
        <span>{x.time}</span>
        <input type="time" value={n.time} onChange={(e) => e.target.value && update({ time: e.target.value })} />
      </label>
      <Switch label={x.discreet} hint={x.discreetHint} checked={n.discreet} onChange={(discreet) => update({ discreet })} />
      <p className="hint">{x.timezone(n.timezone)}</p>
    </section>
  );
}

function TimedSwitch(props: { label: string; hint: string; value: { enabled: boolean; time: string }; onChange: (v: { enabled: boolean; time: string }) => void }) {
  const x = useT().notifications;
  const { value } = props;
  return (
    <>
      <Switch label={props.label} hint={props.hint} checked={value.enabled} onChange={(enabled) => props.onChange({ ...value, enabled })} />
      {value.enabled && (
        <input type="time" aria-label={x.timeOf(props.label)} value={value.time} onChange={(e) => e.target.value && props.onChange({ ...value, time: e.target.value })} />
      )}
    </>
  );
}

function DaysBefore({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const x = useT().notifications;
  return (
    <select aria-label={x.daysBefore} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {[0, 1, 2, 3, 4, 5, 7].map((d) => (
        <option key={d} value={d}>
          {d === 0 ? x.onTheDay : x.before(d)}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------ app lock

const TIMEOUTS = [0, 60, 300, 900, 3600];

export function LockSection() {
  const { refreshLock } = useStore();
  const t = useT();
  const x = t.lock;
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
      toast(status?.enabled ? x.pinChanged : x.enabled);
      setPin('');
      setConfirmPin('');
      setCurrentPin('');
      setEditing(false);
      await load();
    } catch (e) {
      toast(e instanceof ApiError && e.status === 403 ? x.currentWrong : t.common.couldNotSave((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const addBiometric = async () => {
    setBusy(true);
    try {
      const options = await api.lock.registerOptions();
      const response = await startRegistration({ optionsJSON: options });
      const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone / iPad' : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : x.thisDevice;
      await api.lock.registerVerify(response, name);
      setDeviceBiometric(true);
      toast(x.biometricEnabled);
      await load();
    } catch (e) {
      toast(x.couldNotAddBiometric((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const timeoutSelect = (onChange: (v: number) => void) => (
    <label className="field">
      <span>{x.lock}</span>
      <select value={timeout} onChange={(e) => onChange(Number(e.target.value))}>
        {TIMEOUTS.map((v) => (
          <option key={v} value={v}>
            {x.timeouts[v]}
          </option>
        ))}
      </select>
    </label>
  );

  const pinForm = (
    <div className="stack">
      {needsCurrent && (
        <label className="field">
          <span>{x.currentPin}</span>
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={8} value={currentPin} onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
      <div className="grid-2">
        <label className="field">
          <span>{x.newPin}</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="field">
          <span>{x.repeatPin}</span>
          <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={8} value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>
      <button className="btn primary" disabled={busy || !validPin || (needsCurrent && currentPin.length < 4)} onClick={savePin}>
        {status?.enabled ? x.changePin : x.turnOn}
      </button>
    </div>
  );

  return (
    <section className="card stack" id="lock">
      <h3>{x.title}</h3>
      {!status ? null : !status.enabled ? (
        <>
          <p className="small muted">{x.intro}</p>
          {timeoutSelect(setTimeoutSec)}
          {pinForm}
        </>
      ) : (
        <>
          {status.canReset && <p className="small chip high">{x.justSignedIn}</p>}
          {timeoutSelect(async (v) => {
            setTimeoutSec(v);
            await api.lock.setTimeout(v);
            await refreshLock();
          })}

          <div className="list">
            {status.credentials.map((c) => (
              <div key={c.id} className="spread">
                <div>
                  <div>{x.biometrics(c.name)}</div>
                  <div className="small muted">{x.added(fmtDay(c.createdAt))}</div>
                </div>
                <button
                  className="btn"
                  style={{ minHeight: 34 }}
                  onClick={async () => {
                    await api.lock.removeCredential(c.id);
                    await load();
                  }}
                >
                  {t.common.remove}
                </button>
              </div>
            ))}
          </div>
          {secureContext() && 'credentials' in navigator && !deviceHasBiometric && (
            <button className="btn" disabled={busy} onClick={addBiometric}>
              {x.useBiometrics}
            </button>
          )}

          {(editing || status.canReset) && pinForm}
          <div className="grid-2">
            {!editing && !status.canReset && (
              <button className="btn" onClick={() => setEditing(true)}>
                {x.changePin}
              </button>
            )}
            <button
              className="btn"
              onClick={async () => {
                await api.lock.lockNow();
                window.dispatchEvent(new Event(LOCKED_EVENT));
              }}
            >
              {x.lockNow}
            </button>
          </div>
          <details>
            <summary className="small">{x.turnOffTitle}</summary>
            <div className="stack" style={{ marginTop: 8 }}>
              <label className="field">
                <span>{x.pin}</span>
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
                    toast(x.turnedOff);
                    await load();
                  } catch {
                    toast(x.wrongPin);
                  }
                }}
              >
                {x.turnOffTitle}
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
  const t = useT();
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked disabled />
        <span>
          {t.sharing.always}
          <div className="hint">{t.sharing.alwaysHint}</div>
        </span>
      </label>
      {SHARE_SCOPES.map((s) => (
        <label key={s} className="check">
          <input
            type="checkbox"
            checked={value.includes(s)}
            onChange={(e) => onChange(e.target.checked ? [...value, s] : value.filter((v) => v !== s))}
          />
          <span>
            {t.scopes[s].title}
            <div className="hint">{t.scopes[s].body}</div>
          </span>
        </label>
      ))}
    </div>
  );
}

export function SharingSection() {
  const { settings, saveSettings } = useStore();
  const t = useT();
  const x = t.sharing;
  const toast = useToast();
  const partnerOnly = settings.mode === 'partner';
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
      toast(e instanceof ApiError && e.status === 409 ? x.tooMany : x.couldNotCreate);
    }
  };

  const shareLink = async (url: string) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Ebbwell', text: x.shareText, url });
        return;
      } catch {
        /* cancelled: fall back to copying */
      }
    }
    await navigator.clipboard.writeText(url);
    toast(x.linkCopied);
  };

  return (
    <section className="card stack">
      <h3>{x.title}</h3>
      {!partnerOnly && (
        <>
          <p className="small muted">{x.intro}</p>
          {info?.asOwner.length ? (
            <div className="list">
              {info.asOwner.map((s) => (
                <details key={s.id}>
                  <summary>
                    {s.name} <span className="small muted">· {x.since(fmtDay(s.createdAt))}</span>
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
                        if (!confirm(x.stopConfirm(s.name))) return;
                        await api.shares.end(s.id);
                        void load();
                      }}
                    >
                      {x.stop}
                    </button>
                  </div>
                </details>
              ))}
            </div>
          ) : null}
          {info?.invites.map((i) => (
            <div key={i.id} className="spread small">
              <span>{x.pending(fmtDay(i.expiresAt))}</span>
              <button
                className="btn"
                style={{ minHeight: 32 }}
                onClick={async () => {
                  await api.shares.revokeInvite(i.id);
                  if (invite) setInvite(null);
                  void load();
                }}
              >
                {x.revoke}
              </button>
            </div>
          ))}
          {invite ? (
            <div className="card tone-ovulation stack">
              <strong>{x.inviteTitle}</strong>
              <code className="invite-url" dir="ltr">
                {invite.url}
              </code>
              <div className="grid-2">
                <button className="btn primary" onClick={() => shareLink(invite.url)}>
                  {x.shareLink}
                </button>
                <button className="btn" onClick={() => setInvite(null)}>
                  {t.common.done}
                </button>
              </div>
            </div>
          ) : inviting ? (
            <div className="stack">
              <ScopePicker value={scopes} onChange={setScopes} />
              <button className="btn primary" onClick={create}>
                {x.createInvite}
              </button>
            </div>
          ) : (
            <button className="btn" onClick={() => setInviting(true)}>
              {x.invite}
            </button>
          )}
        </>
      )}

      {info?.asPartner.length ? (
        <>
          {!partnerOnly && <div className="divider" />}
          <strong className="small">{x.sharedWithYou}</strong>
          <div className="list">
            {info.asPartner.map((s) => (
              <div key={s.id} className="spread">
                <span>{x.cycleOf(s.name)}</span>
                <button className="btn" style={{ minHeight: 34 }} onClick={() => navigate(`/partner/${s.id}`)}>
                  {x.view}
                </button>
              </div>
            ))}
          </div>
          {!partnerOnly && (
            <>
              <button className="btn" onClick={() => saveSettings({ mode: 'partner' }).catch((e: Error) => toast(t.common.couldNotSave(e.message)))}>
                {t.settings.mode.partnerOnly}
              </button>
              <p className="hint">{t.settings.mode.partnerOnlyHint}</p>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

/** Keyboard dictation or Whisper on this device (a per-device choice). */
export function VoiceSection({ model, sizeMb }: { model: string; sizeMb: number }) {
  const t = useT();
  const x = t.settings.voice;
  const toast = useToast();
  const [choice, setChoice] = useState<VoiceInput>(voiceInputChoice);
  const [cached, setCached] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const supported = voiceSupported();

  useEffect(() => {
    void voiceModelCached(model).then(setCached);
  }, [model]);

  const download = async () => {
    setProgress(0);
    try {
      await prepareVoice(model, setProgress);
      setCached(true);
    } catch (e) {
      toast(x.failed((e as Error).message));
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="card stack">
      <h3>{x.title}</h3>
      <Seg
        label={x.title}
        allowNone={false}
        value={choice}
        options={['keyboard', 'whisper'] as const}
        labels={{ keyboard: x.keyboard, whisper: x.whisper }}
        onChange={(v) => {
          if (!v) return;
          setChoice(v);
          setVoiceInputChoice(v);
        }}
      />
      <p className="small muted">{choice === 'whisper' ? x.whisperHint(sizeMb) : x.keyboardHint}</p>
      {choice === 'whisper' &&
        (!supported ? (
          <p className="small">{x.unsupported}</p>
        ) : progress !== null ? (
          <p className="small" role="status">
            {x.downloading(Math.round(progress * 100))}
          </p>
        ) : cached ? (
          <div className="spread">
            <span className="chip high">{x.ready}</span>
            <button
              className="btn"
              onClick={async () => {
                await removeVoiceModel();
                setCached(false);
                toast(x.removed);
              }}
            >
              {x.remove}
            </button>
          </div>
        ) : (
          <button className="btn" onClick={download}>
            {x.download(sizeMb)}
          </button>
        ))}
      <p className="hint">{x.deviceOnly}</p>
    </section>
  );
}
