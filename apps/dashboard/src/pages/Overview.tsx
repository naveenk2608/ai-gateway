import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Activity, CircleDollarSign, DatabaseZap, Timer, TriangleAlert } from 'lucide-react';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type CostResponse,
  type OverviewResponse,
  type Project,
  type RequestPage,
} from '../api.js';
import { errorRates, shareOfAdmitted } from '../charts/series.js';
import { Sparkline } from '../charts/Sparkline.js';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.js';
import { TONES } from '../charts/theme.js';
import {
  budgetShare,
  formatCount,
  formatLatency,
  formatPercent,
  formatShortTime,
  formatStep,
  formatUsd,
  shortId,
} from '../format.js';
import { fetchGatewayStatus, type GatewayStatus } from '../gatewayStatus.js';
import { KpiCard, NoTrend } from '../ui/KpiCard.js';
import { budgetUse, Meter } from '../ui/Meter.js';
import { QueryCard } from '../ui/QueryCard.js';
import { ErrorState, Loading } from '../ui/states.js';

/** Rows in the recent requests card; the Requests page has the rest. */
const RECENT = 6;

const STATUS_LABELS: Record<GatewayStatus['kind'], string> = {
  ready: 'Ready',
  not_ready: 'Not ready',
  unreachable: 'Unreachable',
};

function GatewayReadiness() {
  const status = useQuery({
    queryKey: ['ready'],
    queryFn: ({ signal }) => fetchGatewayStatus(fetch, signal),
    refetchInterval: 30_000,
  });
  return (
    <section className="card" aria-busy={status.isPending}>
      <div className="card-header">
        <h2>
          Gateway readiness
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
        <p className="muted card-text">The dashboard could not reach the gateway.</p>
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

/**
 * The headline numbers of the window. Requests, error rate and cost have sparklines from API
 * series; the API has no per-interval latency percentiles or cache hits, so those cards say so.
 */
function KpiRow({
  overview,
  cost,
  range,
}: {
  overview: UseQueryResult<OverviewResponse>;
  cost: UseQueryResult<CostResponse>;
  range: string;
}) {
  if (overview.isError) {
    return <ErrorState error={overview.error} retry={() => void overview.refetch()} />;
  }
  const data = overview.data;
  const pending = <span className="skeleton w-75" aria-hidden="true" />;
  const per = data ? `per ${formatStep(data.window.stepSeconds)}` : '';
  const rates = data ? errorRates(data.series) : null;
  const admitted = data ? formatCount(data.totals.requests - data.totals.rejected) : '';

  return (
    <div className="kpi-row" aria-busy={overview.isPending}>
      {!data && <span className="visually-hidden">Loading counters…</span>}
      <KpiCard
        icon={Activity}
        label="Requests"
        value={data ? formatCount(data.totals.requests) : pending}
        note={data ? `last ${range} · ${formatCount(data.totals.rejected)} rejected` : undefined}
        trend={
          data && (
            <Sparkline values={data.series.map((p) => p.requests)} label={`Requests ${per}`} />
          )
        }
      />
      <KpiCard
        icon={TriangleAlert}
        label="Error rate"
        value={data ? formatPercent(data.totals.errorRate) : pending}
        note={
          data ? `${formatCount(data.totals.failed)} of ${admitted} admitted failed` : undefined
        }
        trend={
          rates &&
          (rates.some((r) => r !== null) ? (
            <Sparkline values={rates} label={`Error rate ${per}`} format={formatPercent} />
          ) : (
            <NoTrend>no admitted requests</NoTrend>
          ))
        }
      />
      <KpiCard
        icon={Timer}
        label="Latency p95"
        value={data ? formatLatency(data.totals.latencyMs.p95) : pending}
        note={data ? `p50 ${formatLatency(data.totals.latencyMs.p50)} · approx.` : undefined}
        trend={data && <NoTrend />}
      />
      <KpiCard
        icon={CircleDollarSign}
        label="Cost"
        value={data ? formatUsd(data.totals.costMicroUsd) : pending}
        note={data ? `${formatCount(data.totals.totalTokens)} tokens` : undefined}
        trend={
          cost.data ? (
            <Sparkline
              values={cost.data.series.map((p) => p.costMicroUsd)}
              label={`Cost per ${formatStep(cost.data.window.stepSeconds)}`}
              format={formatUsd}
            />
          ) : (
            cost.isError && <NoTrend>trend unavailable</NoTrend>
          )
        }
      />
      <KpiCard
        icon={DatabaseZap}
        label="Cache-hit ratio"
        value={data ? formatPercent(shareOfAdmitted(data.totals.cacheHits, data.totals)) : pending}
        note={data ? `${formatCount(data.totals.cacheHits)} of ${admitted} admitted` : undefined}
        trend={data && <NoTrend />}
      />
    </div>
  );
}

function RecentRequests({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const recent = useQuery({
    queryKey: ['requests', projectId, filters, 'recent'],
    queryFn: ({ signal }) =>
      api<RequestPage>(analyticsPath('requests', projectId, filters, { limit: String(RECENT) }), {
        signal,
      }),
    refetchInterval: 30_000,
  });
  return (
    <QueryCard
      title="Recent requests"
      what="recent requests"
      query={recent}
      isEmpty={(data) => data.data.length === 0}
      empty={`No requests in the last ${filters.range}.`}
      actions={
        <a className="card-link" href="#requests">
          View all
        </a>
      }
    >
      {(data) => (
        <ul className="recent">
          {data.data.map((r) => (
            <li key={r.id}>
              <div className="recent-main">
                <span className="recent-model">{r.model}</span>
                <span className="mono muted small" title={r.id}>
                  {shortId(r.id)}
                </span>
              </div>
              <div className="recent-meta">
                <span className={`badge status-${r.status}`} title={r.status}>
                  {r.httpStatus}
                </span>
                <span className="mono small">{formatLatency(r.latencyMs)}</span>
                <span className="muted small">{formatShortTime(r.startedAt)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </QueryCard>
  );
}

function MonthSpend({
  overview,
  project,
}: {
  overview: UseQueryResult<OverviewResponse>;
  project: UseQueryResult<Project>;
}) {
  return (
    <QueryCard
      title={overview.data ? `Spend in ${overview.data.month.period} (UTC)` : 'Spend this month'}
      what="spend"
      query={overview}
      isEmpty={() => false}
      empty={null}
    >
      {(data) => {
        const spent = data.month.spentMicroUsd;
        const budget = project.data?.budget.monthlyLimitMicroUsd ?? null;
        return (
          <>
            <div className="spend">
              <span className="spend-value">{formatUsd(spent)}</span>
              <span className="muted">
                {project.isPending
                  ? 'loading the budget…'
                  : budget === null
                    ? 'no monthly budget'
                    : `of ${formatUsd(budget)} budget · ${budgetShare(spent, budget)} used`}
              </span>
            </div>
            {budget !== null && (
              <Meter
                share={budgetUse(spent, budget)}
                label="Budget used"
                valueText={budgetShare(spent, budget) ?? undefined}
              />
            )}
            <p className="muted small card-text">
              The calendar month so far, for the whole project.
            </p>
          </>
        );
      }}
    </QueryCard>
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
  // The cost sparkline: the overview series has counts only. Shares its cache with the Cost page.
  const cost = useQuery({
    queryKey: ['cost', projectId, filters],
    queryFn: ({ signal }) =>
      api<CostResponse>(analyticsPath('cost', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => api<Project>(`/admin/projects/${projectId}`, { signal }),
  });

  return (
    <>
      <KpiRow overview={overview} cost={cost} range={filters.range} />
      <div className="overview-split">
        <QueryCard
          title="Request rate"
          what="the request rate"
          query={overview}
          isEmpty={noRequests}
          empty={`No requests in the last ${filters.range}. Send one to /v1/chat/completions.`}
          actions={
            overview.data && (
              <span className="muted small">
                per {formatStep(overview.data.window.stepSeconds)}
              </span>
            )
          }
        >
          {(data) => (
            <TimeSeriesChart
              label="Requests per interval by outcome"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              lines={[
                { key: 'succeeded', label: 'Succeeded', color: TONES.accent },
                { key: 'failed', label: 'Failed', color: TONES.danger },
                { key: 'rejected', label: 'Rejected', color: TONES.warning },
                { key: 'canceled', label: 'Canceled', color: TONES.neutral },
              ]}
            />
          )}
        </QueryCard>
        <RecentRequests projectId={projectId} filters={filters} />
      </div>
      <div className="card-grid">
        <MonthSpend overview={overview} project={project} />
        <GatewayReadiness />
      </div>
    </>
  );
}
