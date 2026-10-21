import { useQuery } from '@tanstack/react-query';
import { analyticsPath, api, type AnalyticsFilters, type ReliabilityResponse } from '../api.js';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.js';
import { TONES } from '../charts/theme.js';
import { formatCount, formatPercent, formatTime } from '../format.js';
import { BreakdownTable } from '../ui/BreakdownTable.js';
import { QueryCard } from '../ui/QueryCard.js';
import { Stat } from '../ui/Stat.js';
import { Empty } from '../ui/states.js';

const STATE_LABELS = { closed: 'closed', open: 'open', half_open: 'half-open' } as const;

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

  return (
    <>
      <QueryCard
        title={`Errors, retries and fallbacks, last ${filters.range}`}
        what="reliability"
        query={reliability}
        isEmpty={(data) => data.totals.requests === 0}
        empty={`No requests in the last ${filters.range}.`}
      >
        {(data) => (
          <>
            <div className="stats">
              <Stat
                label="Failed"
                value={formatCount(data.totals.failed)}
                note={`${formatPercent(data.totals.errorRate)} of admitted`}
              />
              <Stat label="Retries" value={formatCount(data.totals.retries)} />
              <Stat label="Fallbacks" value={formatCount(data.totals.fallbacks)} />
              <Stat label="Upstream attempts" value={formatCount(data.totals.attempts)} />
            </div>
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
            <div className="grid-2">
              <div>
                <h3>Errors by code</h3>
                {data.errorsByCode.length === 0 ? (
                  <Empty>No failed or canceled requests.</Empty>
                ) : (
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
              </div>
              <div>
                <h3>By deployment</h3>
                {data.byDeployment.length === 0 ? (
                  <Empty>No request reached a deployment.</Empty>
                ) : (
                  <BreakdownTable
                    label="Deployment"
                    rows={data.byDeployment.map((d) => ({
                      key: `${d.deployment}|${d.provider}`,
                      name: d.deployment ?? '',
                      value: d.failed,
                      display: `${formatCount(d.failed)} failed`,
                      note: `${formatCount(d.requests)} req · ${formatCount(d.retries)} retries · ${formatCount(d.fallbacks)} fallbacks`,
                    }))}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </QueryCard>
      <QueryCard
        title="Circuit breakers"
        what="breaker states"
        query={reliability}
        isEmpty={(data) => data.breakers !== null && data.breakers.length === 0}
        empty="No deployments are configured."
      >
        {(data) =>
          data.breakers === null ? (
            <p className="error-text">Breaker states are unavailable: Redis did not answer.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Deployment</th>
                    <th>State per gateway instance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakers.map((b) => (
                    <tr key={b.deployment}>
                      <td>{b.deployment}</td>
                      <td>
                        {b.instances.length === 0 ? (
                          <span className="muted">closed (never tripped)</span>
                        ) : (
                          b.instances.map((i) => (
                            <div key={i.instanceId} className="small">
                              <span className={`badge breaker-${i.state}`}>
                                {STATE_LABELS[i.state]}
                              </span>{' '}
                              <span className="muted">
                                {i.instanceId}
                                {i.at && ` · since ${formatTime(i.at)}`}
                              </span>
                            </div>
                          ))
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.healthEvents.map((e) => (
                  <tr key={`${e.occurredAt}|${e.instanceId}|${e.deployment}`}>
                    <td>{formatTime(e.occurredAt)}</td>
                    <td>{e.deployment}</td>
                    <td>
                      {e.fromState ?? '—'} → {e.toState}
                    </td>
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
