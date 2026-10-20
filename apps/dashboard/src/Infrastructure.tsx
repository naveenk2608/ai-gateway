import { useQuery } from '@tanstack/react-query';
import { analyticsPath, api, type AnalyticsFilters, type InfraResponse } from './api.js';
import {
  formatAge,
  formatBytes,
  formatCount,
  formatLatency,
  formatPercent,
  formatTime,
} from './format.js';
import { QueryCard, Stat } from './ui.js';

/**
 * Only values the gateway measures (the infra endpoint). History lives in Prometheus and Grafana
 * (ADR 017); host metrics and container restarts depend on the deployment and are not shown.
 */

/** Shown where a value needs a second reading (CPU, event-loop delay). */
const NOT_YET = 'not measured yet: needs a second reading';
export function Infrastructure({
  projectId,
  filters,
}: {
  projectId: string;
  filters: AnalyticsFilters;
}) {
  const infra = useQuery({
    queryKey: ['infra', projectId, filters.range],
    queryFn: ({ signal }) =>
      api<InfraResponse>(analyticsPath('infra', projectId, { range: filters.range }), { signal }),
    refetchInterval: 15_000,
  });

  return (
    <>
      <QueryCard
        title="Usage event pipeline"
        what="pipeline state"
        query={infra}
        isEmpty={(data) =>
          data.pipeline !== null &&
          data.pipeline.streamLength === 0 &&
          data.pipeline.pendingEvents === 0 &&
          data.pipeline.deadLetterLength === 0 &&
          data.failedEvents.total === 0
        }
        empty="The pipeline is idle: no events are waiting, pending or dead-lettered."
      >
        {(data) => (
          <>
            <p className="muted small">
              Measured {formatTime(data.measuredAt)}, across every gateway instance.
            </p>
            {data.pipeline === null ? (
              <p className="error-text">The pipeline state is unavailable: Redis did not answer.</p>
            ) : (
              <div className="stats">
                <Stat
                  label="Unread events"
                  value={formatCount(data.pipeline.unreadEvents)}
                  note="worker lag"
                />
                <Stat label="Pending events" value={formatCount(data.pipeline.pendingEvents)} />
                <Stat label="Oldest pending" value={formatAge(data.pipeline.oldestPendingAgeMs)} />
                <Stat label="Consumers" value={formatCount(data.pipeline.consumers)} />
                <Stat label="Stream length" value={formatCount(data.pipeline.streamLength)} />
                <Stat label="Dead letters" value={formatCount(data.pipeline.deadLetterLength)} />
                <Stat
                  label="Failed events"
                  value={formatCount(data.failedEvents.inWindow)}
                  note={`last ${filters.range} · ${formatCount(data.failedEvents.total)} in all`}
                />
              </div>
            )}
          </>
        )}
      </QueryCard>
      <QueryCard
        title="Dependencies"
        what="dependency checks"
        query={infra}
        isEmpty={(data) => Object.keys(data.dependencies).length === 0}
        empty="No dependency checks are configured."
      >
        {(data) => (
          <ul className="checks">
            {Object.entries(data.dependencies).map(([name, check]) => (
              <li key={name}>
                <span
                  className={check.status === 'ok' ? 'dot ok' : 'dot fail'}
                  aria-hidden="true"
                />
                <span className="name">{name}</span>
                <span className="muted">
                  {check.status === 'ok' ? 'reachable' : 'failing'} ·{' '}
                  {formatLatency(check.latencyMs)} round trip
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryCard>
      <QueryCard
        title="This gateway instance"
        what="instance measurements"
        query={infra}
        isEmpty={() => false}
        empty=""
      >
        {({ instance, measuredAt }) => (
          <>
            <p className="muted small">
              Measured {formatTime(measuredAt)} by the instance that answered. With several
              instances, each refresh may reach a different one.
            </p>
            <div className="stats">
              <Stat label="Uptime" value={formatAge(instance.uptimeSeconds * 1_000)} />
              <Stat
                label="Memory (RSS)"
                value={formatBytes(instance.residentMemoryBytes)}
                note={`heap ${formatBytes(instance.heapUsedBytes)} of ${formatBytes(instance.heapTotalBytes)}`}
              />
              <Stat
                label="CPU"
                value={formatPercent(instance.cpuShare)}
                note={instance.cpuShare === null ? NOT_YET : 'of one core, since the last refresh'}
              />
              <Stat
                label="Event-loop delay p99"
                value={
                  instance.eventLoopDelayP99Ms === null
                    ? '—'
                    : formatLatency(instance.eventLoopDelayP99Ms)
                }
                note={instance.eventLoopDelayP99Ms === null ? NOT_YET : 'since the last refresh'}
              />
              <Stat
                label="Usage events buffered"
                value={formatCount(instance.usageEvents.buffered)}
                note="waiting for Redis"
              />
              <Stat
                label="Usage events dropped"
                value={formatCount(instance.usageEvents.dropped)}
                note={`${formatCount(instance.usageEvents.published)} written since start`}
              />
            </div>
          </>
        )}
      </QueryCard>
      <p className="muted small">
        History is kept by Prometheus and shown in Grafana when they run (the Compose
        <code>observability</code> profile). Host CPU and memory and container restarts depend on
        where the gateway runs and are not shown here.
      </p>
    </>
  );
}
