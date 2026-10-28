import { useQuery } from '@tanstack/react-query';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type BreakerInstance,
  type ModelCatalog,
  type ModelsResponse,
  type ReliabilityResponse,
} from '../api.js';
import { CategoryBarChart } from '../charts/CategoryBarChart.js';
import { TONES } from '../charts/theme.js';
import { formatCount, formatLatency, formatPercent, formatUsd } from '../format.js';
import { ModelLabel, ProviderBadge } from '../ui/ProviderBadge.js';
import { familyOnHost, identifyProvider, useProviderOf } from '../ui/providers.js';
import { QueryCard } from '../ui/QueryCard.js';

type Row = ModelsResponse['data'][number] & { deployment: string };

/** Rows that reached a deployment; rows without one were rejected before routing. */
const routed = (data: ModelsResponse): Row[] =>
  data.data.filter((row): row is Row => row.deployment !== null);

const rowName = (row: Row) => `${row.model} · ${row.deployment}`;

const BREAKER_LABELS = { closed: 'Breaker closed', open: 'Breaker open', half_open: 'Half-open' };
const SEVERITY = { closed: 0, half_open: 1, open: 2 } as const;

/** The worst state any gateway instance reports for a deployment; closed if none tripped. */
function worstState(instances: BreakerInstance[]): BreakerInstance['state'] {
  return instances.reduce<BreakerInstance['state']>(
    (worst, i) => (SEVERITY[i.state] > SEVERITY[worst] ? i.state : worst),
    'closed',
  );
}

function ComparisonTable({ rows }: { rows: Row[] }) {
  const providerOf = useProviderOf();
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Deployment</th>
            <th className="num">Requests</th>
            <th className="num">Latency p50</th>
            <th className="num">Latency p95</th>
            <th className="num">TTFT p50 / p95</th>
            <th className="num">Tokens/s</th>
            <th className="num">Cost</th>
            <th className="num">Cost / request</th>
            <th className="num">Failure rate</th>
            <th className="num">Fallbacks / request</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ model, deployment, provider, metrics: m }) => {
            const admitted = m.requests - m.rejected;
            return (
              <tr key={`${model}|${deployment}`}>
                <td className="strong">
                  <ModelLabel
                    name={model}
                    family={provider ? providerOf(provider, deployment).family : null}
                  />
                </td>
                <td>
                  <div className="deployment-cell">
                    {provider && <ProviderBadge provider={providerOf(provider, deployment)} />}
                    <span>{deployment}</span>
                  </div>
                </td>
                <td className="num">{formatCount(m.requests)}</td>
                <td className="num">{formatLatency(m.latencyMs.p50)}</td>
                <td className="num">{formatLatency(m.latencyMs.p95)}</td>
                <td className="num">
                  {formatLatency(m.ttftMs.p50)} / {formatLatency(m.ttftMs.p95)}
                </td>
                <td className="num">
                  {m.outputTokensPerSecond === null
                    ? '—'
                    : m.outputTokensPerSecond.toLocaleString('en-US')}
                </td>
                <td className="num">{formatUsd(m.costMicroUsd)}</td>
                <td className="num">
                  {admitted > 0 ? formatUsd(Math.round(m.costMicroUsd / admitted)) : '—'}
                </td>
                <td className="num">{formatPercent(m.errorRate)}</td>
                <td className="num">{m.fallbackRate === null ? '—' : m.fallbackRate.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A deployment's provider, then the provider's model name with its family's logo. */
function DeploymentModel({ deployment: d }: { deployment: ModelCatalog['deployments'][number] }) {
  const provider = identifyProvider({
    provider: d.provider,
    deployment: d.id,
    model: d.providerModel,
  });
  return (
    <div className="deployment-cell">
      <ProviderBadge provider={provider} />
      <span className="mono muted small">
        <ModelLabel name={d.providerModel} family={familyOnHost(provider, d.providerModel)} />
      </span>
    </div>
  );
}

export function Models({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const models = useQuery({
    queryKey: ['models', projectId, filters],
    queryFn: ({ signal }) =>
      api<ModelsResponse>(analyticsPath('models', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  // Breaker states; shares its cache with the Reliability page.
  const reliability = useQuery({
    queryKey: ['reliability', projectId, filters],
    queryFn: ({ signal }) =>
      api<ReliabilityResponse>(analyticsPath('reliability', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const noRequests = `No requests reached a model in the last ${filters.range}.`;

  return (
    <>
      <p className="note" role="note">
        These figures compare speed, cost and reliability only. They say nothing about the quality
        of the answers. Percentiles are approximate.
      </p>
      <QueryCard
        title="Latency by deployment"
        what="latency by deployment"
        query={models}
        isEmpty={(data) => routed(data).every((row) => row.metrics.latencyMs.p50 === null)}
        empty={noRequests}
        actions={<span className="muted small">p50 and p95, approximate</span>}
      >
        {(data) => (
          <CategoryBarChart
            label="Latency p50 and p95 per model and deployment"
            data={routed(data)
              .filter((row) => row.metrics.latencyMs.p50 !== null)
              .map((row) => ({
                name: rowName(row),
                p50: row.metrics.latencyMs.p50,
                p95: row.metrics.latencyMs.p95,
              }))}
            bars={[
              { key: 'p50', label: 'p50', color: TONES.accent },
              { key: 'p95', label: 'p95', color: 'var(--chart-2)' },
            ]}
            format={formatLatency}
          />
        )}
      </QueryCard>
      <QueryCard
        title={`Models, last ${filters.range}`}
        what="model statistics"
        query={models}
        isEmpty={(data) => routed(data).length === 0}
        empty={noRequests}
      >
        {(data) => <ComparisonTable rows={routed(data)} />}
      </QueryCard>
      {/* Every configured deployment with its breaker state across gateway instances. */}
      <QueryCard
        title="Deployments"
        what="deployments"
        query={catalog}
        isEmpty={(data) => data.deployments.length === 0}
        empty="The models file configures no deployments."
        actions={
          <a className="card-link" href="#settings">
            Routing in Settings
          </a>
        }
      >
        {(data) => {
          const breakers = reliability.data?.breakers;
          return (
            <>
              <div className="tiles">
                {data.deployments.map((d) => {
                  const instances = breakers?.find((b) => b.deployment === d.id)?.instances;
                  const state = instances ? worstState(instances) : null;
                  return (
                    <div key={d.id} className="tile" role="group" aria-label={d.id}>
                      <div className="tile-head">
                        <span className="tile-title">{d.id}</span>
                        {!d.enabled ? (
                          <span className="badge">disabled</span>
                        ) : state ? (
                          <span className={`badge breaker-${state}`}>{BREAKER_LABELS[state]}</span>
                        ) : null}
                      </div>
                      <DeploymentModel deployment={d} />
                      <dl className="tile-facts">
                        <dt>Breaker</dt>
                        <dd>
                          {!d.enabled
                            ? 'not routed'
                            : reliability.isPending
                              ? 'loading…'
                              : breakers === undefined || breakers === null
                                ? 'unavailable'
                                : instances && instances.length > 0
                                  ? `${formatCount(instances.length)} instance(s) reporting`
                                  : 'never tripped'}
                        </dd>
                        <dt>Uptime</dt>
                        <dd className="muted">not measured</dd>
                      </dl>
                    </div>
                  );
                })}
              </div>
              <p className="muted small card-text">
                Deployments come from the gateway&apos;s models file; a disabled one has no API key
                set. Uptime is not measured: the gateway records breaker changes, not availability
                over time.
              </p>
            </>
          );
        }}
      </QueryCard>
    </>
  );
}
