import { useQuery } from '@tanstack/react-query';
import { api, type Overview as OverviewData } from './api.js';
import { budgetShare, formatCount, formatUsd } from './format.js';
import { fetchGatewayStatus, type GatewayStatus } from './gatewayStatus.js';
import { Empty, ErrorState, Loading, Stat } from './ui.js';

const STATUS_LABELS: Record<GatewayStatus['kind'], string> = {
  ready: 'Ready',
  not_ready: 'Not ready',
  unreachable: 'Unreachable',
};

function GatewayStatusCard() {
  const status = useQuery({
    queryKey: ['ready'],
    queryFn: ({ signal }) => fetchGatewayStatus(fetch, signal),
    refetchInterval: 30_000,
  });
  return (
    <section className="card" aria-busy={status.isPending}>
      <div className="card-header">
        <h2>
          Gateway status
          {status.data && (
            <span className={`badge ${status.data.kind}`}>{STATUS_LABELS[status.data.kind]}</span>
          )}
        </h2>
        <button type="button" onClick={() => void status.refetch()} disabled={status.isFetching}>
          Refresh
        </button>
      </div>
      {!status.data ? (
        <Loading what="status" />
      ) : status.data.kind === 'unreachable' ? (
        <p className="muted">The dashboard could not reach the gateway.</p>
      ) : (
        <ul className="checks">
          {status.data.checks.map((check) => (
            <li key={check.name}>
              <span className={check.ok ? 'dot ok' : 'dot fail'} aria-hidden="true" />
              <span className="name">{check.name}</span>
              <span className="muted">
                {check.ok ? 'reachable' : 'failing'}
                {check.latencyMs === null ? '' : ` · ${check.latencyMs} ms`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface AnalyticsOverview {
  window: { from: string; to: string };
  totals: Omit<OverviewData, 'from' | 'to' | 'month'>;
  month: { period: string; spentMicroUsd: number };
}

/** The last 24 hours from the analytics API, plus the project's budget. */
async function fetchOverview(projectId: string, signal: AbortSignal): Promise<OverviewData> {
  const [overview, project] = await Promise.all([
    api<AnalyticsOverview>(`/admin/analytics/overview?projectId=${projectId}&range=24h`, {
      signal,
    }),
    api<{ budget: { monthlyLimitMicroUsd: number | null } }>(`/admin/projects/${projectId}`, {
      signal,
    }),
  ]);
  return {
    ...overview.totals,
    from: overview.window.from,
    to: overview.window.to,
    month: { ...overview.month, budgetMicroUsd: project.budget.monthlyLimitMicroUsd },
  };
}

export function Overview({ projectId }: { projectId: string }) {
  const overview = useQuery({
    queryKey: ['overview', projectId],
    queryFn: ({ signal }) => fetchOverview(projectId, signal),
    refetchInterval: 30_000,
  });

  return (
    <>
      <section className="card" aria-busy={overview.isPending}>
        <h2>Last 24 hours</h2>
        {overview.isPending ? (
          <Loading what="counters" />
        ) : overview.isError ? (
          <ErrorState error={overview.error} retry={() => void overview.refetch()} />
        ) : overview.data.requests === 0 ? (
          <Empty>No requests in the last 24 hours. Send one to `/v1/chat/completions`.</Empty>
        ) : (
          <div className="stats">
            <Stat label="Requests" value={formatCount(overview.data.requests)} />
            <Stat label="Succeeded" value={formatCount(overview.data.succeeded)} />
            <Stat label="Failed" value={formatCount(overview.data.failed)} />
            <Stat
              label="Rejected"
              value={formatCount(overview.data.rejected)}
              note="limits and budgets"
            />
            <Stat label="Cache hits" value={formatCount(overview.data.cacheHits)} />
            <Stat label="Tokens" value={formatCount(overview.data.totalTokens)} />
            <Stat label="Cost" value={formatUsd(overview.data.costMicroUsd)} />
          </div>
        )}
      </section>
      {overview.data && (
        <section className="card">
          <h2>Spend in {overview.data.month.period} (UTC)</h2>
          <div className="stats">
            <Stat label="Spent" value={formatUsd(overview.data.month.spentMicroUsd)} />
            <Stat
              label="Budget"
              value={
                overview.data.month.budgetMicroUsd === null
                  ? 'none'
                  : formatUsd(overview.data.month.budgetMicroUsd)
              }
              note={
                budgetShare(
                  overview.data.month.spentMicroUsd,
                  overview.data.month.budgetMicroUsd,
                ) ?? undefined
              }
            />
          </div>
        </section>
      )}
      <GatewayStatusCard />
    </>
  );
}
