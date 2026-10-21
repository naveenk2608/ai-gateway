import { useQuery } from '@tanstack/react-query';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type OverviewResponse,
  type Project,
} from '../api.js';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.js';
import { TONES } from '../charts/theme.js';
import { budgetShare, formatCount, formatLatency, formatPercent, formatUsd } from '../format.js';
import { fetchGatewayStatus, type GatewayStatus } from '../gatewayStatus.js';
import { QueryCard } from '../ui/QueryCard.js';
import { Stat } from '../ui/Stat.js';
import { Loading } from '../ui/states.js';

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

/** All-zero series and totals are real data, but there is nothing to chart. */
const noRequests = (data: OverviewResponse) => data.totals.requests === 0;

export function Overview({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const overview = useQuery({
    queryKey: ['overview', projectId, filters],
    queryFn: ({ signal }) =>
      api<OverviewResponse>(analyticsPath('overview', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => api<Project>(`/admin/projects/${projectId}`, { signal }),
  });
  const budget = project.data?.budget.monthlyLimitMicroUsd ?? null;

  return (
    <>
      <QueryCard
        title={`Traffic, last ${filters.range}`}
        what="counters"
        query={overview}
        isEmpty={noRequests}
        empty={`No requests in the last ${filters.range}. Send one to /v1/chat/completions.`}
      >
        {(data) => (
          <>
            <div className="stats">
              <Stat label="Requests" value={formatCount(data.totals.requests)} />
              <Stat label="Succeeded" value={formatCount(data.totals.succeeded)} />
              <Stat
                label="Failed"
                value={formatCount(data.totals.failed)}
                note={`${formatPercent(data.totals.errorRate)} of admitted`}
              />
              <Stat
                label="Rejected"
                value={formatCount(data.totals.rejected)}
                note="limits and budgets"
              />
              <Stat label="Cache hits" value={formatCount(data.totals.cacheHits)} />
              <Stat label="Tokens" value={formatCount(data.totals.totalTokens)} />
              <Stat label="Cost" value={formatUsd(data.totals.costMicroUsd)} />
              <Stat
                label="Latency p95"
                value={formatLatency(data.totals.latencyMs.p95)}
                note={`p50 ${formatLatency(data.totals.latencyMs.p50)} · approx.`}
              />
              <Stat
                label="TTFT p95"
                value={formatLatency(data.totals.ttftMs.p95)}
                note="streamed requests · approx."
              />
            </div>
            <h3>Request rate</h3>
            <TimeSeriesChart
              label="Requests per interval by outcome"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              lines={[
                { key: 'succeeded', label: 'Succeeded', color: TONES.success },
                { key: 'failed', label: 'Failed', color: TONES.danger },
                { key: 'rejected', label: 'Rejected', color: TONES.warning },
                { key: 'canceled', label: 'Canceled', color: TONES.neutral },
              ]}
            />
          </>
        )}
      </QueryCard>
      {overview.data && (
        <section className="card">
          <h2>Spend in {overview.data.month.period} (UTC)</h2>
          <div className="stats">
            <Stat label="Spent" value={formatUsd(overview.data.month.spentMicroUsd)} />
            <Stat
              label="Budget"
              value={budget === null ? 'none' : formatUsd(budget)}
              note={budgetShare(overview.data.month.spentMicroUsd, budget) ?? undefined}
            />
          </div>
        </section>
      )}
      <GatewayStatusCard />
    </>
  );
}
