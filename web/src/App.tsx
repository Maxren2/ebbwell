import { useEffect, useState } from 'react';
import { isIsoDate } from '../../shared/dates.ts';
import { navigate, usePath } from './router.ts';
import { StoreProvider } from './store.tsx';
import { Icon, ToastProvider, type IconName } from './ui.tsx';
import { Today } from './views/Today.tsx';
import { CalendarView } from './views/Calendar.tsx';
import { DayEditor } from './views/DayEditor.tsx';
import { ChartView } from './views/Chart.tsx';
import { Insights } from './views/Insights.tsx';
import { SettingsView } from './views/Settings.tsx';
import { LockScreen } from './views/LockScreen.tsx';
import { InviteAccept, PartnerPage } from './views/Partner.tsx';

const TABS: { path: string; label: string; icon: IconName }[] = [
  { path: '/', label: 'Today', icon: 'today' },
  { path: '/calendar', label: 'Calendar', icon: 'calendar' },
  { path: '/chart', label: 'Chart', icon: 'chart' },
  { path: '/insights', label: 'Insights', icon: 'insights' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
];

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function Splash({ error }: { error: string | null }) {
  return (
    <div className="splash">
      <img src="/icon-192.png" alt="" />
      {error === 'offline' ? (
        <>
          <p>Can't reach your Ebbwell server. Your data is never stored on this device, so a connection is needed.</p>
          <button className="btn" onClick={() => location.reload()}>
            Retry
          </button>
        </>
      ) : error ? (
        <>
          <p>Couldn't load your data ({error}).</p>
          <button className="btn" onClick={() => location.reload()}>
            Retry
          </button>
        </>
      ) : (
        <p>Loading…</p>
      )}
    </div>
  );
}

function Routes() {
  const path = usePath();
  const dayMatch = /^\/day\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (dayMatch && isIsoDate(dayMatch[1]!)) return <DayEditor date={dayMatch[1]!} />;
  const partnerMatch = /^\/partner\/([0-9a-f-]{36})$/.exec(path);
  if (partnerMatch) return <PartnerPage id={partnerMatch[1]!} />;
  if (path === '/invite') return <InviteAccept />;
  switch (path) {
    case '/calendar':
      return <CalendarView />;
    case '/chart':
      return <ChartView />;
    case '/insights':
      return <Insights />;
    case '/settings':
      return <SettingsView />;
    default:
      return <Today />;
  }
}

export function App() {
  const path = usePath();
  const online = useOnline();
  const active = TABS.find((t) => t.path !== '/' && path.startsWith(t.path))?.path ?? (/^\/(day|partner|invite)/.test(path) ? '' : '/');

  return (
    <ToastProvider>
      <StoreProvider fallback={(error) => <Splash error={error} />} lockScreen={(onUnlocked) => <LockScreen onUnlocked={onUnlocked} />}>
        <div className="app">
          {!online && <div className="banner">Offline — changes can't be saved until you reconnect.</div>}
          <Routes />
        </div>
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => (
            <button key={t.path} aria-current={active === t.path ? 'page' : undefined} onClick={() => navigate(t.path)}>
              <Icon name={t.icon} />
              {t.label}
            </button>
          ))}
        </nav>
      </StoreProvider>
    </ToastProvider>
  );
}
