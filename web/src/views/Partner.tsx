import { useEffect, useMemo, useState } from 'react';
import { SCOPE_LABELS, type PartnerView } from '../../../shared/partner.ts';
import { ApiError, api, type ShareSummary } from '../api.ts';
import { goBack, navigate } from '../router.ts';
import { useStore } from '../store.tsx';
import { CONFIDENCE, LABELS, fmtDate, fmtRange, relDays } from '../format.ts';
import { marksInputFromPartner } from '../marks.ts';
import { Icon, useToast } from '../ui.tsx';
import { Legend, MonthCalendar } from './Calendar.tsx';

const PHASE: Record<NonNullable<PartnerView['current']>['phase'], string> = {
  period: 'Period',
  late: 'Period late',
  cycle: 'Between periods',
  follicular: 'Before fertile window',
  fertile: 'Fertile window',
  'peak-fertile': 'Peak fertility',
  luteal: 'After ovulation',
};

function PartnerSummary({ view, today }: { view: PartnerView; today: string }) {
  const c = view.current;
  const next = view.predictions[1];
  const cur = view.predictions[0];
  if (view.paused) return <p className="muted small">{view.owner.name} has paused predictions.</p>;
  if (!c || !next) return <p className="muted small">No cycle logged yet.</p>;
  return (
    <div className="stack">
      <div className="spread">
        <div className="stat">
          <div className="label">Cycle day</div>
          <div className="value">{c.cycleDay}</div>
        </div>
        <div className="stat" style={{ textAlign: 'right' }}>
          <div className="label">Now</div>
          <div className="value" style={{ fontSize: '1.05rem' }}>
            {c.phase === 'late' ? `${c.daysLate} day${c.daysLate > 1 ? 's' : ''} late` : PHASE[c.phase]}
          </div>
        </div>
      </div>
      <div className="grid-2">
        <div className="card tone-period">
          <h3>Next period</h3>
          <div className="stat">
            <div className="value">{fmtDate(next.start.date)}</div>
            <div className="label">
              {relDays(today, next.start.date)} · {fmtRange(next.start)}
            </div>
          </div>
          <p>
            <span className={`chip ${view.confidence}`}>{CONFIDENCE[view.confidence]}</span>
          </p>
        </div>
        {cur?.fertileStart && cur.fertileEnd && cur.ovulation ? (
          <div className="card tone-fertile">
            <h3>Fertile window</h3>
            <div className="stat">
              <div className="value" style={{ fontSize: '1.05rem' }}>
                {fmtDate(cur.fertileStart)} – {fmtDate(cur.fertileEnd)}
              </div>
              <div className="label">
                Ovulation {c.ovulationConfirmed ? 'confirmed' : 'expected'} {fmtDate(cur.ovulation.date)}
              </div>
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>Period ends</h3>
            <div className="stat">
              <div className="value" style={{ fontSize: '1.05rem' }}>
                {fmtDate(c.phase === 'period' && cur ? cur.periodEnd : next.periodEnd)}
              </div>
              <div className="label">{c.phase === 'period' ? 'this period (expected)' : 'next period (expected)'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PartnerPage({ id }: { id: string }) {
  const { today } = useStore();
  const toast = useToast();
  const [view, setView] = useState<PartnerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shares
      .view(id, today)
      .then(setView)
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 404 ? 'This share has ended.' : "Couldn't load the shared cycle."));
  }, [id, today]);

  const days = useMemo(() => new Map(view?.days.map((d) => [d.date, d.data]) ?? []), [view]);
  const input = useMemo(() => (view ? marksInputFromPartner(view) : null), [view]);
  const todayData = days.get(today);

  return (
    <>
      <header className="page-header">
        <button className="icon-btn" aria-label="Back" onClick={() => goBack('/')}>
          <Icon name="left" />
        </button>
        <h1 style={{ fontSize: '1.3rem' }}>{view ? `${view.owner.name}'s cycle` : 'Shared cycle'}</h1>
        <span style={{ width: 40 }} />
      </header>
      {error && (
        <div className="card">
          <p>{error}</p>
        </div>
      )}
      {view && input && (
        <div className="stack">
          <div className="card">
            <PartnerSummary view={view} today={today} />
          </div>
          {view.scopes.includes('wellbeing') && (
            <div className="card">
              <h3>Today</h3>
              {todayData?.symptoms?.length || todayData?.mood?.length ? (
                <div className="seg">
                  {todayData.mood?.map((m) => (
                    <span key={m} className="chip medium">
                      {LABELS.mood[m]}
                    </span>
                  ))}
                  {todayData.symptoms?.map((s) => (
                    <span key={s} className="chip">
                      {LABELS.symptoms[s]}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="small muted">Nothing logged today.</p>
              )}
            </div>
          )}
          <MonthCalendar input={input} days={days} today={today} />
          <Legend fertility={view.scopes.includes('fertility')} />
          {view.stats && view.stats.mean !== null && (
            <div className="card small">
              Average cycle {view.stats.mean} days{view.stats.sd !== null && ` (± ${view.stats.sd})`}, range {view.stats.min}–{view.stats.max} days
              {view.stats.periodMean !== null && `, period ${view.stats.periodMean} days`}.
            </div>
          )}
          <p className="hint center">
            Shared by {view.owner.name}: period predictions{view.scopes.map((s) => `, ${SCOPE_LABELS[s].title.toLowerCase()}`).join('')}. Notes and
            intimate details are never shared.
          </p>
          <button
            className="btn danger"
            onClick={async () => {
              if (!confirm(`Stop viewing ${view.owner.name}'s cycle? They would need to invite you again.`)) return;
              await api.shares.end(id);
              toast('You no longer see this cycle');
              navigate('/', { replace: true });
            }}
          >
            Stop viewing
          </button>
        </div>
      )}
    </>
  );
}

/** Compact cards on Today for cycles shared with the user. */
export function PartnerCards() {
  const { today } = useStore();
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
  }, [today]);

  return (
    <>
      {items.map(({ share, view }) => {
        const next = view?.predictions[1];
        const c = view?.current;
        return (
          <button key={share.id} className="card spread" style={{ textAlign: 'left', width: '100%' }} onClick={() => navigate(`/partner/${share.id}`)}>
            <div>
              <h2>{share.name}'s cycle</h2>
              <p className="small muted">
                {!view
                  ? 'Unavailable'
                  : view.paused
                    ? 'Predictions paused'
                    : c && next
                      ? `Day ${c.cycleDay} · ${c.phase === 'late' ? `${c.daysLate} d late` : PHASE[c.phase].toLowerCase()} · next period ${relDays(today, next.start.date)}`
                      : 'No cycle logged yet'}
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
  const toast = useToast();
  // The code lives in the URL fragment (never sent to the server in requests or logs).
  const [code] = useState(() => location.hash.slice(1));
  const [preview, setPreview] = useState<{ name: string; scopes: string[]; own: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    history.replaceState(null, '', '/invite');
    if (!code) return setError('This invite link is incomplete.');
    api.shares
      .preview(code)
      .then(setPreview)
      .catch(() => setError('This invite is invalid, expired or already used.'));
  }, [code]);

  return (
    <>
      <header className="page-header">
        <h1>Invitation</h1>
      </header>
      <div className="card stack">
        {error && <p>{error}</p>}
        {preview?.own && <p>This is your own invite link — send it to your partner instead.</p>}
        {preview && !preview.own && (
          <>
            <h2>{preview.name} wants to share their cycle with you</h2>
            <p className="small muted">You'll see, read-only:</p>
            <ul className="small">
              <li>Period predictions and cycle day</li>
              {preview.scopes.map((s) => (
                <li key={s}>{SCOPE_LABELS[s as keyof typeof SCOPE_LABELS]?.body}</li>
              ))}
            </ul>
            <p className="hint">Notes and intimate details are never shared. {preview.name} can stop sharing at any time.</p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { id } = await api.shares.accept(code);
                  toast('Invitation accepted');
                  navigate(`/partner/${id}`, { replace: true });
                } catch {
                  setError('This invite could not be accepted.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Accept
            </button>
          </>
        )}
        <button className="btn" onClick={() => navigate('/', { replace: true })}>
          Not now
        </button>
      </div>
    </>
  );
}
