import { MessagesSquare, SquarePen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useChat } from './chat.js';
import { Composer } from './components/Composer.js';
import { Conversation } from './components/Conversation.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import type { Connection } from './gateway.js';
import { useModels } from './models.js';
import {
  browserStores,
  forgetKey,
  loadModel,
  loadSettings,
  saveModel,
  saveSettings,
  type Settings,
  type Stores,
} from './settings.js';

/** The model to use: the stored choice if the key may use it, else chat-default, else the first. */
function chooseModel(models: string[], stored: string | null): string {
  if (stored && models.includes(stored)) return stored;
  if (models.includes('chat-default')) return 'chat-default';
  return models[0] ?? '';
}

export function App({ stores = browserStores() }: { stores?: Stores }) {
  const [settings, setSettings] = useState<Settings>(() => loadSettings(stores));
  const [storedModel, setStoredModel] = useState(() => loadModel(stores));
  const connection = useMemo<Connection | null>(
    () =>
      settings.apiKey === '' ? null : { gatewayUrl: settings.gatewayUrl, apiKey: settings.apiKey },
    [settings.gatewayUrl, settings.apiKey],
  );
  const models = useModels(connection);
  const available = models.status === 'ready' ? models.models : [];
  const model = chooseModel(available, storedModel);
  const chat = useChat(connection, model);

  return (
    <div className="pg">
      <header className="pg-topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <MessagesSquare size={18} />
          </span>
          AI Gateway
        </span>
        <span className="badge tone-accent">Playground</span>
        <span className="pg-host muted small">
          {connection ? new URL(connection.gatewayUrl).host : 'not connected'}
        </span>
      </header>
      <div className="pg-layout">
        <aside className="pg-side">
          <SettingsPanel
            settings={settings}
            onSave={(next) => {
              saveSettings(stores, next);
              chat.reset();
              setSettings(next);
            }}
            onForget={() => {
              forgetKey(stores);
              chat.reset();
              setSettings({ ...settings, apiKey: '', remember: false });
            }}
            models={models}
            model={model}
            onModelChange={(next) => {
              saveModel(stores, next);
              setStoredModel(next);
            }}
          />
        </aside>
        <main className="card pg-chat">
          <div className="card-header">
            <h1>Chat</h1>
            <button
              type="button"
              onClick={chat.reset}
              disabled={chat.turns.length === 0 && !chat.busy}
            >
              <SquarePen size={16} aria-hidden="true" />
              New chat
            </button>
          </div>
          {chat.turns.length === 0 ? (
            <div className="state empty pg-empty">
              {!connection
                ? 'Add a gateway API key in Connection to start.'
                : model === ''
                  ? 'Waiting for a model to use.'
                  : `Send a message to ${model}. Replies stream in, with how each was served under it.`}
            </div>
          ) : (
            <Conversation turns={chat.turns} busy={chat.busy} onRetry={chat.retry} />
          )}
          <Composer
            disabled={!connection || model === ''}
            busy={chat.busy}
            onSend={chat.send}
            onStop={chat.stop}
          />
          <p className="muted small pg-footnote">
            The conversation lives in this page only and is gone when you start a new chat or close
            it. Replies come from the models; check anything important.
          </p>
        </main>
      </div>
    </div>
  );
}
