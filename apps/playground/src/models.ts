import { useCallback, useEffect, useState } from 'react';
import { SLOW_AFTER_MS } from './chat.js';
import { GatewayProblem, listModels, type Connection } from './gateway.js';

export type ModelList =
  | { status: 'idle' }
  | { status: 'loading'; slow: boolean }
  | { status: 'ready'; models: string[] }
  | { status: 'failed'; problem: GatewayProblem };

type Outcome = Extract<ModelList, { status: 'ready' | 'failed' }>;

/** One load: for which connection, and which reload of it. */
interface Load {
  connection: Connection;
  attempt: number;
}

const same = (load: Load | null, connection: Connection, attempt: number) =>
  load !== null && load.connection === connection && load.attempt === attempt;

/**
 * The key's models from GET /v1/models, loaded whenever the connection changes. Idle and loading
 * are derived from which load the last answer belongs to, so a stale answer is never shown.
 */
export function useModels(connection: Connection | null): ModelList & { reload: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<(Load & { outcome: Outcome }) | null>(null);
  const [slow, setSlow] = useState<Load | null>(null);

  useEffect(() => {
    if (!connection) return;
    const load = { connection, attempt };
    const controller = new AbortController();
    const timer = setTimeout(() => setSlow(load), SLOW_AFTER_MS);
    listModels(connection, controller.signal)
      .then(
        (models) => setAnswer({ ...load, outcome: { status: 'ready', models } }),
        (err: unknown) => {
          if (controller.signal.aborted) return;
          const problem =
            err instanceof GatewayProblem
              ? err
              : new GatewayProblem('server', 'The model list could not be read.');
          setAnswer({ ...load, outcome: { status: 'failed', problem } });
        },
      )
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [connection, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const state: ModelList = !connection
    ? { status: 'idle' }
    : answer && same(answer, connection, attempt)
      ? answer.outcome
      : { status: 'loading', slow: same(slow, connection, attempt) };
  return { ...state, reload };
}
