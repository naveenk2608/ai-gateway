import { Copy, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import type { ReplyTurn, Turn } from '../chat.js';
import { formatCount, formatMs, shortId } from '../format.js';
import { describeProblem } from '../problems.js';
import { LogoMark } from '../../../dashboard/src/ui/logos/logos.js';
import { providerName, servedBy } from '../providers.js';
import { WakingHint } from './SettingsPanel.js';

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost pg-copy"
      title={id}
      aria-label={`Copy request ID ${id}`}
      onClick={() =>
        void navigator.clipboard.writeText(id).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      <span className="mono">{shortId(id)}</span>
      <Copy size={12} aria-hidden="true" />
      {copied && <span className="visually-hidden">copied</span>}
    </button>
  );
}

/** A deployment as "Groq · groq-gpt-oss-20b". */
const deploymentLabel = (deployment: string) => {
  const name = providerName(deployment);
  return name === deployment ? deployment : `${name} · ${deployment}`;
};

/** How the reply was served: model, provider (and any fallback), timing, tokens, request ID. */
export function ReplyMeta({ turn }: { turn: ReplyTurn }) {
  const served = turn.served;
  const finished = turn.status === 'done' || turn.status === 'stopped';
  // The provider's logo (a neutral icon for the mock; none for an unknown id) and the model's
  // family when it is not the provider's own.
  const by = served?.deployment && !served.cacheHit ? servedBy(served.deployment) : null;
  const provider = by?.known ? by : null;
  const family = by?.family ?? null;
  return (
    <dl className="pg-meta" aria-label="Reply details">
      <div>
        <dt>Model</dt>
        <dd className="mono">
          {family && (
            <span
              className="pg-logo"
              role="img"
              aria-label={`${family.name} model`}
              title={`${family.name} model`}
            >
              <LogoMark logo={family.logo} />
            </span>
          )}
          {turn.model}
        </dd>
      </div>
      {served && (
        <div>
          <dt>Served by</dt>
          <dd>
            {provider && (
              <span className="pg-logo" aria-hidden="true">
                {provider.logo ? <LogoMark logo={provider.logo} /> : <FlaskConical size={12} />}
              </span>
            )}
            {served.cacheHit
              ? 'the response cache'
              : served.deployment
                ? deploymentLabel(served.deployment)
                : '—'}
            {served.fallbackFrom.length > 0 && (
              <span className="badge tone-warning pg-fallback">
                fell back from {served.fallbackFrom.map(deploymentLabel).join(', ')}
              </span>
            )}
          </dd>
        </div>
      )}
      {(turn.firstTextMs !== null || turn.totalMs !== null) && (
        <div>
          <dt>Latency</dt>
          <dd className="mono">
            {turn.firstTextMs !== null && `first text ${formatMs(turn.firstTextMs)}`}
            {turn.firstTextMs !== null && turn.totalMs !== null && ' · '}
            {turn.totalMs !== null && `total ${formatMs(turn.totalMs)}`}
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
      {served?.requestId && (
        <div>
          <dt>Request</dt>
          <dd>
            <CopyId id={served.requestId} />
          </dd>
        </div>
      )}
    </dl>
  );
}

function Reply({
  turn,
  last,
  onRetry,
  origin,
}: {
  turn: ReplyTurn;
  last: boolean;
  onRetry: () => void;
  origin: string;
}) {
  return (
    <li className="pg-turn pg-reply">
      {turn.content !== '' && <div className="pg-text">{turn.content}</div>}
      {turn.status === 'waiting' && (
        <div className="pg-waiting">
          <span className="muted small">Waiting for the gateway…</span>
          {turn.slow && <WakingHint />}
        </div>
      )}
      {turn.status === 'stopped' && <span className="badge">stopped</span>}
      {turn.status === 'done' && turn.finishReason === 'length' && (
        <span className="badge tone-warning">cut off at the output limit</span>
      )}
      {turn.status === 'failed' && turn.problem && (
        <Problem turn={turn} last={last} onRetry={onRetry} origin={origin} />
      )}
      {turn.status !== 'waiting' && <ReplyMeta turn={turn} />}
    </li>
  );
}

function Problem({
  turn,
  last,
  onRetry,
  origin,
}: {
  turn: ReplyTurn;
  last: boolean;
  onRetry: () => void;
  origin: string;
}) {
  const { title, detail } = describeProblem(turn.problem!, { model: turn.model, origin });
  return (
    <div className="state error pg-problem" role="alert">
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
        {turn.problem!.requestId && (
          <p className="small">
            Request <span className="mono">{turn.problem!.requestId}</span>
          </p>
        )}
      </div>
      {last && (
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Conversation({
  turns,
  busy,
  onRetry,
}: {
  turns: Turn[];
  busy: boolean;
  onRetry: () => void;
}) {
  const origin = window.location.origin;
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
            origin={origin}
          />
        ),
      )}
    </ol>
  );
}
