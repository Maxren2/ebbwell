import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analyze, type Analysis } from '../../shared/engine.ts';
import { localToday } from '../../shared/dates.ts';
import { isEmptyDay, type DayData, type Settings } from '../../shared/schema.ts';
import { ApiError, LOCKED_EVENT, api, syncPushSubscription, type Me } from './api.ts';
import { deviceLanguage, useI18n } from './i18n.tsx';

interface Store {
  me: Me;
  settings: Settings;
  days: Map<string, DayData>;
  analysis: Analysis;
  today: string;
  saveDay: (date: string, data: DayData) => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  reload: () => Promise<void>;
  /** App lock config for this user (null = no lock). */
  lockTimeout: number | null;
  refreshLock: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

/** Local date, refreshed when the app comes back to the foreground (PWAs stay open for days). */
function useToday(): string {
  const [today, setToday] = useState(localToday);
  useEffect(() => {
    const update = () => setToday(localToday());
    document.addEventListener('visibilitychange', update);
    const timer = setInterval(update, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', update);
      clearInterval(timer);
    };
  }, []);
  return today;
}

const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function StoreProvider(props: {
  children: ReactNode;
  fallback: (error: string | null) => ReactNode;
  lockScreen: (onUnlocked: () => void) => ReactNode;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [days, setDays] = useState<Map<string, DayData>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockTimeout, setLockTimeout] = useState<number | null>(null);
  const today = useToday();
  const { setPreference } = useI18n();
  const lastActivity = useRef(Date.now());
  const lastPing = useRef(Date.now());

  /** Drops every piece of health data from memory. */
  const lock = useCallback(() => {
    setLocked(true);
    setMe(null);
    setDays(new Map());
  }, []);

  const refreshLock = useCallback(async () => {
    const status = await api.lock.status();
    setLockTimeout(status.enabled ? status.timeoutSec : null);
  }, []);

  const reload = useCallback(async () => {
    try {
      const m = await api.me();
      if (m.account.mustChangePassword || m.account.twoFactorSetupRequired) {
        window.location.assign(m.account.mustChangePassword ? '/auth/password' : '/auth/2fa/setup');
        return;
      }
      const d = await api.days();
      setMe(m);
      setDays(new Map(d.map((e) => [e.date, e.data])));
      setLocked(false);
      setError(null);
      void refreshLock().catch(() => {});
      void syncPushSubscription().catch(() => {});
      setPreference(m.settings.language);
      // Reminders are written on the server in this device's time zone and language.
      const tz = deviceTimeZone();
      const language = deviceLanguage();
      const n = m.settings.notifications;
      if (n.timezone !== tz || n.language !== language) {
        const saved = await api.saveSettings({ ...m.settings, notifications: { ...n, timezone: tz, language } }).catch(() => null);
        if (saved) setMe({ ...m, settings: saved });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 423) return; // lock screen takes over
      // fetch() rejects with a TypeError on network failure (server unreachable / offline).
      setError(!navigator.onLine || err instanceof TypeError ? 'offline' : (err as Error).message);
    }
  }, [refreshLock, setPreference]);

  useEffect(() => {
    void reload();
    const onOnline = () => void reload();
    window.addEventListener('online', onOnline);
    window.addEventListener(LOCKED_EVENT, lock);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener(LOCKED_EVENT, lock);
    };
  }, [reload, lock]);

  // App lock behaviour: lock when leaving (timeout 0), lock after inactivity, keep the
  // server-side unlock window open while the user is active.
  useEffect(() => {
    if (lockTimeout === null) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (lockTimeout === 0) {
          void api.lock.lockNow(true).catch(() => {});
          lock();
        }
      } else if (!locked) {
        void reload();
      }
    };
    const onActivity = () => {
      lastActivity.current = Date.now();
      if (Date.now() - lastPing.current > 60_000) {
        lastPing.current = Date.now();
        void api.ping().catch(() => {});
      }
    };
    const idle = setInterval(() => {
      const limit = (lockTimeout > 0 ? lockTimeout : 300) * 1000;
      if (!locked && Date.now() - lastActivity.current > limit) {
        void api.lock.lockNow().catch(() => {});
        lock();
      }
    }, 10_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      clearInterval(idle);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, [lockTimeout, locked, lock, reload]);

  const saveDay = useCallback(async (date: string, data: DayData) => {
    if (isEmptyDay(data)) await api.deleteDay(date);
    else await api.saveDay(date, data);
    setDays((prev) => {
      const next = new Map(prev);
      if (isEmptyDay(data)) next.delete(date);
      else next.set(date, data);
      return next;
    });
  }, []);

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      if (!me) return;
      const saved = await api.saveSettings({ ...me.settings, ...patch });
      setMe({ ...me, settings: saved });
      setPreference(saved.language);
    },
    [me, setPreference],
  );

  const analysis = useMemo(() => {
    if (!me) return null;
    const entries = [...days].map(([date, data]) => ({ date, data })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return analyze(entries, me.settings, today);
  }, [days, me, today]);

  if (locked) {
    return (
      <>
        {props.lockScreen(() => {
          lastActivity.current = Date.now();
          void reload();
        })}
      </>
    );
  }
  if (!me || !analysis) return <>{props.fallback(error)}</>;

  return (
    <Ctx.Provider
      value={{ me, settings: me.settings, days, analysis, today, saveDay, saveSettings, reload, lockTimeout, refreshLock }}
    >
      {props.children}
    </Ctx.Provider>
  );
}
