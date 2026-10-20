import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from './api.js';

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" aria-busy="true">
      Loading {what}…
    </p>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message =
    error instanceof ApiError ? error.message : 'Something went wrong while loading this page.';
  return (
    <div className="state error" role="alert">
      <p>{message}</p>
      {retry && (
        <button type="button" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state empty">{children}</div>;
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

/**
 * A card for one query: loading while it runs, the error with a retry if it fails, `empty` when
 * the data holds nothing, else the content. Every analytics view goes through it, so each has all
 * three states.
 */
export function QueryCard<T>({
  title,
  what,
  query,
  isEmpty,
  empty,
  actions,
  children,
}: {
  title: ReactNode;
  what: string;
  query: UseQueryResult<T>;
  isEmpty: (data: T) => boolean;
  empty: ReactNode;
  actions?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="card" aria-busy={query.isFetching}>
      <div className="card-header">
        <h2>{title}</h2>
        {actions}
      </div>
      {query.isPending ? (
        <Loading what={what} />
      ) : query.isError ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : isEmpty(query.data) ? (
        <Empty>{empty}</Empty>
      ) : (
        children(query.data)
      )}
    </section>
  );
}

/** Rows with a bar showing each value's share of the largest. */
export function BreakdownTable({
  label,
  rows,
}: {
  label: string;
  rows: { key: string; name: string; value: number; display: string; note?: string }[];
}) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <div className="table-wrap">
      <table className="breakdown">
        <thead>
          <tr>
            <th>{label}</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <div>{row.name}</div>
                <div
                  className="bar"
                  style={{ width: max > 0 ? `${(row.value / max) * 100}%` : '0%' }}
                />
              </td>
              <td className="num">
                {row.display}
                {row.note && <div className="muted small">{row.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
