import { useEffect, useState } from 'react';
import { isIsoDate } from '../../shared/dates.ts';
import { I18nProvider, useT } from './i18n.tsx';
import { SCROLLER_ID, navigate, usePath } from './router.ts';
import { StoreProvider, useStore } from './store.tsx';
import { Icon, ToastProvider, type IconName } from './ui.tsx';
import { Today } from './views/Today.tsx';
import { CalendarView } from './views/Calendar.tsx';
import { DayEditor } from './views/DayEditor.tsx';
import { ChartView } from './views/Chart.tsx';
import { Insights } from './views/Insights.tsx';
import { SettingsView } from './views/Settings.tsx';
import { LockScreen } from './views/LockScreen.tsx';
import { InviteAccept, PartnerHome, PartnerPage } from './views/Partner.tsx';

const TABS: { path: string; label: 'today' | 'calendar' | 'chart' | 'insights' | 'settings'; icon: IconName }[] = [
  { path: '/', label: 'today', icon: 'today' },
  { path: '/calendar', label: 'calendar', icon: 'calendar' },
  { path: '/chart', label: 'chart', icon: 'chart' },
  { path: '/insights', label: 'insights', icon: 'insights' },
  { path: '/settings', label: 'settings', icon: 'settings' },
];
/** Partner-only accounts: the shared cycles and the settings. */
const PARTNER_TABS = TABS.filter((tab) => tab.path === '/' || tab.path === '/settings');

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
  const t = useT();
  return (
    <div className="splash">
      <img src="/icon-192.png" alt="" />
      {error === 'offline' ? (
        <>
          <p>{t.app.unreachable}</p>
          <button className="btn" onClick={() => location.reload()}>
            {t.common.retry}
          </button>
        </>
      ) : error ? (
        <>
          <p>{t.app.loadFailed(error)}</p>
          <button className="btn" onClick={() => location.reload()}>
            {t.common.retry}
          </button>
        </>
      ) : (
        <p>{t.app.loading}</p>
      )}
    </div>
  );
}

function Routes() {
  const path = usePath();
  const { settings } = useStore();
  const partnerMatch = /^\/partner\/([0-9a-f-]{36})$/.exec(path);
  if (partnerMatch) return <PartnerPage id={partnerMatch[1]!} />;
  if (path === '/invite') return <InviteAccept />;
  if (path === '/settings') return <SettingsView />;
  if (settings.mode === 'partner') return <PartnerHome />;
  const dayMatch = /^\/day\/(\d{4}-\d{2}-\d{2})$/.exec(path);
  if (dayMatch && isIsoDate(dayMatch[1]!)) return <DayEditor date={dayMatch[1]!} />;
  switch (path) {
    case '/calendar':
      return <CalendarView />;
    case '/chart':
      return <ChartView />;
    case '/insights':
      return <Insights />;
    default:
      return <Today />;
  }
}

export function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  );
}

function Shell() {
  const t = useT();
  const online = useOnline();

  return (
    <ToastProvider>
      <StoreProvider fallback={(error) => <Splash error={error} />} lockScreen={(onUnlocked) => <LockScreen onUnlocked={onUnlocked} />}>
        <div className="shell">
          <main id={SCROLLER_ID} className="scroller">
            <div className="app">
              {!online && <div className="banner">{t.app.offline}</div>}
              <Routes />
            </div>
          </main>
          <TabBar />
        </div>
      </StoreProvider>
    </ToastProvider>
  );
}

function TabBar() {
  const t = useT();
  const path = usePath();
  const { settings } = useStore();
  const tabs = settings.mode === 'partner' ? PARTNER_TABS : TABS;
  const active = tabs.find((t) => t.path !== '/' && path.startsWith(t.path))?.path ?? (/^\/(day|partner|invite)/.test(path) ? '' : '/');
  return (
    <nav className="tabbar" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} aria-label={t.nav.main}>
      {tabs.map((tab) => (
        <button key={tab.path} aria-current={active === tab.path ? 'page' : undefined} onClick={() => navigate(tab.path)}>
          <Icon name={tab.icon} />
          {t.nav[tab.label]}
        </button>
      ))}
    </nav>
  );
}
