import { useQuery } from '@tanstack/react-query';
import { KeyRound, RefreshCw, SquarePen } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { api, canManage, type ApiKey, type Role } from '../api.js';
import { formatTime } from '../format.js';
import { useChat } from '../playground/chat.js';
import { listModels, type Connection, type GatewayProblem } from '../playground/client.js';
import { Composer } from '../playground/Composer.js';
import { Conversation } from '../playground/Conversation.js';
import {
  KEY_NAME,
  keyIdOf,
  maskedKey,
  usePlaygroundKey,
  type PlaygroundKey,
} from '../playground/key.js';
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

/**
 * The models from GET /v1/models, asked with the key in use: `keyId` is the pasted key's public
 * part, or null for the automatic key.
 */
function useModels(projectId: string, connection: Connection | null, keyId: string | null) {
  return useQuery<string[], GatewayProblem>({
    // The automatic key's list is per project, so a renewed key keeps it on screen. A pasted key
    // may belong to another project, with other models. Only its public part goes in the cache.
    queryKey: ['playground-models', projectId, keyId === null ? 'automatic' : `own:${keyId}`],
    queryFn: ({ signal }) => listModels(connection!, signal),
    enabled: connection !== null,
    retry: false,
  });
}

/**
 * The project's own key with this public part, null when the project has none (the key belongs to
 * another project, or to none), or undefined until that is known.
 */
function useProjectKey(projectId: string, keyId: string | null): ApiKey | null | undefined {
  const keys = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: ({ signal }) =>
      api<{ data: ApiKey[] }>(`/admin/projects/${projectId}/api-keys`, { signal }),
    enabled: keyId !== null,
  });
  if (keyId === null || !keys.isSuccess) return undefined;
  return keys.data.data.find((k) => k.maskedKey === maskedKey(keyId)) ?? null;
}

/** Which key the Playground calls /v1 with, in a sentence. */
function keyInUse({
  auto,
  pasted,
  keyId,
  projectKey,
}: {
  auto: PlaygroundKey;
  pasted: boolean;
  keyId: string | null;
  projectKey: ApiKey | null | undefined;
}): string {
  if (pasted) {
    if (keyId === null) return 'No key in use: the field does not hold a gateway API key.';
    const named =
      projectKey === undefined
        ? '.'
        : projectKey === null
          ? ". It is not one of this project's keys, so its own project's limits, budget and " +
            'models apply, and its requests are recorded there.'
          : `, named "${projectKey.name}" in this project${
              projectKey.status === 'revoked' || projectKey.status === 'expired'
                ? ` (${projectKey.status})`
                : ''
            }.`;
    return (
      `Calling /v1 with your key ${maskedKey(keyId)}${named} It is held only in this page, ` +
      'never stored, and forgotten when you leave the page or clear the field.'
    );
  }
  if (auto.status !== 'ready') return 'Creating a short-lived API key for this project…';
  const id = keyIdOf(auto.key);
  return (
    `Calling /v1 with the automatic key${id ? ` ${maskedKey(id)}` : ''}, named "${KEY_NAME}" ` +
    'in this project, so its limits, budget, routing and usage tracking apply. It is held only in this page, revoked when you leave it, and expires at ' +
    `${formatTime(new Date(auto.expiresAt).toISOString())}.`
  );
}

/** "Use my own API key": a field for a key, kept in the page's state and nowhere else. */
function OwnKey({
  chosen,
  value,
  invalid,
  onChoose,
  onChange,
}: {
  chosen: boolean;
  value: string;
  invalid: boolean;
  onChoose: (chosen: boolean) => void;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="pg-own">
      <label className="pg-own-toggle">
        <input type="checkbox" checked={chosen} onChange={(e) => onChoose(e.target.checked)} />
        Use my own API key
      </label>
      {chosen && (
        <div className="pg-own-key">
          <label htmlFor={`${id}-key`} className="muted small">
            API key
          </label>
          {/* Outside any form, with autocomplete off, so browsers do not offer to save it. */}
          <input
            id={`${id}-key`}
            type="password"
            className="mono"
            placeholder="gw_…"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={value}
            aria-invalid={invalid}
            aria-describedby={`${id}-note`}
            onChange={(e) => onChange(e.target.value)}
          />
          <p id={`${id}-note`} className={invalid ? 'error-text small' : 'muted small'}>
            {invalid
              ? 'This is not a gateway API key: keys look like gw_<id>_<secret>.'
              : 'Paste a gw_ key. It is held only in this page and never stored; leave the field empty to use the automatic key.'}
          </p>
        </div>
      )}
    </div>
  );
}

function ModelPicker({
  models,
  model,
  ownKey,
  onChange,
}: {
  models: ReturnType<typeof useModels>;
  model: string;
  ownKey: boolean;
  onChange: (model: string) => void;
}) {
  if (models.isPending) {
    // A query that is not running is waiting for a key.
    return models.fetchStatus === 'idle' ? null : (
      <span className="muted small">Loading models…</span>
    );
  }
  if (models.isError) {
    const { title, detail } = describeProblem(models.error, { ownKey });
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
  // The automatic key is the default and stays ready while a pasted key is in use.
  const auto = usePlaygroundKey(projectId);
  const [ownChosen, setOwnChosen] = useState(false);
  // The pasted key lives in this state only: never in storage, the URL or a query key.
  const [ownKey, setOwnKey] = useState('');
  const pasted = ownChosen && ownKey.trim() !== '';
  const ownKeyId = pasted ? keyIdOf(ownKey.trim()) : null;
  const projectKey = useProjectKey(projectId, ownKeyId);
  const apiKey = pasted
    ? ownKeyId === null
      ? null
      : ownKey.trim()
    : auto.status === 'ready'
      ? auto.key
      : null;
  const connection = useMemo<Connection | null>(() => (apiKey ? { apiKey } : null), [apiKey]);
  const models = useModels(projectId, connection, ownKeyId);
  const [stored, setStored] = useState(() => readPreference(MODEL_KEY));
  const model = chooseModel(models.data ?? [], stored);
  const chat = useChat(connection, model);
  const chooseOwn = (chosen: boolean) => {
    setOwnChosen(chosen);
    if (!chosen) setOwnKey('');
  };

  return (
    <section className="card pg-chat" aria-labelledby="pg-title">
      <div className="card-header pg-header">
        <h2 id="pg-title">Chat</h2>
        <ModelPicker
          models={models}
          model={model}
          ownKey={pasted}
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
      <div className="pg-keys">
        {auto.status === 'failed' && !pasted ? (
          <ErrorState error={auto.error} retry={auto.renew} />
        ) : (
          <p className="muted small pg-key" role="status">
            <KeyRound size={14} aria-hidden="true" />
            {keyInUse({ auto, pasted, keyId: ownKeyId, projectKey })}
          </p>
        )}
        <OwnKey
          chosen={ownChosen}
          value={ownKey}
          invalid={pasted && ownKeyId === null}
          onChoose={chooseOwn}
          onChange={setOwnKey}
        />
      </div>
      {chat.turns.length === 0 ? (
        connection === null ? (
          pasted || auto.status !== 'creating' ? null : (
            <Loading what="the Playground" />
          )
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
          ownKey={pasted}
          onRetry={chat.retry}
          onRenewKey={pasted ? () => chooseOwn(false) : auto.renew}
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
