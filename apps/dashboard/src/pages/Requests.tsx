import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useState, type FormEvent } from 'react';
import {
  analyticsPath,
  api,
  RANGES,
  type AnalyticsFilters,
  type ApiKey,
  type Range,
  type RequestDetail as Detail,
  type RequestPage,
  type RequestStatus,
  type RequestSummary,
} from '../api.js';
import { formatCount, formatLatency, formatTime, formatUsd } from '../format.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const PAGE_SIZE = 25;
const column = createColumnHelper<RequestSummary>();

const columns = [
  column.accessor('startedAt', { header: 'Started', cell: (c) => formatTime(c.getValue()) }),
  column.accessor('model', { header: 'Model' }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => (
      <span className={`badge status-${c.getValue()}`}>
        {c.getValue()} {c.row.original.httpStatus}
      </span>
    ),
  }),
  column.accessor('errorCode', { header: 'Code', cell: (c) => c.getValue() ?? '' }),
  column.accessor('deployment', {
    header: 'Deployment',
    cell: (c) => (c.row.original.cacheHit ? 'cache' : (c.getValue() ?? '—')),
  }),
  column.accessor('attemptCount', { header: 'Attempts' }),
  column.accessor('latencyMs', { header: 'Latency', cell: (c) => formatLatency(c.getValue()) }),
  column.accessor('totalTokens', { header: 'Tokens', cell: (c) => formatCount(c.getValue()) }),
  column.accessor('costMicroUsd', { header: 'Cost', cell: (c) => formatUsd(c.getValue()) }),
];

function RequestDetail({ requestId, onClose }: { requestId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: ['request', requestId],
    queryFn: ({ signal }) => api<Detail>(`/admin/requests/${requestId}`, { signal }),
  });
  return (
    <section className="card" aria-busy={detail.isPending}>
      <div className="card-header">
        <h2>Request {requestId}</h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {detail.isPending ? (
        <Loading what="the request" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} retry={() => void detail.refetch()} />
      ) : (
        <>
          <p className="muted small">
            {detail.data.stream ? 'Streamed' : 'Not streamed'} ·{' '}
            {formatLatency(detail.data.latencyMs)}
            {detail.data.usage &&
              ` · ${formatCount(detail.data.usage.totalTokens)} tokens (${detail.data.usage.source}) · ${formatUsd(detail.data.usage.costMicroUsd)}`}
          </p>
          <h3>Routing history</h3>
          {detail.data.cacheHit ? (
            <Empty>Answered from the response cache: no provider was called.</Empty>
          ) : detail.data.attempts.length === 0 ? (
            <Empty>Rejected before any provider was called ({detail.data.errorCode}).</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Deployment</th>
                    <th>Outcome</th>
                    <th>Latency</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.data.attempts.map((a) => (
                    <tr key={a.id}>
                      <td>{a.attemptNumber}</td>
                      <td>{a.deployment}</td>
                      <td>
                        {a.outcome}
                        {a.upstreamStatus === null ? '' : ` (${a.upstreamStatus})`}
                      </td>
                      <td>{formatLatency(a.latencyMs)}</td>
                      <td>
                        {a.routingPolicy && <span className="muted">{a.routingPolicy}: </span>}
                        {a.routingReason ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const STATUSES: RequestStatus[] = ['success', 'error', 'canceled', 'rejected'];

/** Range, status, key, model and provider; text fields apply when the form is submitted. */
function RequestFilters({
  projectId,
  filters,
  onChange,
}: {
  projectId: string;
  filters: AnalyticsFilters;
  onChange: (filters: AnalyticsFilters) => void;
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
        Range
        <select
          value={filters.range}
          onChange={(e) => onChange({ ...filters, range: e.target.value as Range })}
        >
          {RANGES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
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

export function Requests({ projectId }: { projectId: string }) {
  const [filters, setFilters] = useState<AnalyticsFilters>({ range: '24h' });
  // Cursors of the pages before this one, so "Newer" can go back.
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: ['requests', projectId, filters, cursor ?? null],
    queryFn: ({ signal }) =>
      api<RequestPage>(
        analyticsPath('requests', projectId, filters, {
          limit: String(PAGE_SIZE),
          cursor,
        }),
        { signal },
      ),
    placeholderData: keepPreviousData,
  });
  const filtered = Object.keys(filters).length > 1;
  // The dashboard is not built with React Compiler, so its memoization caveat does not apply.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: page.data?.data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  return (
    <>
      <section className="card" aria-busy={page.isFetching}>
        <div className="card-header">
          <h2>Requests</h2>
          <button type="button" onClick={() => void page.refetch()} disabled={page.isFetching}>
            Refresh
          </button>
        </div>
        <RequestFilters
          projectId={projectId}
          filters={filters}
          onChange={(next) => {
            setFilters(next);
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
              <table>
                <thead>
                  {table.getHeaderGroups().map((group) => (
                    <tr key={group.id}>
                      {group.headers.map((header) => (
                        <th key={header.id}>
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
                        <td key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pager">
              <button
                type="button"
                disabled={cursors.length === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                Newer
              </button>
              <span className="muted small">Page {cursors.length + 1}</span>
              <button
                type="button"
                disabled={!page.data.nextCursor}
                onClick={() => {
                  const next = page.data.nextCursor;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                Older
              </button>
            </div>
          </>
        )}
      </section>
      {selected && <RequestDetail requestId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
