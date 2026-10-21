import type { ReactNode } from 'react';
import { ApiError } from '../api.js';

/**
 * A skeleton in the shape of text lines while a query runs. Screen readers get the busy state and
 * a "Loading …" label instead of the shapes.
 */
export function Loading({ what }: { what: string }) {
  return (
    <div className="loading" aria-busy="true">
      <span className="visually-hidden">Loading {what}…</span>
      <span className="skeleton w-90" aria-hidden="true" />
      <span className="skeleton w-75" aria-hidden="true" />
      <span className="skeleton w-50" aria-hidden="true" />
    </div>
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
