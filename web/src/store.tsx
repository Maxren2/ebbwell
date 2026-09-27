import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { analyze, type Analysis } from '../../shared/engine.ts';
import { localToday } from '../../shared/dates.ts';
import { isEmptyDay, type DayData, type Settings } from '../../shared/schema.ts';
import { api, type Me } from './api.ts';

interface Store {
  me: Me;
  settings: Settings;
  days: Map<string, DayData>;
  analysis: Analysis;
  today: string;
  saveDay: (date: string, data: DayData) => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  reload: () => Promise<void>;
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

export function StoreProvider({ children, fallback }: { children: ReactNode; fallback: (error: string | null) => ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [days, setDays] = useState<Map<string, DayData>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const today = useToday();

  const reload = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([api.me(), api.days()]);
      setMe(m);
      setDays(new Map(d.map((e) => [e.date, e.data])));
      setError(null);
    } catch (err) {
      // fetch() rejects with a TypeError on network failure (server unreachable / offline).
      setError(!navigator.onLine || err instanceof TypeError ? 'offline' : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onOnline = () => void reload();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [reload]);

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
    },
    [me],
  );

  const analysis = useMemo(() => {
    if (!me) return null;
    const entries = [...days].map(([date, data]) => ({ date, data })).sort((a, b) => (a.date < b.date ? -1 : 1));
    return analyze(entries, me.settings, today);
  }, [days, me, today]);

  if (!me || !analysis) return <>{fallback(error)}</>;

  return (
    <Ctx.Provider value={{ me, settings: me.settings, days, analysis, today, saveDay, saveSettings, reload }}>
      {children}
    </Ctx.Provider>
  );
}
