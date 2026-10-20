import { useQuery } from '@tanstack/react-query';
import { analyticsPath, api, type AnalyticsFilters, type SecurityResponse } from './api.js';
import { TimeSeriesChart } from './charts.js';
import { formatCount } from './format.js';
import { BreakdownTable, QueryCard, Stat } from './ui.js';

const CATEGORY_LABELS: Record<string, string> = {
  rate_limit: 'Rate limit',
  token_limit: 'Token quota',
  concurrency: 'Concurrency',
  budget: 'Budget',
  policy: 'Model policy',
  limits_unavailable: 'Limits unavailable',
  other: 'Other',
};

export function Security({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const security = useQuery({
    queryKey: ['security', projectId, filters],
    queryFn: ({ signal }) =>
      api<SecurityResponse>(analyticsPath('security', projectId, filters), { signal }),
  });

  return (
    <QueryCard
      title={`Rejected requests, last ${filters.range}`}
      what="rejections"
      query={security}
      isEmpty={(data) => data.rejected === 0}
      empty={`No requests were rejected in the last ${filters.range}.`}
    >
      {(data) => (
        <>
          <div className="stats">
            <Stat label="Rejected" value={formatCount(data.rejected)} />
            {data.byCategory.map((c) => (
              <Stat
                key={c.category}
                label={CATEGORY_LABELS[c.category] ?? c.category}
                value={formatCount(c.requests)}
              />
            ))}
            <Stat label="Invalid API keys" value="not counted" note={data.invalidApiKeys.reason} />
          </div>
          <TimeSeriesChart
            label="Rejections per interval"
            data={data.series}
            stepSeconds={data.window.stepSeconds}
            lines={[{ key: 'rejected', label: 'Rejected', color: 'var(--warn)' }]}
          />
          <div className="grid-2">
            <div>
              <h3>By reason</h3>
              <BreakdownTable
                label="Code"
                rows={data.byCode.map((c) => ({
                  key: c.errorCode ?? '',
                  name: c.errorCode ?? 'unknown',
                  value: c.requests,
                  display: formatCount(c.requests),
                  note: CATEGORY_LABELS[c.category] ?? c.category,
                }))}
              />
            </div>
            <div>
              <h3>By API key</h3>
              <BreakdownTable
                label="Key"
                rows={data.byApiKey.map((k) => ({
                  key: k.apiKeyId ?? '',
                  name: k.name ?? 'no key',
                  value: k.requests,
                  display: formatCount(k.requests),
                }))}
              />
            </div>
          </div>
        </>
      )}
    </QueryCard>
  );
}
