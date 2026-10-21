import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Empty, ErrorState, Loading } from './states.js';

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
