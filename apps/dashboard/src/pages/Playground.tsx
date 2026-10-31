import { useQuery } from '@tanstack/react-query';
import { KeyRound, RefreshCw, SquarePen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { canManage, type Role } from '../api.js';
import { formatTime } from '../format.js';
import { useChat } from '../playground/chat.js';
import { listModels, type Connection, type GatewayProblem } from '../playground/client.js';
import { Composer } from '../playground/Composer.js';
import { Conversation } from '../playground/Conversation.js';
import { KEY_NAME, usePlaygroundKey } from '../playground/key.js';
import { describeProblem } from '../playground/problems.js';
import { readPreference, writePreference } from '../shell/preferences.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const MODEL_KEY = 'ai-gateway.playground.model';

/** The model to use: the remembered choice if allowed, else chat-default, else the first. */
function chooseModel(models: string[], stored: string | null): string {
  if (stored && models.includes(stored)) return stored;
  if (models.includes('chat-default')) return 'chat-default';
  return models[0] ?? '';
}

/** The project's models from GET /v1/models, asked with the Playground's key. */
function useModels(projectId: string, connection: Connection | null) {
  return useQuery<string[], GatewayProblem>({
    // Per project, not per key: a renewed key keeps the list on screen.
    queryKey: ['playground-models', projectId],
    queryFn: ({ signal }) => listModels(connection!, signal),
    enabled: connection !== null,
    retry: false,
  });
}

function ModelPicker({
  models,
  model,
  onChange,
}: {
  models: ReturnType<typeof useModels>;
  model: string;
  onChange: (model: string) => void;
}) {
  if (models.isPending) return <span className="muted small">Loading models…</span>;
  if (models.isError) {
    const { title, detail } = describeProblem(models.error);
    return (
      <div className="state error pg-problem" role="alert">
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
        <button type="button" onClick={() => void models.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (models.data.length === 0) {
    return (
      <span className="muted small">
        This project may use no model that is available right now.
      </span>
    );
  }
  return (
    <div className="pg-model">
      <label>
        <span className="muted small">Model</span>
        <select value={model} onChange={(e) => onChange(e.target.value)}>
          {models.data.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="ghost icon-button"
        aria-label="Reload the model list"
        disabled={models.isFetching}
        onClick={() => void models.refetch()}
      >
        <RefreshCw size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Only roles that may create API keys can use the Playground; others are told why. */
export function Playground({ projectId, role }: { projectId: string; role: Role }) {
  if (!canManage(role)) {
    return (
      <Empty>
        The Playground calls the gateway with a short-lived API key it creates for this project, and
        only owners and admins may create keys. Your role in this project is {role}; ask an owner
        for the admin role to use it.
      </Empty>
    );
  }
  return <PlaygroundChat projectId={projectId} />;
}

function PlaygroundChat({ projectId }: { projectId: string }) {
  const key = usePlaygroundKey(projectId);
  const apiKey = key.status === 'ready' ? key.key : null;
  const connection = useMemo<Connection | null>(() => (apiKey ? { apiKey } : null), [apiKey]);
  const models = useModels(projectId, connection);
  const [stored, setStored] = useState(() => readPreference(MODEL_KEY));
  const model = chooseModel(models.data ?? [], stored);
  const chat = useChat(connection, model);

  return (
    <section className="card pg-chat" aria-labelledby="pg-title">
      <div className="card-header pg-header">
        <h2 id="pg-title">Chat</h2>
        <ModelPicker
          models={models}
          model={model}
          onChange={(next) => {
            writePreference(MODEL_KEY, next);
            setStored(next);
          }}
        />
        <button type="button" onClick={chat.reset} disabled={chat.turns.length === 0 && !chat.busy}>
          <SquarePen size={16} aria-hidden="true" />
          New chat
        </button>
      </div>
      {key.status === 'failed' ? (
        <ErrorState error={key.error} retry={key.renew} />
      ) : (
        <p className="muted small pg-key" role="status">
          <KeyRound size={14} aria-hidden="true" />
          {key.status === 'ready'
            ? `Calling /v1 with a key named "${KEY_NAME}" for this project, so its limits, budget, routing and usage tracking apply. The key is held only in this page, revoked when you leave it, and expires at ${formatTime(new Date(key.expiresAt).toISOString())}.`
            : 'Creating a short-lived API key for this project…'}
        </p>
      )}
      {chat.turns.length === 0 ? (
        key.status !== 'ready' ? (
          <Loading what="the Playground" />
        ) : (
          <div className="state empty pg-empty">
            {model === ''
              ? 'Waiting for a model to use.'
              : `Send a message to ${model}. Replies stream in, with how each was served under it.`}
          </div>
        )
      ) : (
        <Conversation
          turns={chat.turns}
          busy={chat.busy}
          onRetry={chat.retry}
          onRenewKey={key.renew}
        />
      )}
      <Composer
        disabled={!connection || model === ''}
        busy={chat.busy}
        onSend={chat.send}
        onStop={chat.stop}
      />
      <p className="muted small pg-footnote">
        The conversation lives in this page only and is gone when you start a new chat or leave it.
        Replies come from the models; check anything important.
      </p>
    </section>
  );
}
