import { useQuery } from '@tanstack/react-query';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type BudgetStatus,
  type CostResponse,
  type Spend,
} from './api.js';
import { TimeSeriesChart } from './charts.js';
import { formatCount, formatPercent, formatUsd } from './format.js';
import { BreakdownTable, QueryCard, Stat } from './ui.js';

const ALERT_TEXT: Record<NonNullable<BudgetStatus['alert']>, string> = {
  ok: 'within budget',
  warning: 'over 80% used',
  exceeded: 'budget used up',
};

function spendRows<T extends Spend>(rows: T[], key: (row: T) => string, name: (row: T) => string) {
  return rows.map((row) => ({
    key: key(row),
    name: name(row),
    value: row.costMicroUsd,
    display: formatUsd(row.costMicroUsd),
    note: `${formatCount(row.requests)} req · ${formatCount(row.totalTokens)} tok`,
  }));
}

export function Cost({ projectId, filters }: { projectId: string; filters: AnalyticsFilters }) {
  const cost = useQuery({
    queryKey: ['cost', projectId, filters],
    queryFn: ({ signal }) =>
      api<CostResponse>(analyticsPath('cost', projectId, filters), { signal }),
  });

  return (
    <>
      <QueryCard
        title={`Spend, last ${filters.range}`}
        what="spend"
        query={cost}
        isEmpty={(data) => data.totals.requests === 0}
        empty={`No requests in the last ${filters.range}, so nothing was spent.`}
      >
        {(data) => (
          <>
            <div className="stats">
              <Stat label="Cost" value={formatUsd(data.totals.costMicroUsd)} />
              <Stat label="Requests" value={formatCount(data.totals.requests)} />
              <Stat label="Prompt tokens" value={formatCount(data.totals.promptTokens)} />
              <Stat label="Completion tokens" value={formatCount(data.totals.completionTokens)} />
            </div>
            <h3>Trend</h3>
            <TimeSeriesChart
              label="Cost per interval"
              data={data.series}
              stepSeconds={data.window.stepSeconds}
              format={formatUsd}
              lines={[{ key: 'costMicroUsd', label: 'Cost', color: 'var(--accent)' }]}
            />
            <div className="grid-2">
              <div>
                <h3>By provider</h3>
                <BreakdownTable
                  label="Provider"
                  rows={spendRows(
                    data.byProvider,
                    (r) => r.provider ?? '',
                    (r) => r.provider ?? 'none (rejected or cached)',
                  )}
                />
              </div>
              <div>
                <h3>By model</h3>
                <BreakdownTable
                  label="Model"
                  rows={spendRows(
                    data.byModel,
                    (r) => r.model,
                    (r) => r.model,
                  )}
                />
              </div>
              <div>
                <h3>By project</h3>
                <BreakdownTable
                  label="Project"
                  rows={spendRows(
                    data.byProject,
                    (r) => r.projectId,
                    (r) => r.projectName,
                  )}
                />
              </div>
              <div>
                <h3>By API key</h3>
                <BreakdownTable
                  label="Key"
                  rows={spendRows(
                    data.byApiKey,
                    (r) => r.apiKeyId ?? '',
                    (r) => r.name ?? 'no key',
                  )}
                />
              </div>
            </div>
          </>
        )}
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Project</th>
                    <th className="num">Spent</th>
                    <th className="num">Budget</th>
                    <th className="num">Used</th>
                    <th>Alert</th>
                  </tr>
                </thead>
                <tbody>
                  {data.budgets.map((b) => (
                    <tr key={b.projectId}>
                      <td>{b.projectName}</td>
                      <td className="num">{formatUsd(b.spentMicroUsd)}</td>
                      <td className="num">
                        {b.budgetMicroUsd === null ? 'none' : formatUsd(b.budgetMicroUsd)}
                      </td>
                      <td className="num">{formatPercent(b.usedShare)}</td>
                      <td>
                        {b.alert === null ? (
                          <span className="muted">no budget</span>
                        ) : (
                          <span className={`badge alert-${b.alert}`}>{ALERT_TEXT[b.alert]}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3>Projected spend this month</h3>
            {data.projection.monthlyCostMicroUsd === null ? (
              <p className="muted">{data.projection.reason}</p>
            ) : (
              <div className="stats">
                <Stat
                  label="Projection"
                  value={formatUsd(data.projection.monthlyCostMicroUsd)}
                  note={`from ${formatCount(data.projection.daysOfData)} days of data`}
                />
              </div>
            )}
          </>
        )}
      </QueryCard>
    </>
  );
}
