import { useEffect, useState } from 'react';
import { fetchGatewayStatus, type GatewayStatus } from './gatewayStatus.js';

interface Result {
  status: GatewayStatus;
  checkedAt: Date;
}

const LABELS: Record<GatewayStatus['kind'], string> = {
  ready: 'Ready',
  not_ready: 'Not ready',
  unreachable: 'Unreachable',
};

function StatusBody({ status }: { status: GatewayStatus }) {
  if (status.kind === 'unreachable') {
    return (
      <p className="muted">
        The dashboard could not reach the gateway
        {status.httpStatus === null ? '.' : ` (HTTP ${status.httpStatus}).`} Check that it is
        running.
      </p>
    );
  }
  if (status.checks.length === 0) return <p className="muted">The gateway reported no checks.</p>;
  return (
    <ul className="checks">
      {status.checks.map((check) => (
        <li key={check.name}>
          <span className={check.ok ? 'dot ok' : 'dot fail'} aria-hidden="true" />
          <span className="name">{check.name}</span>
          <span className="muted">
            {check.ok ? 'reachable' : 'failing'}
            {check.latencyMs === null ? '' : ` · ${check.latencyMs} ms`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchGatewayStatus(fetch, controller.signal).then((status) => {
      if (!controller.signal.aborted) setResult({ status, checkedAt: new Date() });
    });
    return () => controller.abort();
  }, [attempt]);

  const refresh = () => {
    setResult(null);
    setAttempt((n) => n + 1);
  };

  return (
    <main>
      <header>
        <h1>AI Gateway</h1>
        <p className="muted">Dashboard pages arrive with the admin API in later milestones.</p>
      </header>

      <section className="card" aria-live="polite" aria-busy={result === null}>
        <div className="card-header">
          <h2>
            Gateway status
            {result && (
              <span className={`badge ${result.status.kind}`}>{LABELS[result.status.kind]}</span>
            )}
          </h2>
          <button type="button" onClick={refresh} disabled={result === null}>
            Refresh
          </button>
        </div>
        {result === null ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <StatusBody status={result.status} />
            <p className="muted small">Checked at {result.checkedAt.toLocaleTimeString()}</p>
          </>
        )}
      </section>
    </main>
  );
}
