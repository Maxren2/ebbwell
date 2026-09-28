import { useEffect, useState } from 'react';
import { ApiError, api, type AccessReport, type AdminUser } from '../api.ts';
import { useStore } from '../store.tsx';
import { useToast } from '../ui.tsx';

const fmtDay = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never');

const POLICY: Record<AccessReport['policy']['localLogin'], string> = {
  disabled: 'Password sign-in is disabled. Only single sign-on works.',
  'local-network': 'Password sign-in only from the local network, never through the public domain.',
  everywhere: 'Password sign-in from anywhere, including the public domain.',
};

const ERRORS: Record<string, string> = {
  'last-admin': 'There must always be at least one active administrator.',
  'cannot-change-self': "You can't change your own administrator or disabled status.",
  'use-account-settings': 'Use your own account settings for that.',
  'managed-by-identity-provider': 'Administrator rights of single sign-on users come from their identity-provider groups.',
  'username-taken': 'That username is already taken.',
  invalid: 'Usernames use 3–32 lowercase letters, digits, dot, dash or underscore.',
};

const errorText = (e: unknown) => (e instanceof ApiError ? (ERRORS[e.message] ?? e.message) : (e as Error).message);

// ------------------------------------------------------------------ own account

export function AccountSection() {
  const { me } = useStore();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const a = me.account;

  return (
    <section className="card stack">
      <h3>Account</h3>
      <p className="small muted">
        {a.kind === 'local' ? `Local account "${a.username}"` : a.kind === 'oidc' ? 'Signed in with single sign-on' : 'Development account'}
        {a.isAdmin && ' · administrator'}
      </p>
      {a.kind === 'local' && (
        <details>
          <summary className="small">Change password</summary>
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
                toast('Password changed — other devices were signed out');
              } catch (err) {
                toast(err instanceof ApiError ? String(err.body.message ?? err.message) : 'Could not change the password');
              } finally {
                setBusy(false);
              }
            }}
          >
            <input type="text" autoComplete="username" value={a.username ?? ''} readOnly hidden />
            <label className="field">
              <span>Current password</span>
              <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </label>
            <label className="field">
              <span>New password (at least 10 characters)</span>
              <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Repeat new password</span>
              <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <button className="btn primary" disabled={busy || !current || password.length < 10 || password !== confirm}>
              Change password
            </button>
          </form>
        </details>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ administration

export function AdminSection() {
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
      toast(errorText(e));
    }
  };

  const c = access?.thisConnection;

  return (
    <section className="card stack" id="admin">
      <h3>Administration</h3>
      <p className="small muted">Manage who can sign in. Administrators never see anyone's cycle data.</p>

      {access && (
        <div className="card tone-ovulation small stack">
          <strong>Sign-in policy</strong>
          <span>{POLICY[access.policy.localLogin]}</span>
          <span>Single sign-on: {access.policy.oidc ? 'configured' : 'not configured'} · Public URL: {access.policy.publicUrl}</span>
          {access.policy.localLogin === 'local-network' && <span>Local networks: {access.policy.localNetworks.join(', ')}</span>}
          <span className="hint">Set by LOCAL_LOGIN / LOCAL_NETWORKS in the app configuration (TrueNAS app settings), not from here.</span>
          {c && (
            <span>
              This connection: {c.local ? 'local network' : 'outside the local network'}, {c.viaPublicUrl ? 'through the public domain' : 'direct address'},{' '}
              {c.secure ? 'HTTPS' : 'plain HTTP'} → password sign-in {c.localLoginAllowed ? <strong>allowed</strong> : <strong>not allowed</strong>}
              <span className="hint"> ({c.addresses.join(' → ')})</span>
            </span>
          )}
        </div>
      )}

      {secret && (
        <div className="card tone-warn stack small">
          <strong>Temporary password for {secret.username}</strong>
          <code className="invite-url">{secret.password}</code>
          <span>Shown only once. They must choose their own password at first sign-in.</span>
          <div className="grid-2">
            <button className="btn" onClick={() => navigator.clipboard.writeText(secret.password).then(() => toast('Copied'))}>
              Copy
            </button>
            <button className="btn" onClick={() => setSecret(null)}>
              Done
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
                · {u.kind === 'local' ? u.username : u.kind === 'oidc' ? 'single sign-on' : 'dev'}
                {u.isAdmin && ' · admin'}
                {u.disabled && ' · disabled'}
                {u.locked && ' · locked'}
                {u.self && ' · you'}
              </span>
            </summary>
            <div className="stack small" style={{ marginTop: 8 }}>
              <span className="muted">
                Created {fmtDay(u.createdAt)} · last sign-in {fmtDay(u.lastLoginAt)}
                {u.mustChangePassword && ' · temporary password pending'}
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
                      Reset password
                    </button>
                  )}
                  <button className="btn" onClick={() => act(() => api.admin.update(u.id, { isAdmin: !u.isAdmin }))}>
                    {u.isAdmin ? 'Remove admin' : 'Make admin'}
                  </button>
                  <button className="btn" onClick={() => act(() => api.admin.update(u.id, { disabled: !u.disabled }), u.disabled ? 'Account enabled' : 'Account disabled and signed out')}>
                    {u.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      if (confirm(`Delete ${u.name} and ALL their data? This cannot be undone.`)) void act(() => api.admin.remove(u.id), 'Account deleted');
                    }}
                  >
                    Delete
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
              <span>Username</span>
              <input type="text" autoCapitalize="none" spellCheck={false} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">
              <span>Display name</span>
              <input type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            <span>Administrator</span>
          </label>
          {access?.policy.localLogin === 'disabled' && (
            <p className="hint">Password sign-in is currently disabled (LOCAL_LOGIN), so this account can't sign in until it is enabled.</p>
          )}
          <div className="grid-2">
            <button className="btn primary" disabled={username.trim().length < 3}>
              Create account
            </button>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" onClick={() => setCreating(true)}>
          Add a local account
        </button>
      )}
    </section>
  );
}
