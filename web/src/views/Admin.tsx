import { useEffect, useState, type FormEvent } from 'react';
import type { Messages } from '../../../shared/i18n/index.ts';
import { ApiError, api, type AccessReport, type AdminUser } from '../api.ts';
import { fmtDay } from '../format.ts';
import { useT } from '../i18n.tsx';
import { useStore } from '../store.tsx';
import { useToast } from '../ui.tsx';

const MIN_PASSWORD = 10;

const errorText = (t: Messages, e: unknown) => (e instanceof ApiError ? (t.admin.errors[e.message] ?? e.message) : (e as Error).message);

function passwordError(t: Messages, e: unknown): string {
  if (!(e instanceof ApiError)) return t.account.couldNotChange;
  const reason = e.body.reason as keyof Messages['passwordErrors'] | undefined;
  if (reason === 'length') return t.passwordErrors.length(MIN_PASSWORD);
  if (reason && reason in t.passwordErrors) return t.passwordErrors[reason] as string;
  return String(e.body.message ?? e.message);
}

// ------------------------------------------------------------------ own account

export function AccountSection() {
  const { me } = useStore();
  const t = useT();
  const x = t.account;
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const a = me.account;

  return (
    <section className="card stack">
      <h3>{x.title}</h3>
      <p className="small muted">
        {a.kind === 'local' ? x.local(a.username ?? '') : a.kind === 'oidc' ? x.sso : x.dev}
        {a.isAdmin && x.administrator}
      </p>
      {a.kind === 'local' && (
        <details>
          <summary className="small">{x.changePassword}</summary>
          <form
            className="stack"
            style={{ marginTop: 8 }}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.account.changePassword(current, password, confirm);
                setCurrent('');
                setPassword('');
                setConfirm('');
                toast(x.passwordChanged);
              } catch (err) {
                toast(passwordError(t, err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <input type="text" autoComplete="username" value={a.username ?? ''} readOnly hidden />
            <label className="field">
              <span>{x.currentPassword}</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label className="field">
              <span>{x.newPassword(MIN_PASSWORD)}</span>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>{x.repeatPassword}</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !current || password.length < MIN_PASSWORD || password !== confirm}>
              {x.changePassword}
            </button>
          </form>
        </details>
      )}
      {a.kind === 'local' && <TwoFactorPanel />}
    </section>
  );
}

function TwoFactorPanel() {
  const t = useT();
  const x = t.account;
  const toast = useToast();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.account.twoFactor>> | null>(null);
  const [action, setAction] = useState<'renew' | 'disable' | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const load = () => api.account.twoFactor().then(setInfo).catch(() => {});
  useEffect(() => void load(), []);
  if (!info) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (action === 'renew') setCodes((await api.account.renewRecoveryCodes(password, code)).codes);
      else {
        await api.account.disableTwoFactor(password, code);
        toast(x.turnedOff);
      }
      setAction(null);
      setPassword('');
      setCode('');
      await load();
    } catch (err) {
      toast(errorText(t, err));
    }
  };

  return (
    <div className="stack">
      <div className="divider" />
      <div className="spread">
        <div>
          <strong>{x.twoFactor}</strong>
          <div className="small muted">
            {info.enabled ? x.twoFactorOn(info.recoveryCodesLeft) : x.off}
            {info.required && x.requiredByAdmin}
          </div>
        </div>
        {info.enabled ? <span className="chip high">{x.on}</span> : <span className="chip low">{x.off}</span>}
      </div>
      {!info.enabled && (
        <a className="btn primary" href="/auth/2fa/setup">
          {x.setUp}
        </a>
      )}
      {info.enabled && info.recoveryCodesLeft <= 3 && (
        <p className="small" style={{ color: 'var(--warn)' }}>
          {x.fewCodes}
        </p>
      )}
      {codes && (
        <div className="card tone-warn stack small">
          <strong>{x.newCodesTitle}</strong>
          <ol className="small" dir="ltr">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <div className="grid-2">
            <button className="btn" onClick={() => navigator.clipboard.writeText(codes.join('\n')).then(() => toast(t.common.copied))}>
              {t.common.copy}
            </button>
            <button className="btn" onClick={() => setCodes(null)}>
              {x.saved}
            </button>
          </div>
        </div>
      )}
      {info.enabled && !action && (
        <div className="grid-2">
          <button className="btn" onClick={() => setAction('renew')}>
            {x.newCodes}
          </button>
          {!info.required && (
            <button className="btn danger" onClick={() => setAction('disable')}>
              {t.common.turnOff}
            </button>
          )}
        </div>
      )}
      {action && (
        <form className="stack" onSubmit={submit}>
          <p className="small muted">{x.confirmHint}</p>
          <label className="field">
            <span>{x.password}</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>{x.code}</span>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          <div className="grid-2">
            <button className={`btn ${action === 'disable' ? 'danger' : 'primary'}`} disabled={!password || code.length < 6}>
              {action === 'renew' ? x.createCodes : x.turnOff2fa}
            </button>
            <button type="button" className="btn" onClick={() => setAction(null)}>
              {t.common.cancel}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ administration

export function AdminSection() {
  const t = useT();
  const x = t.admin;
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [access, setAccess] = useState<AccessReport | null>(null);
  const [secret, setSecret] = useState<{ username: string; password: string } | null>(null);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const [u, a] = await Promise.all([api.admin.users(), api.admin.access()]);
    setUsers(u);
    setAccess(a);
  };
  useEffect(() => void load().catch(() => {}), []);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      if (done) toast(done);
      await load();
    } catch (e) {
      toast(errorText(t, e));
    }
  };

  const day = (ms: number | null) => (ms ? fmtDay(ms, true) : t.common.never);
  const c = access?.thisConnection;

  return (
    <section className="card stack" id="admin">
      <h3>{x.title}</h3>
      <p className="small muted">{x.intro}</p>

      {access && (
        <div className="card tone-ovulation small stack">
          <strong>{x.policyTitle}</strong>
          <span>{x.policy[access.policy.localLogin]}</span>
          <span>{x.twoFactorPolicy(x.twoFactorValues[access.policy.twoFactor])}</span>
          <span>
            {x.sso(access.policy.oidc, '')}
            <bdi dir="ltr">{access.policy.publicUrl}</bdi>
          </span>
          {access.policy.localLogin === 'local-network' && (
            <span>
              {x.localNetworks('')}
              <bdi dir="ltr">{access.policy.localNetworks.join(', ')}</bdi>
            </span>
          )}
          <span className="hint">{x.setBy}</span>
          {c && (
            <span>
              {x.connection(c.local, c.viaPublicUrl, c.secure)}
              <strong>{c.localLoginAllowed ? x.allowed : x.notAllowed}</strong>
              <span className="hint">
                {' '}
                (<bdi dir="ltr">{c.addresses.join(' → ')}</bdi>)
              </span>
            </span>
          )}
        </div>
      )}

      {secret && (
        <div className="card tone-warn stack small">
          <strong>{x.temporaryPassword(secret.username)}</strong>
          <code className="invite-url" dir="ltr">
            {secret.password}
          </code>
          <span>{x.temporaryHint}</span>
          <div className="grid-2">
            <button className="btn" onClick={() => navigator.clipboard.writeText(secret.password).then(() => toast(t.common.copied))}>
              {t.common.copy}
            </button>
            <button className="btn" onClick={() => setSecret(null)}>
              {t.common.done}
            </button>
          </div>
        </div>
      )}

      <div className="list">
        {users?.map((u) => (
          <details key={u.id}>
            <summary>
              {u.name}{' '}
              <span className="small muted">
                · {u.kind === 'local' ? u.username : u.kind === 'oidc' ? x.kind.sso : x.kind.dev}
                {u.isAdmin && ` · ${x.tags.admin}`}
                {u.twoFactor && ` · ${x.tags.twoFactor}`}
                {u.disabled && ` · ${x.tags.disabled}`}
                {u.locked && ` · ${x.tags.locked}`}
                {u.self && ` · ${x.tags.you}`}
              </span>
            </summary>
            <div className="stack small" style={{ marginTop: 8 }}>
              <span className="muted">
                {x.created(day(u.createdAt), day(u.lastLoginAt))}
                {u.mustChangePassword && x.pendingTemporary}
              </span>
              {!u.self && (
                <div className="seg">
                  {u.kind === 'local' && (
                    <button
                      className="btn"
                      onClick={() =>
                        act(async () => {
                          const r = await api.admin.resetPassword(u.id);
                          setSecret({ username: u.username ?? u.name, password: r.temporaryPassword });
                        })
                      }
                    >
                      {x.resetPassword}
                    </button>
                  )}
                  {u.twoFactor && (
                    <button
                      className="btn"
                      onClick={() => {
                        if (confirm(x.resetTwoFactorConfirm(u.name))) void act(() => api.admin.resetTwoFactor(u.id), x.resetTwoFactorDone);
                      }}
                    >
                      {x.resetTwoFactor}
                    </button>
                  )}
                  <button className="btn" onClick={() => act(() => api.admin.update(u.id, { isAdmin: !u.isAdmin }))}>
                    {u.isAdmin ? x.removeAdmin : x.makeAdmin}
                  </button>
                  <button className="btn" onClick={() => act(() => api.admin.update(u.id, { disabled: !u.disabled }), u.disabled ? x.enabledDone : x.disabledDone)}>
                    {u.disabled ? x.enable : x.disable}
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (confirm(x.deleteConfirm(u.name))) void act(() => api.admin.remove(u.id), x.deleted);
                    }}
                  >
                    {t.common.delete}
                  </button>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>

      {creating ? (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            await act(async () => {
              const r = await api.admin.createUser(username.trim().toLowerCase(), name.trim() || username.trim(), makeAdmin);
              setSecret({ username: username.trim().toLowerCase(), password: r.temporaryPassword });
              setUsername('');
              setName('');
              setMakeAdmin(false);
              setCreating(false);
            });
          }}
        >
          <div className="grid-2">
            <label className="field">
              <span>{x.username}</span>
              <input type="text" autoCapitalize="none" spellCheck={false} maxLength={32} dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">
              <span>{x.displayName}</span>
              <input type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            <span>{x.administrator}</span>
          </label>
          {access?.policy.localLogin === 'disabled' && <p className="hint">{x.localDisabled}</p>}
          <div className="grid-2">
            <button className="btn primary" disabled={username.trim().length < 3}>
              {x.create}
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              {t.common.cancel}
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setCreating(true)}>
          {x.add}
        </button>
      )}
    </section>
  );
}
