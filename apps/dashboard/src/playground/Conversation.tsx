import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, ApiError, type ModelCatalog, type RequestDetail } from '../api.js';
import { formatCount, formatLatency, formatUsd, shortId } from '../format.js';
import { ModelLabel, ProviderBadge } from '../ui/ProviderBadge.js';
import { useProviderOf } from '../ui/providers.js';
import type { ReplyTurn, Turn } from './chat.js';
import { describeProblem } from './problems.js';

/** How long to wait for the worker to record a request before saying it is not recorded yet. */
const RECORD_POLLS = 20;
const RECORD_POLL_MS = 1_500;

/** The provider behind a deployment id, from the model catalog; null for one it does not list. */
function useDeploymentProvider() {
  const providerOf = useProviderOf();
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  return (deployment: string) => {
    const kind = catalog.data?.deployments.find((d) => d.id === deployment)?.provider;
    return kind ? providerOf(kind, deployment) : null;
  };
}

type DeploymentProvider = ReturnType<typeof useDeploymentProvider>;

function Deployment({ id, providerOf }: { id: string; providerOf: DeploymentProvider }) {
  const provider = providerOf(id);
  return (
    <span className="pg-deployment">
      {provider && <ProviderBadge provider={provider} />}
      <span className="mono">{id}</span>
    </span>
  );
}

/** A link to the request on the Requests page, in a new tab so the chat stays open. */
function RequestLink({ id }: { id: string }) {
  return (
    <a
      className="pg-request-link mono"
      href={`#requests/${id}`}
      target="_blank"
      rel="noopener"
      title={id}
      aria-label={`Open request ${id} on the Requests page`}
    >
      {shortId(id)}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/**
 * The request's cost as the worker recorded it (priced at the version in effect, ADR 016). The
 * record appears shortly after the reply, so a missing one is asked for again for a while.
 */
function RecordedCost({ requestId }: { requestId: string }) {
  const detail = useQuery({
    queryKey: ['request', requestId],
    queryFn: ({ signal }) => api<RequestDetail>(`/admin/requests/${requestId}`, { signal }),
    retry: (count, error) =>
      error instanceof ApiError && error.status === 404 && count < RECORD_POLLS,
    retryDelay: RECORD_POLL_MS,
  });
  if (detail.isPending) return <span className="muted">being recorded…</span>;
  if (detail.isError) return <span className="muted">not recorded yet</span>;
  const usage = detail.data.usage;
  if (!usage) return <span className="muted">no usage recorded</span>;
  // The worker prices usage only for models with a row in model_prices.
  if (usage.costMicroUsd === null) return <span className="muted">no price for this model</span>;
  return (
    <>
      {formatUsd(usage.costMicroUsd)}
      {usage.source === 'estimated' && <span className="muted"> (estimated tokens)</span>}
    </>
  );
}

/** How the reply was served: model, provider (and any fallback), timing, tokens, cost, request. */
export function ReplyMeta({
  turn,
  providerOf,
}: {
  turn: ReplyTurn;
  providerOf: DeploymentProvider;
}) {
  const served = turn.served;
  const finished = turn.status === 'done' || turn.status === 'stopped';
  const answeredBy = served?.deployment && !served.cacheHit ? providerOf(served.deployment) : null;
  return (
    <dl className="pg-meta" aria-label="Reply details">
      <div>
        <dt>Model</dt>
        <dd className="mono">
          <ModelLabel name={turn.model} family={answeredBy?.family ?? null} />
        </dd>
      </div>
      {served && (
        <div>
          <dt>Served by</dt>
          <dd>
            {served.cacheHit ? (
              'the response cache'
            ) : served.deployment ? (
              <Deployment id={served.deployment} providerOf={providerOf} />
            ) : (
              '—'
            )}
            {served.fallbackFrom.length > 0 && (
              <span className="badge tone-warning pg-fallback">
                fell back from{' '}
                {served.fallbackFrom
                  .map((id) => {
                    const provider = providerOf(id);
                    return provider ? `${provider.name} · ${id}` : id;
                  })
                  .join(', ')}
              </span>
            )}
          </dd>
        </div>
      )}
      {(turn.firstTextMs !== null || turn.totalMs !== null) && (
        <div>
          <dt>Latency</dt>
          <dd className="mono">
            {turn.firstTextMs !== null &&
              `first text ${formatLatency(Math.round(turn.firstTextMs))}`}
            {turn.firstTextMs !== null && turn.totalMs !== null && ' · '}
            {turn.totalMs !== null && `total ${formatLatency(Math.round(turn.totalMs))}`}
          </dd>
        </div>
      )}
      {finished && (
        <div>
          <dt>Tokens</dt>
          <dd className="mono">
            {turn.usage
              ? `${formatCount(turn.usage.promptTokens)} in · ${formatCount(turn.usage.completionTokens)} out`
              : turn.status === 'stopped'
                ? 'not reported (stopped)'
                : 'not reported'}
          </dd>
        </div>
      )}
      {finished && served?.requestId && (
        <div>
          <dt>Cost</dt>
          <dd className="mono">
            <RecordedCost requestId={served.requestId} />
          </dd>
        </div>
      )}
      {served?.requestId && (
        <div>
          <dt>Request</dt>
          <dd>
            <RequestLink id={served.requestId} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function Problem({
  turn,
  last,
  onRetry,
  onRenewKey,
}: {
  turn: ReplyTurn;
  last: boolean;
  onRetry: () => void;
  onRenewKey: () => void;
}) {
  const problem = turn.problem!;
  const { title, detail } = describeProblem(problem, { model: turn.model });
  return (
    <div className="state error pg-problem" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {problem.requestId && (
          <p className="small">
            Request <RequestLink id={problem.requestId} />
          </p>
        )}
      </div>
      {last &&
        (problem.kind === 'auth' ? (
          <button type="button" onClick={onRenewKey}>
            Start a new key
          </button>
        ) : (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        ))}
    </div>
  );
}

function Reply({
  turn,
  last,
  onRetry,
  onRenewKey,
  providerOf,
}: {
  turn: ReplyTurn;
  last: boolean;
  onRetry: () => void;
  onRenewKey: () => void;
  providerOf: DeploymentProvider;
}) {
  return (
    <li className="pg-turn pg-reply">
      {turn.content !== '' && <div className="pg-text">{turn.content}</div>}
      {turn.status === 'waiting' && <span className="muted small">Waiting for the gateway…</span>}
      {turn.status === 'stopped' && <span className="badge">stopped</span>}
      {turn.status === 'done' && turn.finishReason === 'length' && (
        <span className="badge tone-warning">cut off at the output limit</span>
      )}
      {turn.status === 'failed' && turn.problem && (
        <Problem turn={turn} last={last} onRetry={onRetry} onRenewKey={onRenewKey} />
      )}
      {turn.status !== 'waiting' && <ReplyMeta turn={turn} providerOf={providerOf} />}
    </li>
  );
}

export function Conversation({
  turns,
  busy,
  onRetry,
  onRenewKey,
}: {
  turns: Turn[];
  busy: boolean;
  onRetry: () => void;
  onRenewKey: () => void;
}) {
  const providerOf = useDeploymentProvider();
  return (
    // aria-busy holds back announcements while a reply streams in, piece by piece.
    <ol className="pg-turns" role="log" aria-label="Conversation" aria-busy={busy}>
      {turns.map((turn, i) =>
        turn.role === 'user' ? (
          <li key={turn.id} className="pg-turn pg-user">
            <div className="pg-text">{turn.content}</div>
          </li>
        ) : (
          <Reply
            key={turn.id}
            turn={turn}
            last={i === turns.length - 1}
            onRetry={onRetry}
            onRenewKey={onRenewKey}
            providerOf={providerOf}
          />
        ),
      )}
    </ol>
  );
}
