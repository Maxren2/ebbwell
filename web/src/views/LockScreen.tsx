import { useCallback, useEffect, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { ApiError, api, type LockStatus } from '../api.ts';
import { hasDeviceBiometric } from '../device.ts';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const;

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.lock.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const biometricAvailable = !!status?.biometrics && hasDeviceBiometric() && 'credentials' in navigator;

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        await api.lock.unlock(value);
        onUnlocked();
      } catch (e) {
        setPin('');
        if (e instanceof ApiError && e.body.error === 'wrong-pin') {
          const left = Number(e.body.remaining);
          setMessage(left > 1 ? `Wrong PIN — ${left} attempts left` : 'Wrong PIN — last attempt before signing out');
        } else if (!(e instanceof ApiError && e.status === 401)) {
          setMessage("Couldn't reach the server");
        }
      } finally {
        setBusy(false);
      }
    },
    [onUnlocked],
  );

  const press = (k: string) => {
    if (busy) return;
    setMessage(null);
    if (k === '⌫') return setPin((p) => p.slice(0, -1));
    if (!k || pin.length >= 8) return;
    setPin((p) => p + k);
  };

  // Keyboard support on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Enter' && pin.length >= 4) void submit(pin);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const biometric = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const options = await api.lock.unlockOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.lock.unlockVerify(response);
      onUnlocked();
    } catch (e) {
      if (e instanceof ApiError && e.body.error === 'wrong-pin') setMessage('Biometric check failed — use your PIN');
      else if (!(e instanceof ApiError && e.status === 401)) setMessage('Biometric unlock was cancelled');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lock-screen">
      <img src="/icon-192.png" alt="" className="lock-logo" />
      <h1>Ebbwell is locked</h1>
      <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
        {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
          <i key={i} className={i < pin.length ? 'on' : ''} />
        ))}
      </div>
      <p className="lock-message" role="alert">
        {message ?? ' '}
      </p>
      <div className="keypad">
        {KEYS.map((k, i) =>
          k === '' ? (
            biometricAvailable ? (
              <button key={i} className="key small" onClick={biometric} disabled={busy} aria-label="Unlock with biometrics">
                Face / Touch
              </button>
            ) : (
              <span key={i} />
            )
          ) : (
            <button key={i} className="key" onClick={() => press(k)} disabled={busy} aria-label={k === '⌫' ? 'Delete' : k}>
              {k}
            </button>
          ),
        )}
      </div>
      <button className="btn primary lock-go" disabled={busy || pin.length < 4} onClick={() => submit(pin)}>
        Unlock
      </button>
      <div className="lock-links">
        <a href="/auth/login?reauth=1">Forgot PIN? Sign in again</a>
        <button
          className="linklike"
          onClick={async () => {
            const { redirect } = await api.logout();
            location.assign(redirect);
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
