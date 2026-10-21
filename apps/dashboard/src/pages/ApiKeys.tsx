import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError, canManage, type ApiKey, type Limits, type Role } from '../api.js';
import { formatTime } from '../format.js';
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

export function ApiKeys({ projectId, role }: { projectId: string; role: Role }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
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

  return (
    <section className="card" aria-busy={keys.isPending}>
      <h2>API keys</h2>
      {shown && <NewKey value={shown} onDone={() => setShown(null)} />}
      {manage ? (
        <form className="row" onSubmit={submit}>
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
      ) : (
        <p className="muted small">Your role ({role}) can view keys but not change them.</p>
      )}
      {mutationError && (
        <p className="error-text" role="alert">
          {mutationError instanceof ApiError ? mutationError.message : 'The change failed.'}
        </p>
      )}
      {keys.isPending ? (
        <Loading what="keys" />
      ) : keys.isError ? (
        <ErrorState error={keys.error} retry={() => void keys.refetch()} />
      ) : keys.data.data.length === 0 ? (
        <Empty>This project has no API keys yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Status</th>
                <th>Limits</th>
                <th>Created</th>
                {manage && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {keys.data.data.map((key) => {
                const usable = key.status === 'active' || key.status === 'expiring';
                return (
                  <tr key={key.id}>
                    <td>{key.name}</td>
                    <td>
                      <code>{key.maskedKey}</code>
                    </td>
                    <td>
                      <span className={`badge key-${key.status}`}>{key.status}</span>
                      {key.status === 'expiring' && key.expiresAt && (
                        <div className="muted small">until {formatTime(key.expiresAt)}</div>
                      )}
                    </td>
                    <td className="small">{describeLimits(key.limits)}</td>
                    <td className="small">{formatTime(key.createdAt)}</td>
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
