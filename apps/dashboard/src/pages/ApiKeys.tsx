import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Search, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError, canManage, type ApiKey, type Limits, type Role } from '../api.js';
import { formatCount, formatTime } from '../format.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

function describeLimits(limits: Limits): string {
  const parts = [
    limits.requestsPerMinute !== null && `${limits.requestsPerMinute} req/min`,
    limits.tokensPerMinute !== null && `${limits.tokensPerMinute} tokens/min`,
    limits.concurrentRequests !== null && `${limits.concurrentRequests} at once`,
  ].filter(Boolean);
  return parts.length === 0 ? 'project limits only' : parts.join(', ');
}

/** The full key, shown once right after it is created or rotated. */
function NewKey({ value, onDone }: { value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="callout" role="status">
      <p>
        Copy this key now. It is shown only once and cannot be recovered; use it as
        <code> Authorization: Bearer &lt;key&gt;</code>.
      </p>
      <code className="secret">{value}</code>
      <div className="row">
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

const matches = (key: ApiKey, search: string) => {
  const text = search.trim().toLowerCase();
  return text === '' || `${key.name} ${key.maskedKey}`.toLowerCase().includes(text);
};

export function ApiKeys({ projectId, role }: { projectId: string; role: Role }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const keys = useQuery({
    queryKey: ['api-keys', projectId],
    queryFn: ({ signal }) =>
      api<{ data: ApiKey[] }>(`/admin/projects/${projectId}/api-keys`, { signal }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['api-keys', projectId] });

  const create = useMutation({
    mutationFn: () =>
      api<{ key: string }>(`/admin/projects/${projectId}/api-keys`, {
        method: 'POST',
        body: { name: name.trim() },
      }),
    onSuccess: (result) => {
      setShown(result.key);
      setName('');
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/projects/${projectId}/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => void refresh(),
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<{ key: string }>(`/admin/projects/${projectId}/api-keys/${id}/rotate`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (result) => {
      setShown(result.key);
      void refresh();
    },
  });

  const manage = canManage(role);
  const mutationError = create.error ?? revoke.error ?? rotate.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') create.mutate();
  };
  const all = keys.data?.data ?? [];
  const listed = all.filter((key) => matches(key, search));

  return (
    <section className="card" aria-busy={keys.isPending}>
      <div className="card-header">
        <div>
          <h2>API keys</h2>
          <p className="muted small">
            Keys call <code>/v1/chat/completions</code> for this project, within its limits and
            their own.
          </p>
        </div>
        {manage && (
          <form className="row" onSubmit={submit} aria-label="New key">
            <input
              aria-label="New key name"
              placeholder="Name, e.g. backend"
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="primary"
              disabled={create.isPending || name.trim() === ''}
            >
              Create key
            </button>
          </form>
        )}
      </div>
      {shown && <NewKey value={shown} onDone={() => setShown(null)} />}
      <div className="note warning-note" role="note">
        <TriangleAlert size={16} aria-hidden="true" />
        <span>
          Revoking a key stops it on every gateway instance, at the latest when their cached copy
          expires (<code>API_KEY_CACHE_TTL_MS</code>); requests that use it fail from then on.
          Rotating issues a new key and keeps the old one working for a grace period.
        </span>
      </div>
      {!manage && (
        <p className="muted small card-text">
          Your role ({role}) can view keys but not change them.
        </p>
      )}
      {mutationError && (
        <p className="error-text" role="alert">
          {mutationError instanceof ApiError ? mutationError.message : 'The change failed.'}
        </p>
      )}
      <div className="section-head">
        <h3>
          Keys {keys.data && <span className="muted small">{formatCount(all.length)} in all</span>}
        </h3>
        <label className="search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search keys"
            placeholder="Search keys…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      {keys.isPending ? (
        <Loading what="keys" />
      ) : keys.isError ? (
        <ErrorState error={keys.error} retry={() => void keys.refetch()} />
      ) : all.length === 0 ? (
        <Empty>This project has no API keys yet.</Empty>
      ) : listed.length === 0 ? (
        <Empty>No key matches “{search.trim()}”.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Status</th>
                <th>Created</th>
                <th>Last used</th>
                {manage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {listed.map((key) => {
                const usable = key.status === 'active' || key.status === 'expiring';
                return (
                  <tr key={key.id}>
                    <td>
                      <div className="name-cell">
                        <span className="icon-tile" aria-hidden="true">
                          <KeyRound size={14} />
                        </span>
                        <span>
                          <span className="strong">{key.name}</span>
                          <span className="muted small block">{describeLimits(key.limits)}</span>
                        </span>
                      </div>
                    </td>
                    <td>
                      <code className="chip">{key.maskedKey}</code>
                    </td>
                    <td>
                      <span className={`badge key-${key.status}`}>{key.status}</span>
                      {key.status === 'expiring' && key.expiresAt && (
                        <div className="muted small">until {formatTime(key.expiresAt)}</div>
                      )}
                    </td>
                    <td className="small">{formatTime(key.createdAt)}</td>
                    <td className="small muted">not tracked</td>
                    {manage && (
                      <td className="actions">
                        {usable && !key.rotatedTo && (
                          <button
                            type="button"
                            disabled={rotate.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Rotate "${key.name}"? The old key keeps working for the grace period.`,
                                )
                              )
                                rotate.mutate(key.id);
                            }}
                          >
                            Rotate
                          </button>
                        )}
                        {key.status !== 'revoked' && (
                          <button
                            type="button"
                            className="danger"
                            disabled={revoke.isPending}
                            onClick={() => {
                              if (
                                window.confirm(`Revoke "${key.name}"? Requests with it will fail.`)
                              )
                                revoke.mutate(key.id);
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
