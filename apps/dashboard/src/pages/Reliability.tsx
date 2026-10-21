import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { RotateCcw, Send, Shuffle, TriangleAlert } from 'lucide-react';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type BreakerInstance,
  type ReliabilityResponse,
} from '../api.js';
import { Sparkline } from '../charts/Sparkline.js';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.js';
import { TONES } from '../charts/theme.js';
import { formatCount, formatPercent, formatStep, formatTime } from '../format.js';
import { BreakdownTable } from '../ui/BreakdownTable.js';
import { KpiCard, NoTrend } from '../ui/KpiCard.js';
import { QueryCard } from '../ui/QueryCard.js';
import { ErrorState } from '../ui/states.js';

const STATE_LABELS: Record<BreakerInstance['state'], string> = {
  closed: 'closed',
  open: 'open',
  half_open: 'half-open',
};

type Data = ReliabilityResponse;

function ReliabilityKpis({ query, range }: { query: UseQueryResult<Data>; range: string }) {
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const pending = <span className="skeleton w-75" aria-hidden="true" />;
  const per = data ? `per ${formatStep(data.window.stepSeconds)}` : '';
  const totals = data?.totals;
  const line = (key: 'failed' | 'retries' | 'fallbacks', label: string) =>
    data && <Sparkline values={data.series.map((p) => p[key])} label={`${label} ${per}`} />;

  return (
    <div className="kpi-row" aria-busy={query.isPending}>
      {!data && <span className="visually-hidden">Loading reliability…</span>}
      <KpiCard
        icon={TriangleAlert}
        label="Failed"
        value={totals ? formatCount(totals.failed) : pending}
        note={totals ? `${formatPercent(totals.errorRate)} of admitted requests` : undefined}
        trend={line('failed', 'Failed requests')}
      />
      <KpiCard
        icon={RotateCcw}
        label="Retries"
        value={totals ? formatCount(totals.retries) : pending}
        note={totals ? 'on the same deployment' : undefined}
        trend={line('retries', 'Retries')}
      />
      <KpiCard
        icon={Shuffle}
        label="Fallbacks"
        value={totals ? formatCount(totals.fallbacks) : pending}
        note={totals ? 'to the next deployment' : undefined}
        trend={line('fallbacks', 'Fallbacks')}
      />
      <KpiCard
        icon={Send}
        label="Upstream attempts"
        value={totals ? formatCount(totals.attempts) : pending}
        note={totals ? `for ${formatCount(totals.requests)} requests, last ${range}` : undefined}
        trend={data && <NoTrend />}
      />
    </div>
  );
}

/** Each deployment's breaker, with the state every gateway instance reports for it. */
function Breakers({ breakers }: { breakers: NonNullable<Data['breakers']> }) {
  return (
    <div className="tiles">
      {breakers.map((b) => (
        <div key={b.deployment} className="tile" role="group" aria-label={b.deployment}>
          <div className="tile-title">{b.deployment}</div>
          {b.instances.length === 0 ? (
            <div className="row">
              <span className="badge breaker-closed">closed</span>
              <span className="muted small">never tripped</span>
            </div>
          ) : (
            <ul className="instance-states">
              {b.instances.map((i) => (
                <li key={i.instanceId}>
                  <span className={`badge breaker-${i.state}`}>{STATE_LABELS[i.state]}</span>
                  <span className="muted small">
                    {i.instanceId}
                    {i.at && ` · since ${formatTime(i.at)}`}
                  </span>
                  {i.reason && <span className="muted small block">{i.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export function Reliability({
  projectId,
  filters,
}: {
  projectId: string;
  filters: AnalyticsFilters;
}) {
  const reliability = useQuery({
    queryKey: ['reliability', projectId, filters],
    queryFn: ({ signal }) =>
      api<ReliabilityResponse>(analyticsPath('reliability', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const noRequests = (data: Data) => data.totals.requests === 0;
  const empty = `No requests in the last ${filters.range}.`;

  return (
    <>
      <ReliabilityKpis query={reliability} range={filters.range} />
      <div className="split">
        <QueryCard
          title="Failures, retries and fallbacks"
          what="reliability"
          query={reliability}
          isEmpty={noRequests}
          empty={empty}
          actions={
            reliability.data && (
              <span className="muted small">
                per {formatStep(reliability.data.window.stepSeconds)}
              </span>
            )
          }
        >
          {(data) => (
            <TimeSeriesChart
              label="Failures, retries and fallbacks per interval"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              stacked={false}
              lines={[
                { key: 'failed', label: 'Failed', color: TONES.danger },
                { key: 'retries', label: 'Retries', color: TONES.warning },
                { key: 'fallbacks', label: 'Fallbacks', color: TONES.accent },
              ]}
            />
          )}
        </QueryCard>
        <QueryCard
          title="Errors by code"
          what="errors by code"
          query={reliability}
          isEmpty={(data) => noRequests(data) || data.errorsByCode.length === 0}
          empty={
            reliability.data && !noRequests(reliability.data)
              ? 'No failed or canceled requests.'
              : empty
          }
        >
          {(data) => (
            <BreakdownTable
              label="Code"
              rows={data.errorsByCode.map((e) => ({
                key: `${e.status}|${e.errorCode}`,
                name: `${e.errorCode ?? 'unknown'} (${e.status})`,
                value: e.requests,
                display: formatCount(e.requests),
              }))}
            />
          )}
        </QueryCard>
      </div>
      <QueryCard
        title="By deployment"
        what="deployments"
        query={reliability}
        isEmpty={(data) => data.byDeployment.length === 0}
        empty={`No request reached a deployment in the last ${filters.range}.`}
      >
        {(data) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Deployment</th>
                  <th className="num">Requests</th>
                  <th className="num">Failed</th>
                  <th className="num">Failure rate</th>
                  <th className="num">Attempts</th>
                  <th className="num">Retries</th>
                  <th className="num">Fallbacks</th>
                </tr>
              </thead>
              <tbody>
                {data.byDeployment.map((d) => (
                  <tr key={`${d.deployment}|${d.provider}`}>
                    <td className="strong">
                      {d.deployment ?? '—'}
                      {d.provider && <div className="muted small">{d.provider}</div>}
                    </td>
                    <td className="num">{formatCount(d.requests)}</td>
                    <td className="num">{formatCount(d.failed)}</td>
                    <td className="num">
                      {formatPercent(d.requests > 0 ? d.failed / d.requests : null)}
                    </td>
                    <td className="num">{formatCount(d.attempts)}</td>
                    <td className="num">{formatCount(d.retries)}</td>
                    <td className="num">{formatCount(d.fallbacks)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryCard>
      <QueryCard
        title="Circuit breakers"
        what="breaker states"
        query={reliability}
        isEmpty={(data) => data.breakers !== null && data.breakers.length === 0}
        empty="No deployments are configured."
        actions={<span className="muted small">now, per gateway instance</span>}
      >
        {(data) =>
          data.breakers === null ? (
            <p className="error-text">Breaker states are unavailable: Redis did not answer.</p>
          ) : (
            <Breakers breakers={data.breakers} />
          )
        }
      </QueryCard>
      <QueryCard
        title="Breaker changes and health checks"
        what="health events"
        query={reliability}
        isEmpty={(data) => data.healthEvents.length === 0}
        empty={`No breaker opened or recovered in the last ${filters.range}.`}
      >
        {(data) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Deployment</th>
                  <th>Change</th>
                  <th>Instance</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.healthEvents.map((e) => (
                  <tr key={`${e.occurredAt}|${e.instanceId}|${e.deployment}`}>
                    <td className="small">{formatTime(e.occurredAt)}</td>
                    <td className="strong">{e.deployment}</td>
                    <td>
                      {e.fromState ?? '—'} → {e.toState}
                    </td>
                    <td className="mono small">{e.instanceId}</td>
                    <td>{e.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryCard>
    </>
  );
}
