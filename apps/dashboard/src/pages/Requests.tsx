import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import {
  analyticsPath,
  api,
  type AnalyticsFilters,
  type ApiKey,
  type Attempt,
  type Range,
  type RequestDetail as Detail,
  type RequestPage,
  type RequestStatus,
} from '../api.js';
import {
  formatCount,
  formatLatency,
  formatShortTime,
  formatTime,
  formatUsd,
  shortId,
} from '../format.js';
import { Drawer } from '../ui/Drawer.js';
import { ModelLabel, ProviderBadge } from '../ui/ProviderBadge.js';
import { useProviderOf, type ModelFamily, type ProviderInfo } from '../ui/providers.js';
import { Stat } from '../ui/Stat.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const PAGE_SIZE = 25;

type Row = RequestPage['data'][number];
const column = createColumnHelper<Row>();

/** The filters this page sets itself; the range comes from the top bar. */
type PageFilters = Omit<AnalyticsFilters, 'range'>;

/** Columns whose cells are numbers: right-aligned, in the monospace face. */
const NUMERIC = new Set(['attemptCount', 'latencyMs', 'totalTokens', 'costMicroUsd']);

/** A request's latency, with a bar scaled to the slowest request on the page. */
function LatencyCell({ ms, slowest }: { ms: number; slowest: number }) {
  return (
    <div className="latency-cell">
      <span>{formatLatency(ms)}</span>
      <span className="latency-track" aria-hidden="true">
        <span style={{ width: `${slowest > 0 ? (ms / slowest) * 100 : 0}%` }} />
      </span>
    </div>
  );
}

type ProviderOf = (
  provider: string,
  deployment?: string | null,
) => ProviderInfo & { family: ModelFamily | null };

function requestColumns(slowest: number, open: (id: string) => void, providerOf: ProviderOf) {
  return [
    column.accessor('startedAt', { header: 'Time', cell: (c) => formatShortTime(c.getValue()) }),
    column.accessor('id', {
      header: 'Request',
      cell: (c) => (
        <button
          type="button"
          className="link-button"
          title={c.getValue()}
          onClick={(event) => {
            event.stopPropagation();
            open(c.getValue());
          }}
        >
          {shortId(c.getValue())}
        </button>
      ),
    }),
    column.accessor('model', {
      header: 'Model',
      cell: (c) => {
        const { provider, deployment } = c.row.original;
        const family = deployment ? providerOf(provider ?? '', deployment).family : null;
        return <ModelLabel name={c.getValue()} family={family} />;
      },
    }),
    column.accessor('deployment', {
      header: 'Deployment',
      cell: (c) => {
        const deployment = c.getValue();
        if (c.row.original.cacheHit) return <span className="badge tone-accent">cache</span>;
        if (!deployment) return '—';
        return (
          <div className="deployment-cell">
            <ProviderBadge provider={providerOf(c.row.original.provider ?? '', deployment)} />
            <span>{deployment}</span>
          </div>
        );
      },
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (c) => (
        <span className={`badge status-${c.getValue()}`}>
          {c.row.original.httpStatus} {c.getValue()}
        </span>
      ),
    }),
    column.accessor('errorCode', {
      header: 'Code',
      cell: (c) => <span className="mono">{c.getValue() ?? ''}</span>,
    }),
    column.accessor('attemptCount', { header: 'Attempts' }),
    column.accessor('latencyMs', {
      header: 'Latency',
      cell: (c) => <LatencyCell ms={c.getValue()} slowest={slowest} />,
    }),
    column.accessor('totalTokens', { header: 'Tokens', cell: (c) => formatCount(c.getValue()) }),
    column.accessor('costMicroUsd', { header: 'Cost', cell: (c) => formatUsd(c.getValue()) }),
  ];
}

/** `success` reads as success and `canceled` as neutral; any other outcome is a failure code. */
function outcomeTone(outcome: string): string {
  return outcome === 'success' ? 'tone-success' : outcome === 'canceled' ? '' : 'tone-danger';
}

/** Each attempt's time as a share of the whole request, with its first token when streamed. */
function AttemptTimings({
  attempts,
  total,
  providerOf,
}: {
  attempts: Attempt[];
  total: number;
  providerOf: ProviderOf;
}) {
  return (
    <>
      <h3>Attempt timings</h3>
      <ol className="attempts">
        {attempts.map((a) => (
          <li key={a.id}>
            <div className="attempt-head">
              <span className="attempt-number">#{a.attemptNumber}</span>
              <span className="attempt-name">{a.deployment}</span>
              <ProviderBadge provider={providerOf(a.provider, a.deployment)} />
              <span className={`badge ${outcomeTone(a.outcome)}`}>
                {a.outcome}
                {a.upstreamStatus === null ? '' : ` ${a.upstreamStatus}`}
              </span>
            </div>
            <div className="attempt-track" aria-hidden="true">
              <span
                style={{ width: `${total > 0 ? Math.min(a.latencyMs / total, 1) * 100 : 0}%` }}
              />
            </div>
            <div className="attempt-times">
              {formatLatency(a.latencyMs)}
              {a.ttftMs !== null && ` · first token ${formatLatency(a.ttftMs)}`}
            </div>
          </li>
        ))}
      </ol>
      <p className="muted small">Bars are each attempt's share of the request's total latency.</p>
    </>
  );
}

/** The routing decisions in order: which deployment, by which policy, and why. */
function RoutingHistory({ detail, providerOf }: { detail: Detail; providerOf: ProviderOf }) {
  return (
    <>
      <h3>Routing history</h3>
      {detail.cacheHit ? (
        <Empty>Answered from the response cache: no provider was called.</Empty>
      ) : detail.attempts.length === 0 ? (
        <Empty>Rejected before any provider was called ({detail.errorCode}).</Empty>
      ) : (
        <ol className="routing">
          {detail.attempts.map((a) => (
            <li key={a.id}>
              <span className="routing-step" aria-hidden="true">
                {a.attemptNumber}
              </span>
              <div className="routing-text">
                <div>
                  <span className="attempt-name">{a.deployment}</span>{' '}
                  <span className="muted small">via</span>{' '}
                  <ProviderBadge provider={providerOf(a.provider, a.deployment)} />
                </div>
                <div className="muted small">
                  {a.routingPolicy && <span className="mono">{a.routingPolicy}: </span>}
                  {a.routingReason ?? 'no reason recorded'}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function firstToken(detail: Detail): { value: string; note: string } {
  if (!detail.stream) return { value: '—', note: 'not streamed' };
  if (detail.ttftMs === null) return { value: '—', note: 'no token was streamed' };
  return { value: formatLatency(detail.ttftMs), note: 'time to first token' };
}

function RequestFacts({ detail, providerOf }: { detail: Detail; providerOf: ProviderOf }) {
  const usage = detail.usage;
  // The request's deployment is the one its last attempt used; attempts carry the provider.
  const served = detail.attempts.findLast((a) => a.deployment === detail.deployment);
  const ttft = firstToken(detail);
  return (
    <>
      <div className="panel-status">
        <span className={`badge status-${detail.status}`}>
          {detail.httpStatus} {detail.status}
        </span>
        {detail.errorCode && <span className="mono small">{detail.errorCode}</span>}
        {detail.cacheHit && <span className="badge tone-accent">cache hit</span>}
      </div>
      <dl className="facts">
        <dt>Model</dt>
        <dd>
          <ModelLabel
            name={detail.model}
            family={served ? providerOf(served.provider, served.deployment).family : null}
          />
        </dd>
        <dt>Deployment</dt>
        <dd>
          {detail.deployment ? (
            <span className="deployment-cell">
              {served && (
                <ProviderBadge provider={providerOf(served.provider, served.deployment)} />
              )}
              <span>{detail.deployment}</span>
            </span>
          ) : (
            '—'
          )}
        </dd>
        <dt>Started</dt>
        <dd>{formatTime(detail.startedAt)}</dd>
        <dt>Completed</dt>
        <dd>{formatTime(detail.completedAt)}</dd>
        <dt>Tokens</dt>
        <dd>
          {usage
            ? `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out (${usage.source})`
            : '—'}
        </dd>
        <dt>Cost</dt>
        <dd>{formatUsd(usage?.costMicroUsd ?? null)}</dd>
      </dl>
      <div className="stats">
        <Stat label="Total latency" value={formatLatency(detail.latencyMs)} />
        <Stat label="First token" value={ttft.value} note={ttft.note} />
      </div>
      {!detail.cacheHit && detail.attempts.length > 0 && (
        <AttemptTimings
          attempts={detail.attempts}
          total={detail.latencyMs}
          providerOf={providerOf}
        />
      )}
      <RoutingHistory detail={detail} providerOf={providerOf} />
    </>
  );
}

/** The selected request in a panel from the right: what happened, how long, and where it went. */
function RequestPanel({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const providerOf = useProviderOf();
  const detail = useQuery({
    queryKey: ['request', requestId],
    queryFn: ({ signal }) => api<Detail>(`/admin/requests/${requestId}`, { signal }),
  });
  return (
    <Drawer open onClose={onClose} side="right" label="Request detail" className="side-panel">
      <div className="drawer-header">
        <div className="side-panel-title">
          <h2>Request detail</h2>
          <span className="mono muted small">{requestId}</span>
        </div>
        <button
          type="button"
          className="ghost icon-button"
          aria-label="Close request detail"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="side-panel-body" aria-busy={detail.isPending}>
        {detail.isPending ? (
          <Loading what="the request" />
        ) : detail.isError ? (
          <ErrorState error={detail.error} retry={() => void detail.refetch()} />
        ) : (
          <RequestFacts detail={detail.data} providerOf={providerOf} />
        )}
      </div>
    </Drawer>
  );
}

const STATUSES: RequestStatus[] = ['success', 'error', 'canceled', 'rejected'];

/** Status, key, model and provider; text fields apply when the form is submitted. */
function RequestFilters({
  projectId,
  filters,
  onChange,
}: {
  projectId: string;
  filters: PageFilters;
  onChange: (filters: PageFilters) => void;
}) {
  const keys = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: ({ signal }) =>
      api<{ data: ApiKey[] }>(`/admin/projects/${projectId}/api-keys`, { signal }),
  });
  const [model, setModel] = useState(filters.model ?? '');
  const [provider, setProvider] = useState(filters.provider ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({
      ...filters,
      model: model.trim() || undefined,
      provider: provider.trim() || undefined,
    });
  };
  return (
    <form className="filters" onSubmit={submit} aria-label="Filters">
      <label>
        Status
        <select
          value={filters.status ?? ''}
          onChange={(e) =>
            onChange({ ...filters, status: (e.target.value || undefined) as RequestStatus })
          }
        >
          <option value="">any</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label>
        API key
        <select
          value={filters.apiKeyId ?? ''}
          onChange={(e) => onChange({ ...filters, apiKeyId: e.target.value || undefined })}
        >
          <option value="">any</option>
          {keys.data?.data.map((key) => (
            <option key={key.id} value={key.id}>
              {key.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="any" />
      </label>
      <label>
        Provider
        <input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="any" />
      </label>
      <button type="submit">Apply</button>
    </form>
  );
}

export function Requests({
  projectId,
  filters,
  requestId = null,
}: {
  projectId: string;
  filters: AnalyticsFilters;
  /** A request to open at once, from a link (`#requests/<id>`). */
  requestId?: string | null;
}) {
  const [own, setOwn] = useState<PageFilters>({});
  // Cursors of the pages before this one, so "Newer" can go back. They belong to one range: a new
  // range from the top bar starts again from the first page.
  const [paging, setPaging] = useState<{ range: Range; cursors: string[] }>({
    range: filters.range,
    cursors: [],
  });
  const cursors = paging.range === filters.range ? paging.cursors : [];
  const setCursors = (next: string[]) => setPaging({ range: filters.range, cursors: next });
  const [selected, setSelected] = useState<string | null>(requestId);
  const query: AnalyticsFilters = { ...filters, ...own };
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: ['requests', projectId, query, cursor ?? null],
    queryFn: ({ signal }) =>
      api<RequestPage>(
        analyticsPath('requests', projectId, query, {
          limit: String(PAGE_SIZE),
          cursor,
        }),
        { signal },
      ),
    placeholderData: keepPreviousData,
  });
  const filtered = Object.values(own).some((value) => value !== undefined);
  const rows = page.data?.data;
  const slowest = Math.max(0, ...(rows ?? []).map((r) => r.latencyMs));
  const providerOf = useProviderOf();
  const columns = useMemo(
    () => requestColumns(slowest, setSelected, providerOf),
    [slowest, providerOf],
  );
  // The dashboard is not built with React Compiler, so its memoization caveat does not apply.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <>
      <section className="card" aria-busy={page.isFetching}>
        <div className="card-header">
          <h2>Request log</h2>
          <button type="button" onClick={() => void page.refetch()} disabled={page.isFetching}>
            Refresh
          </button>
        </div>
        <RequestFilters
          projectId={projectId}
          filters={own}
          onChange={(next) => {
            setOwn(next);
            setCursors([]);
          }}
        />
        {page.isPending ? (
          <Loading what="requests" />
        ) : page.isError ? (
          <ErrorState error={page.error} retry={() => void page.refetch()} />
        ) : page.data.data.length === 0 ? (
          <Empty>
            {filtered
              ? `No requests in the last ${filters.range} match these filters.`
              : `No requests in the last ${filters.range}. They appear here once the worker has recorded them.`}
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="dense">
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th key={header.id} className={NUMERIC.has(header.id) ? 'num' : undefined}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.id === selected ? 'clickable selected' : 'clickable'}
                      onClick={() => setSelected(row.id)}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className={NUMERIC.has(cell.column.id) ? 'num' : undefined}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <span className="muted small pager-note">
                Latency bars are relative to the slowest request on this page.
              </span>
              <button
                type="button"
                disabled={cursors.length === 0}
                onClick={() => setCursors(cursors.slice(0, -1))}
              >
                Newer
              </button>
              <span className="muted small">Page {cursors.length + 1}</span>
              <button
                type="button"
                disabled={!page.data.nextCursor}
                onClick={() => {
                  const next = page.data.nextCursor;
                  if (next) setCursors([...cursors, next]);
                }}
              >
                Older
              </button>
            </div>
          </>
        )}
      </section>
      {selected && (
        <RequestPanel
          requestId={selected}
          onClose={() => {
            setSelected(null);
            // Leave the link's address, so following it again opens the request again.
            if (requestId) window.location.hash = 'requests';
          }}
        />
      )}
    </>
  );
}
