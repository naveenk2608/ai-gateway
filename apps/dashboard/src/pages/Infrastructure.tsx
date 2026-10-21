import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Archive, Database, Hourglass, Inbox } from 'lucide-react';
import { analyticsPath, api, type AnalyticsFilters, type InfraResponse } from '../api.js';
import {
  formatAge,
  formatBytes,
  formatCount,
  formatLatency,
  formatPercent,
  formatTime,
} from '../format.js';
import { KpiCard, NoTrend } from '../ui/KpiCard.js';
import { QueryCard } from '../ui/QueryCard.js';
import { Stat } from '../ui/Stat.js';
import { ErrorState } from '../ui/states.js';

/**
 * Only values the gateway measures (the infra endpoint). History lives in Prometheus and Grafana
 * (ADR 017); host metrics and container restarts depend on the deployment and are not shown.
 */

/** Shown where a value needs a second reading (CPU, event-loop delay). */
const NOT_YET = 'not measured yet: needs a second reading';

/** The trend slot of every card here: the endpoint returns one reading, history is elsewhere. */
const LIVE = 'current reading';

type Data = InfraResponse;

/** The pipeline's headline numbers and how many dependencies answer. */
function InfraKpis({ query }: { query: UseQueryResult<Data> }) {
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const pending = <span className="skeleton w-75" aria-hidden="true" />;
  const pipeline = data?.pipeline;
  const noRedis = 'Redis did not answer';
  const value = (read: (p: NonNullable<Data['pipeline']>) => string) =>
    !data ? pending : pipeline ? read(pipeline) : '—';
  const checks = data ? Object.values(data.dependencies) : [];
  const live = data && <NoTrend>{LIVE}</NoTrend>;

  return (
    <div className="kpi-row" aria-busy={query.isPending}>
      {!data && <span className="visually-hidden">Loading pipeline state…</span>}
      <KpiCard
        icon={Inbox}
        label="Worker lag"
        value={value((p) => formatCount(p.unreadEvents))}
        note={data ? (pipeline ? 'events not read yet' : noRedis) : undefined}
        trend={live}
      />
      <KpiCard
        icon={Hourglass}
        label="Pending"
        value={value((p) => formatCount(p.pendingEvents))}
        note={
          data
            ? pipeline
              ? `read, not stored · oldest ${formatAge(pipeline.oldestPendingAgeMs)}`
              : noRedis
            : undefined
        }
        trend={live}
      />
      <KpiCard
        icon={Archive}
        label="Dead letters"
        value={value((p) => formatCount(p.deadLetterLength))}
        note={data ? `${formatCount(data.failedEvents.total)} failed events stored` : undefined}
        trend={live}
      />
      <KpiCard
        icon={Database}
        label="Dependencies"
        value={
          data
            ? checks.length === 0
              ? '—'
              : `${formatCount(checks.filter((c) => c.status === 'ok').length)} of ${formatCount(checks.length)}`
            : pending
        }
        note={data ? 'reachable' : undefined}
        trend={live}
      />
    </div>
  );
}

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
      <InfraKpis query={infra} />
      <div className="split">
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
                <p className="error-text">
                  The pipeline state is unavailable: Redis did not answer.
                </p>
              ) : (
                <div className="stats">
                  <Stat
                    label="Unread events"
                    value={formatCount(data.pipeline.unreadEvents)}
                    note="worker lag"
                  />
                  <Stat label="Pending events" value={formatCount(data.pipeline.pendingEvents)} />
                  <Stat
                    label="Oldest pending"
                    value={formatAge(data.pipeline.oldestPendingAgeMs)}
                  />
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
      </div>
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
        <code> observability</code> profile). Host CPU and memory and container restarts depend on
        where the gateway runs and are not shown here.
      </p>
    </>
  );
}
