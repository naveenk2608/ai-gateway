import type { ReactNode } from 'react';
import { ApiError } from '../api.js';

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
