import { KeyRound, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ModelList } from '../models.js';
import { describeProblem } from '../problems.js';
import { checkApiKey, checkGatewayUrl, type Settings } from '../settings.js';

/**
 * Where to connect and with which key, then the model to use. The form has no action and its
 * fields no names, so nothing in it can ever be submitted anywhere but through `onSave`.
 */
export function SettingsPanel({
  settings,
  onSave,
  onForget,
  models,
  model,
  onModelChange,
}: {
  settings: Settings;
  onSave: (settings: Settings) => void;
  onForget: () => void;
  models: ModelList & { reload: () => void };
  model: string;
  onModelChange: (model: string) => void;
}) {
  const [url, setUrl] = useState(settings.gatewayUrl);
  const [key, setKey] = useState(settings.apiKey);
  const [remember, setRemember] = useState(settings.remember);
  const [invalid, setInvalid] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const checkedUrl = checkGatewayUrl(url);
    if ('error' in checkedUrl) return setInvalid(checkedUrl.error);
    const checkedKey = checkApiKey(key);
    if ('error' in checkedKey) return setInvalid(checkedKey.error);
    setInvalid(null);
    setUrl(checkedUrl.url);
    setKey(checkedKey.key);
    onSave({ gatewayUrl: checkedUrl.url, apiKey: checkedKey.key, remember });
  };

  return (
    <>
      <section className="card" aria-labelledby="settings-title">
        <h2 id="settings-title">Connection</h2>
        <form className="form pg-settings" onSubmit={submit} aria-label="Connection settings">
          <label>
            Gateway URL
            <input
              type="url"
              value={url}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            API key
            <input
              type="password"
              value={key}
              placeholder="gw_…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label className="pg-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Remember the key on this device
          </label>
          <p className="muted small">
            The key stays in this browser tab{remember ? ' and on this device' : ''}. It is sent
            only to the gateway URL above, never anywhere else.
          </p>
          {invalid && (
            <p className="error-text" role="alert">
              {invalid}
            </p>
          )}
          <div className="row">
            <button type="submit" className="primary">
              <KeyRound size={16} aria-hidden="true" />
              Save and connect
            </button>
            {settings.apiKey !== '' && (
              <button
                type="button"
                onClick={() => {
                  setKey('');
                  setRemember(false);
                  onForget();
                }}
              >
                Forget key
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="card" aria-labelledby="model-title">
        <div className="card-header">
          <h2 id="model-title">Model</h2>
          {models.status !== 'idle' && (
            <button
              type="button"
              className="ghost icon-button"
              aria-label="Reload the model list"
              disabled={models.status === 'loading'}
              onClick={models.reload}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <ModelPicker models={models} model={model} onModelChange={onModelChange} />
      </section>
    </>
  );
}

function ModelPicker({
  models,
  model,
  onModelChange,
}: {
  models: ModelList & { reload: () => void };
  model: string;
  onModelChange: (model: string) => void;
}) {
  switch (models.status) {
    case 'idle':
      return <p className="muted small card-text">Connect with an API key to list its models.</p>;
    case 'loading':
      return (
        <div className="card-text" aria-busy="true">
          <p className="muted small">Loading the models this key may use…</p>
          {models.slow && <WakingHint />}
        </div>
      );
    case 'failed': {
      const { title, detail } = describeProblem(models.problem, { origin: window.location.origin });
      return (
        <div className="state error pg-problem" role="alert">
          <div>
            <strong>{title}</strong>
            <p>{detail}</p>
          </div>
          <button type="button" onClick={models.reload}>
            Try again
          </button>
        </div>
      );
    }
    case 'ready':
      return models.models.length === 0 ? (
        <p className="muted small card-text">
          This key&apos;s project may use no model that is available right now.
        </p>
      ) : (
        <label className="pg-model">
          <span className="muted small">
            {models.models.length} model{models.models.length === 1 ? '' : 's'} this key may use
          </span>
          <select value={model} onChange={(e) => onModelChange(e.target.value)}>
            {models.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      );
  }
}

/** Shown while a call to the gateway has had no answer for a while. */
export function WakingHint() {
  return (
    <p className="pg-hint small" role="status">
      Still waiting. If the gateway was idle it is waking up: free hosting sleeps when unused, and
      waking takes up to a minute.
    </p>
  );
}
