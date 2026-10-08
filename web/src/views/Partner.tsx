import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PartnerView, ShareScope } from '../../../shared/partner.ts';
import { ApiError, api, type ShareSummary } from '../api.ts';
import { clearPendingInvite, goBack, navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { fmtDate, fmtRange, relDays } from '../format.ts';
import { useT } from '../i18n.tsx';
import { marksInputFromPartner } from '../marks.ts';
import { Icon, useToast } from '../ui.tsx';
import { Legend, MonthCalendar } from './Calendar.tsx';

function PartnerSummary({ view, today }: { view: PartnerView; today: string }) {
  const t = useT();
  const x = t.partner;
  const c = view.current;
  const next = view.predictions[1];
  const cur = view.predictions[0];
  if (view.paused) return <p className="muted small">{x.paused(view.owner.name)}</p>;
  if (!c || !next) return <p className="muted small">{x.noCycle}</p>;
  return (
    <div className="stack">
      <div className="spread">
        <div className="stat">
          <div className="label">{x.cycleDay}</div>
          <div className="value">{c.cycleDay}</div>
        </div>
        <div className="stat" style={{ textAlign: 'end' }}>
          <div className="label">{x.now}</div>
          <div className="value" style={{ fontSize: '1.05rem' }}>
            {c.phase === 'late' ? x.late(c.daysLate) : x.phase[c.phase]}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="card tone-period">
          <h3>{x.nextPeriod}</h3>
          <div className="stat">
            <div className="value">{fmtDate(next.start.date)}</div>
            <div className="label">
              {relDays(today, next.start.date)} · {fmtRange(next.start)}
            </div>
          </div>
          <p>
            <span className={`chip ${view.confidence}`}>{t.confidence[view.confidence]}</span>
          </p>
        </div>
        {cur?.fertileStart && cur.fertileEnd && cur.ovulation ? (
          <div className="card tone-fertile">
            <h3>{x.fertileWindow}</h3>
            <div className="stat">
              <div className="value" style={{ fontSize: '1.05rem' }}>
                {fmtDate(cur.fertileStart)} – {fmtDate(cur.fertileEnd)}
              </div>
              <div className="label">{x.ovulation(c.ovulationConfirmed, fmtDate(cur.ovulation.date))}</div>
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>{x.periodEnds}</h3>
            <div className="stat">
              <div className="value" style={{ fontSize: '1.05rem' }}>
                {fmtDate(c.phase === 'period' && cur ? cur.periodEnd : next.periodEnd)}
              </div>
              <div className="label">{c.phase === 'period' ? x.thisPeriod : x.nextPeriodExpected}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One shared cycle. As the home screen of a partner-only account (`home`) it has no back
 * button, and ending the share hands back to the caller instead of navigating.
 */
export function PartnerPage({ id, home = false, onEnded }: { id: string; home?: boolean; onEnded?: () => void }) {
  const { today, loadedAt } = useStore();
  const t = useT();
  const x = t.partner;
  const toast = useToast();
  const [view, setView] = useState<PartnerView | null>(null);
  const [error, setError] = useState<'ended' | 'failed' | null>(null);

  // Fetched again whenever the app reloads its data (e.g. back in the foreground).
  useEffect(() => {
    api.shares
      .view(id, today)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 404 ? 'ended' : 'failed'));
  }, [id, today, loadedAt]);

  const days = useMemo(() => new Map(view?.days.map((d) => [d.date, d.data]) ?? []), [view]);
  const input = useMemo(() => (view ? marksInputFromPartner(view) : null), [view]);
  const todayData = days.get(today);

  return (
    <>
      <header className="page-header">
        {!home && (
          <button className="icon-btn" aria-label={t.common.back} onClick={() => goBack('/')}>
            <Icon name="left" />
          </button>
        )}
        <h1 style={home ? undefined : { fontSize: '1.3rem' }}>{view ? t.sharing.cycleOf(view.owner.name) : x.sharedCycle}</h1>
        {!home && <span style={{ width: 40 }} />}
      </header>
      {error && (
        <div className="card">
          <p>{error === 'ended' ? x.ended : x.loadFailed}</p>
        </div>
      )}
      {view && input && (
        <div className="stack">
          <div className="card">
            <PartnerSummary view={view} today={today} />
          </div>
          {view.scopes.includes('wellbeing') && (
            <div className="card">
              <h3>{x.today}</h3>
              {todayData?.symptoms?.length || todayData?.mood?.length ? (
                <div className="seg">
                  {todayData.mood?.map((m) => (
                    <span key={m} className="chip medium">
                      {t.labels.mood[m]}
                    </span>
                  ))}
                  {todayData.symptoms?.map((s) => (
                    <span key={s} className="chip">
                      {t.labels.symptoms[s]}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="small muted">{x.nothingToday}</p>
              )}
            </div>
          )}
          <MonthCalendar input={input} days={days} today={today} />
          <Legend fertility={view.scopes.includes('fertility')} />
          {view.stats && view.stats.mean !== null && (
            <div className="card small">{x.stats(view.stats.mean, view.stats.sd, view.stats.min, view.stats.max, view.stats.periodMean)}</div>
          )}
          <p className="hint center">
            {x.sharedBy(
              view.owner.name,
              view.scopes.map((s) => t.scopes[s].inline),
            )}
          </p>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(x.stopConfirm(view.owner.name))) return;
              await api.shares.end(id);
              toast(x.stopped);
              if (onEnded) onEnded();
              else navigate('/', { replace: true });
            }}
          >
            {x.stop}
          </button>
        </div>
      )}
    </>
  );
}

/** Home screen of a partner-only account: the shared cycle, or a list when there are several. */
export function PartnerHome() {
  const { saveSettings, loadedAt } = useStore();
  const t = useT();
  const x = t.partnerHome;
  const toast = useToast();
  const [shares, setShares] = useState<ShareSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    api.shares
      .list()
      .then((r) => {
        setShares(r.asPartner);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load, loadedAt]);

  if (failed) return <div className="card">{t.partner.loadFailed}</div>;
  if (!shares) return null;
  if (shares.length === 1) return <PartnerPage key={shares[0]!.id} id={shares[0]!.id} home onEnded={load} />;
  return (
    <>
      <header className="page-header">
        <h1>{x.title}</h1>
      </header>
      <div className="stack">
        {shares.length ? (
          <PartnerCards />
        ) : (
          <div className="card stack">
            <h2>{x.none}</h2>
            <p className="small muted">{x.noneHint}</p>
            <button className="btn" onClick={() => saveSettings({ mode: 'own' }).catch((e: Error) => toast(t.common.couldNotSave(e.message)))}>
              {x.trackOwn}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Compact cards on Today for cycles shared with the user. */
export function PartnerCards() {
  const { today, loadedAt } = useStore();
  const t = useT();
  const x = t.partner;
  const [items, setItems] = useState<{ share: ShareSummary; view: PartnerView | null }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { asPartner } = await api.shares.list();
        const views = await Promise.all(asPartner.map((s) => api.shares.view(s.id, today).catch(() => null)));
        if (!cancelled) setItems(asPartner.map((share, i) => ({ share, view: views[i] ?? null })));
      } catch {
        /* optional section */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [today, loadedAt]);

  return (
    <>
      {items.map(({ share, view }) => {
        const next = view?.predictions[1];
        const c = view?.current;
        return (
          <button key={share.id} className="card spread" style={{ textAlign: 'start', width: '100%' }} onClick={() => navigate(`/partner/${share.id}`)}>
            <div>
              <h2>{t.sharing.cycleOf(share.name)}</h2>
              <p className="small muted">
                {!view
                  ? x.card.unavailable
                  : view.paused
                    ? x.card.paused
                    : c && next
                      ? x.card.summary(c.cycleDay, c.phase === 'late' ? x.card.late(c.daysLate) : x.phase[c.phase], relDays(today, next.start.date))
                      : x.card.noCycle}
              </p>
            </div>
            <span className="icon-btn" aria-hidden="true">
              <Icon name="right" />
            </span>
          </button>
        );
      })}
    </>
  );
}

export function InviteAccept() {
  const { settings, days, saveSettings } = useStore();
  const t = useT();
  const x = t.invite;
  const toast = useToast();
  // Set once accepted by someone who doesn't track anything yet: ask how they'll use the app.
  const [choosing, setChoosing] = useState<{ id: string; name: string } | null>(null);
  // The code lives in the URL fragment (never sent to the server in requests or logs).
  const [code] = useState(() => location.hash.slice(1));
  const [preview, setPreview] = useState<{ name: string; scopes: string[]; own: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    clearPendingInvite();
    history.replaceState(null, '', '/invite');
    if (!code) return setError(x.incomplete);
    api.shares
      .preview(code)
      .then(setPreview)
      .catch(() => setError(x.invalid));
  }, [code]);

  return (
    <>
      <header className="page-header">
        <h1>{x.title}</h1>
      </header>
      {choosing ? (
        <div className="card stack">
          <h2>{x.choice.title}</h2>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await saveSettings({ mode: 'partner' });
                navigate('/', { replace: true });
              } catch (e) {
                toast(t.common.couldNotSave((e as Error).message));
                setBusy(false);
              }
            }}
          >
            {x.choice.follow(choosing.name)}
          </button>
          <p className="hint">{x.choice.followHint}</p>
          <button className="btn" disabled={busy} onClick={() => navigate(`/partner/${choosing.id}`, { replace: true })}>
            {x.choice.own}
          </button>
        </div>
      ) : (
        <div className="card stack">
          {error && <p>{error}</p>}
          {preview?.own && <p>{x.own}</p>}
          {preview && !preview.own && (
            <>
              <h2>{x.wants(preview.name)}</h2>
              <p className="small muted">{x.youllSee}</p>
              <ul className="small">
                <li>{x.always}</li>
                {preview.scopes.map((s) => (
                  <li key={s}>{t.scopes[s as ShareScope]?.body}</li>
                ))}
              </ul>
              <p className="hint">{x.never(preview.name)}</p>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const { id } = await api.shares.accept(code);
                    toast(x.accepted);
                    if (settings.mode === 'own' && days.size === 0) setChoosing({ id, name: preview.name });
                    else navigate(settings.mode === 'partner' ? '/' : `/partner/${id}`, { replace: true });
                  } catch {
                    setError(x.couldNotAccept);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {x.accept}
              </button>
            </>
          )}
          <button className="btn" onClick={() => navigate('/', { replace: true })}>
            {x.notNow}
          </button>
        </div>
      )}
    </>
  );
}
