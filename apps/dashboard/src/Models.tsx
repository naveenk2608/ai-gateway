import { useQuery } from '@tanstack/react-query';
import { analyticsPath, api, type AnalyticsFilters, type ModelsResponse } from './api.js';
import { formatCount, formatLatency, formatPercent, formatUsd } from './format.js';
import { QueryCard } from './ui.js';

export function Models({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const models = useQuery({
    queryKey: ['models', projectId, filters],
    queryFn: ({ signal }) =>
      api<ModelsResponse>(analyticsPath('models', projectId, filters), { signal }),
  });

  return (
    <QueryCard
      title={`Models, last ${filters.range}`}
      what="model statistics"
      query={models}
      // Rows without a deployment never reached a provider: nothing to compare.
      isEmpty={(data) => data.data.every((row) => row.deployment === null)}
      empty={`No requests reached a model in the last ${filters.range}.`}
    >
      {(data) => (
        <>
          <p className="note" role="note">
            These figures compare speed, cost and reliability only. They say nothing about the
            quality of the answers. Percentiles are approximate.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Deployment</th>
                  <th className="num">Requests</th>
                  <th className="num">Latency p50 / p95</th>
                  <th className="num">TTFT p50 / p95</th>
                  <th className="num">Tokens/s</th>
                  <th className="num">Cost</th>
                  <th className="num">Cost / request</th>
                  <th className="num">Failure rate</th>
                  <th className="num">Fallbacks / request</th>
                </tr>
              </thead>
              <tbody>
                {data.data
                  .filter((row) => row.deployment !== null)
                  .map(({ model, deployment, provider, metrics: m }) => {
                    const admitted = m.requests - m.rejected;
                    return (
                      <tr key={`${model}|${deployment}`}>
                        <td>{model}</td>
                        <td>
                          {deployment}
                          {provider && <div className="muted small">{provider}</div>}
                        </td>
                        <td className="num">{formatCount(m.requests)}</td>
                        <td className="num">
                          {formatLatency(m.latencyMs.p50)} / {formatLatency(m.latencyMs.p95)}
                        </td>
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
                        <td className="num">
                          {m.fallbackRate === null ? '—' : m.fallbackRate.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </QueryCard>
  );
}
