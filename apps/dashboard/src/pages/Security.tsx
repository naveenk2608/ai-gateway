import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Ban, Gauge, KeyRound, ShieldAlert, Wallet } from 'lucide-react';
import { analyticsPath, api, type AnalyticsFilters, type SecurityResponse } from '../api.js';
import { BarSeriesChart } from '../charts/BarSeriesChart.js';
import { Sparkline } from '../charts/Sparkline.js';
import { TONES } from '../charts/theme.js';
import { formatCount, formatStep } from '../format.js';
import { KpiCard, NoTrend } from '../ui/KpiCard.js';
import { QueryCard } from '../ui/QueryCard.js';
import { ShareTable, type ShareRow } from '../ui/ShareTable.js';
import { ErrorState } from '../ui/states.js';

const CATEGORY_LABELS: Record<string, string> = {
  rate_limit: 'Rate limit',
  token_limit: 'Token quota',
  concurrency: 'Concurrency',
  budget: 'Budget',
  policy: 'Model policy',
  limits_unavailable: 'Limits unavailable',
  other: 'Other',
};

/** Categories the "Limits" card adds up: the per-minute and concurrency limits. */
const LIMIT_CATEGORIES = new Set(['rate_limit', 'token_limit', 'concurrency']);

type Data = SecurityResponse;

const categoryLabel = (category: string) => CATEGORY_LABELS[category] ?? category;

function inCategories(data: Data, match: (category: string) => boolean): number {
  return data.byCategory.filter((c) => match(c.category)).reduce((sum, c) => sum + c.requests, 0);
}

function SecurityKpis({ query, range }: { query: UseQueryResult<Data>; range: string }) {
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const data = query.data;
  const pending = <span className="skeleton w-75" aria-hidden="true" />;
  const count = (match: (category: string) => boolean) =>
    data ? formatCount(inCategories(data, match)) : pending;

  return (
    <div className="kpi-row" aria-busy={query.isPending}>
      {!data && <span className="visually-hidden">Loading rejections…</span>}
      <KpiCard
        icon={ShieldAlert}
        label="Rejected"
        value={data ? formatCount(data.rejected) : pending}
        note={data ? `last ${range}` : undefined}
        trend={
          data && (
            <Sparkline
              values={data.series.map((p) => p.rejected)}
              label={`Rejected per ${formatStep(data.window.stepSeconds)}`}
            />
          )
        }
      />
      <KpiCard
        icon={Gauge}
        label="Rate, token and concurrency limits"
        value={count((c) => LIMIT_CATEGORIES.has(c))}
        trend={data && <NoTrend />}
      />
      <KpiCard
        icon={Wallet}
        label="Budget"
        value={count((c) => c === 'budget')}
        trend={data && <NoTrend />}
      />
      <KpiCard
        icon={Ban}
        label="Model policy"
        value={count((c) => c === 'policy')}
        trend={data && <NoTrend />}
      />
      <KpiCard
        icon={KeyRound}
        label="Invalid API keys"
        value={data ? 'not counted' : pending}
        note={data?.invalidApiKeys.reason}
        trend={data && <NoTrend>not attributed to a project</NoTrend>}
      />
    </div>
  );
}

export function Security({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const security = useQuery({
    queryKey: ['security', projectId, filters],
    queryFn: ({ signal }) =>
      api<SecurityResponse>(analyticsPath('security', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const noneRejected = (data: Data) => data.rejected === 0;
  const empty = `No requests were rejected in the last ${filters.range}.`;
  const shares = (title: string, label: string, rows: (data: Data) => ShareRow[]) => (
    <QueryCard
      title={title}
      what={title.toLowerCase()}
      query={security}
      isEmpty={noneRejected}
      empty={empty}
    >
      {(data) => (
        <ShareTable
          label={label}
          columns={[]}
          valueLabel="Rejected"
          rows={rows(data)}
          total={data.rejected}
          format={formatCount}
        />
      )}
    </QueryCard>
  );

  return (
    <>
      <SecurityKpis query={security} range={filters.range} />
      <div className="split">
        <QueryCard
          title="Rejections over time"
          what="rejections"
          query={security}
          isEmpty={noneRejected}
          empty={empty}
          actions={
            security.data && (
              <span className="muted small">
                per {formatStep(security.data.window.stepSeconds)}
              </span>
            )
          }
        >
          {(data) => (
            <BarSeriesChart
              label="Rejections per interval"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              bar={{ key: 'rejected', label: 'Rejected', color: TONES.warning }}
            />
          )}
        </QueryCard>
        {shares('By category', 'Category', (data) =>
          data.byCategory
            .filter((c) => c.requests > 0)
            .map((c) => ({
              key: c.category,
              name: categoryLabel(c.category),
              cells: [],
              value: c.requests,
            })),
        )}
      </div>
      <div className="card-grid">
        {shares('By reason', 'Code', (data) =>
          data.byCode.map((c) => ({
            key: c.errorCode ?? '',
            name: (
              <>
                <span className="mono">{c.errorCode ?? 'unknown'}</span>
                <span className="muted small block">{categoryLabel(c.category)}</span>
              </>
            ),
            cells: [],
            value: c.requests,
          })),
        )}
        {shares('By API key', 'Key', (data) =>
          data.byApiKey.map((k) => ({
            key: k.apiKeyId ?? '',
            name: k.name ?? 'no key',
            cells: [],
            value: k.requests,
          })),
        )}
      </div>
    </>
  );
}
