import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CalendarClock, CircleDollarSign, Coins, Receipt, Wallet } from 'lucide-react';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type BudgetStatus,
  type CostResponse,
  type ModelCatalog,
  type Spend,
  type CostComparisonResponse,
} from '../api.js';
import { BarSeriesChart } from '../charts/BarSeriesChart.js';
import { foldShares } from '../charts/series.js';
import { ShareDonut } from '../charts/ShareDonut.js';
import { Sparkline } from '../charts/Sparkline.js';
import { CATEGORICAL, TONES } from '../charts/theme.js';
import { formatCount, formatPercent, formatStep, formatUsd } from '../format.js';
import { KpiCard, NoTrend } from '../ui/KpiCard.js';
import { Meter } from '../ui/Meter.js';
import { QueryCard } from '../ui/QueryCard.js';
import { ModelLabel, ProviderBadge } from '../ui/ProviderBadge.js';
import { familyOnHost, identifyProvider } from '../ui/providers.js';
import { listCostText } from '../ui/cost.js';
import { ShareTable, type ShareRow } from '../ui/ShareTable.js';
import { ErrorState } from '../ui/states.js';

const ALERT_TEXT: Record<NonNullable<BudgetStatus['alert']>, string> = {
  ok: 'within budget',
  warning: 'over 80% used',
  exceeded: 'budget used up',
};

/** The KPI row's projection card says why there is no projection when the API gives none. */
const NOT_ENOUGH_DATA = 'not enough data';

type Data = CostResponse;

/** Spend rows for a breakdown table: requests and tokens, then cost and its share. */
function spendRows<T extends Spend>(
  rows: T[],
  key: (row: T) => string,
  name: (row: T) => ReactNode,
): ShareRow[] {
  return rows.map((row) => ({
    key: key(row),
    name: name(row),
    cells: [
      formatCount(row.requests),
      formatCount(row.totalTokens),
      row.billedCostMicroUsd === undefined ? '—' : formatUsd(row.billedCostMicroUsd),
    ],
    value: row.costMicroUsd,
    valueText: listCostText(row),
  }));
}

/** Spend, cost per request, tokens and the month's projection for the window. */
function CostKpis({ cost, range }: { cost: UseQueryResult<Data>; range: string }) {
  if (cost.isError) return <ErrorState error={cost.error} retry={() => void cost.refetch()} />;
  const data = cost.data;
  const pending = <span className="skeleton w-75" aria-hidden="true" />;
  const per = data ? `per ${formatStep(data.window.stepSeconds)}` : '';
  const totals = data?.totals;
  const projection = data?.projection;

  return (
    <div className="kpi-row" aria-busy={cost.isPending}>
      {!data && <span className="visually-hidden">Loading spend…</span>}
      <KpiCard
        icon={CircleDollarSign}
        label="List cost"
        value={totals ? listCostText(totals) : pending}
        note={
          totals
            ? `last ${range} at list prices${
                totals.unpricedRequests ? ` · ${formatCount(totals.unpricedRequests)} unpriced` : ''
              }`
            : undefined
        }
        trend={
          data && (
            <Sparkline
              values={data.series.map((p) => p.costMicroUsd)}
              label={`List cost ${per}`}
              format={formatUsd}
            />
          )
        }
      />
      <KpiCard
        icon={Wallet}
        label="Billed"
        value={
          totals
            ? totals.billedCostMicroUsd === undefined
              ? '—'
              : formatUsd(totals.billedCostMicroUsd)
            : pending
        }
        note={
          totals && totals.savedMicroUsd !== undefined
            ? `saved ${formatUsd(totals.savedMicroUsd)}: free tiers bill $0`
            : undefined
        }
        trend={
          data && (
            <Sparkline
              values={data.series.map((p) => p.billedCostMicroUsd ?? p.costMicroUsd)}
              label={`Billed ${per}`}
              format={formatUsd}
            />
          )
        }
      />
      <KpiCard
        icon={Receipt}
        label="Cost per request"
        value={
          totals
            ? totals.requests > 0
              ? formatUsd(Math.round(totals.costMicroUsd / totals.requests))
              : '—'
            : pending
        }
        note={totals ? `average of ${formatCount(totals.requests)} requests` : undefined}
        trend={data && <NoTrend />}
      />
      <KpiCard
        icon={Coins}
        label="Tokens"
        value={totals ? formatCount(totals.totalTokens) : pending}
        note={
          totals
            ? `${formatCount(totals.promptTokens)} in · ${formatCount(totals.completionTokens)} out`
            : undefined
        }
        trend={
          data && (
            <Sparkline values={data.series.map((p) => p.totalTokens)} label={`Tokens ${per}`} />
          )
        }
      />
      <KpiCard
        icon={CalendarClock}
        label="Projected this month"
        value={
          projection
            ? projection.monthlyCostMicroUsd === null
              ? NOT_ENOUGH_DATA
              : formatUsd(projection.monthlyCostMicroUsd)
            : pending
        }
        note={
          projection
            ? (projection.reason ??
              `from ${formatCount(projection.daysOfData)} days of data · UTC month`)
            : undefined
        }
        trend={data && <NoTrend>a projection, not a measurement</NoTrend>}
      />
    </div>
  );
}

/** The range's tokens priced under every priced model, cheapest first (M11). */
function Comparison({ data }: { data: CostComparisonResponse }) {
  return (
    <>
      <p className="muted small card-text">
        {formatCount(data.promptTokens)} prompt and {formatCount(data.completionTokens)} completion
        tokens, which cost {formatUsd(data.actualCostMicroUsd)} at list price with the models used.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th className="num">Per 1M in / out</th>
              <th className="num">Would cost</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={`${m.provider}|${m.model}`}>
                <td>
                  <ProviderBadge provider={identifyProvider({ provider: m.provider })} />
                </td>
                <td>
                  <span className="mono small">{m.model}</span>
                  {m.reference && <span className="badge">reference, never called</span>}
                </td>
                <td className="num">
                  {formatUsd(m.inputMicroUsdPerMTok)} / {formatUsd(m.outputMicroUsdPerMTok)}
                </td>
                <td className="num">{formatUsd(m.costMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small card-text">{data.note}</p>
    </>
  );
}

/** One project's spend this month against its budget, as a meter. */
function BudgetTile({ budget }: { budget: BudgetStatus }) {
  return (
    <div className="tile" aria-label={`Budget of ${budget.projectName}`} role="group">
      <div className="tile-head">
        <span className="tile-title">{budget.projectName}</span>
        {budget.alert !== null && (
          <span className={`badge alert-${budget.alert}`}>{ALERT_TEXT[budget.alert]}</span>
        )}
      </div>
      <div className="tile-value">
        {formatUsd(budget.spentMicroUsd)}
        <span className="muted small">
          {budget.budgetMicroUsd === null ? ' spent' : ` / ${formatUsd(budget.budgetMicroUsd)}`}
        </span>
      </div>
      {budget.usedShare === null ? (
        <p className="muted small">No monthly budget, so nothing to measure against.</p>
      ) : (
        <>
          <Meter
            share={budget.usedShare}
            label={`Budget used by ${budget.projectName}`}
            valueText={formatPercent(budget.usedShare)}
          />
          <div className="tile-foot muted small">
            <span>{budget.period} (UTC)</span>
            <span className="mono">{formatPercent(budget.usedShare)} used</span>
          </div>
        </>
      )}
    </div>
  );
}

const nothingSpent = (data: Data) => data.totals.requests === 0;

/**
 * A model with the provider of its deployment, when it routes to exactly one; a routed model
 * (several deployments) or one missing from the catalog shows its name only.
 */
function ModelName({ model, catalog }: { model: string; catalog: ModelCatalog | undefined }) {
  const targets = catalog?.models.find((m) => m.name === model)?.targets;
  const deployment =
    targets?.length === 1
      ? catalog?.deployments.find((d) => d.id === targets[0]?.deployment)
      : undefined;
  if (!deployment) return model;
  const provider = identifyProvider({
    provider: deployment.provider,
    deployment: deployment.id,
    model: deployment.providerModel,
  });
  return (
    <span className="deployment-cell">
      <ProviderBadge provider={provider} />
      <ModelLabel name={model} family={familyOnHost(provider, deployment.providerModel)} />
    </span>
  );
}

export function Cost({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  // Which deployment each model routes to; shared with the Models and Settings pages.
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  const cost = useQuery({
    queryKey: ['cost', projectId, filters],
    queryFn: ({ signal }) =>
      api<CostResponse>(analyticsPath('cost', projectId, filters), { signal }),
    refetchInterval: 30_000,
  });
  const comparison = useQuery({
    queryKey: ['cost-comparison', projectId, filters],
    queryFn: ({ signal }) =>
      api<CostComparisonResponse>(analyticsPath('cost-comparison', projectId, filters), {
        signal,
      }),
    refetchInterval: 60_000,
  });
  const noSpend = `No requests in the last ${filters.range}, so nothing was spent.`;
  const breakdown = (
    title: string,
    label: string,
    rows: (data: Data) => ShareRow[],
    empty: string,
  ) => (
    <QueryCard
      title={title}
      what={title.toLowerCase()}
      query={cost}
      isEmpty={(data) => nothingSpent(data) || rows(data).length === 0}
      empty={cost.data && !nothingSpent(cost.data) ? empty : noSpend}
    >
      {(data) => (
        <ShareTable
          label={label}
          columns={['Requests', 'Tokens', 'Billed']}
          valueLabel="List cost"
          rows={rows(data)}
          total={data.totals.costMicroUsd}
          format={formatUsd}
        />
      )}
    </QueryCard>
  );

  return (
    <>
      <CostKpis cost={cost} range={filters.range} />
      <div className="split">
        <QueryCard
          title="Cost trend"
          what="the cost trend"
          query={cost}
          isEmpty={nothingSpent}
          empty={noSpend}
          actions={
            cost.data && (
              <span className="muted small">per {formatStep(cost.data.window.stepSeconds)}</span>
            )
          }
        >
          {(data) => (
            <BarSeriesChart
              label="Cost per interval"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              format={formatUsd}
              bar={{ key: 'costMicroUsd', label: 'Cost', color: TONES.accent }}
            />
          )}
        </QueryCard>
        <QueryCard
          title="Cost by model"
          what="cost by model"
          query={cost}
          isEmpty={(data) => nothingSpent(data) || data.totals.costMicroUsd === 0}
          empty={
            cost.data && !nothingSpent(cost.data)
              ? 'Nothing was spent: every model used is free or has no price.'
              : noSpend
          }
        >
          {(data) => (
            <ShareDonut
              label="Share of spend by model"
              shares={foldShares(
                data.byModel.map((m) => ({ key: m.model, label: m.model, value: m.costMicroUsd })),
                data.totals.costMicroUsd,
                CATEGORICAL.length,
              )}
              total={data.totals.costMicroUsd}
              format={formatUsd}
              centerLabel={`last ${filters.range}`}
            />
          )}
        </QueryCard>
      </div>
      <div className="card-grid">
        {breakdown(
          'By project',
          'Project',
          (data) =>
            spendRows(
              data.byProject,
              (r) => r.projectId,
              (r) => r.projectName,
            ),
          'No project spent anything.',
        )}
        {breakdown(
          'By API key',
          'Key',
          (data) =>
            spendRows(
              data.byApiKey,
              (r) => r.apiKeyId ?? '',
              (r) => r.name ?? 'no key',
            ),
          'No key spent anything.',
        )}
        {breakdown(
          'By provider',
          'Provider',
          (data) =>
            spendRows(
              data.byProvider,
              (r) => r.provider ?? '',
              (r) =>
                r.provider ? (
                  <ProviderBadge provider={identifyProvider({ provider: r.provider })} />
                ) : (
                  'none (rejected or cached)'
                ),
            ),
          'No provider was called.',
        )}
        {breakdown(
          'By model',
          'Model',
          (data) =>
            spendRows(
              data.byModel,
              (r) => r.model,
              (r) => <ModelName model={r.model} catalog={catalog.data} />,
            ),
          'No model was called.',
        )}
      </div>
      <QueryCard
        title="What it would cost elsewhere"
        what="the cost comparison"
        query={comparison}
        isEmpty={(data) =>
          data.promptTokens + data.completionTokens === 0 || data.models.length === 0
        }
        empty={`No tokens in the last ${filters.range} to compare.`}
      >
        {(data) => <Comparison data={data} />}
      </QueryCard>
      <QueryCard
        title="Budgets this month (UTC)"
        what="budgets"
        query={cost}
        isEmpty={(data) => data.budgets.length === 0}
        empty="No projects to show."
      >
        {(data) => (
          <>
            <div className="tiles">
              {data.budgets.map((b) => (
                <BudgetTile key={b.projectId} budget={b} />
              ))}
            </div>
            <p className="muted small card-text">
              Budgets cover the whole UTC month and ignore the time range above. Requests are
              refused once a project&apos;s budget is used up.
            </p>
          </>
        )}
      </QueryCard>
    </>
  );
}
