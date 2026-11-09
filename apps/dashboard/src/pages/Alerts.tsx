import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  canManage,
  type AlertEvent,
  type AlertKind,
  type Alerts as AlertsData,
  type Role,
} from '../api.js';
import { formatCount, formatTime } from '../format.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const KINDS: { id: AlertKind; label: string }[] = [
  { id: 'discord', label: 'Discord' },
  { id: 'slack', label: 'Slack' },
  { id: 'generic', label: 'Generic JSON (signed)' },
];

const EVENTS: { id: AlertEvent; label: string }[] = [
  { id: 'budget', label: 'Budget at 50, 80 and 100%' },
  { id: 'breaker', label: 'A breaker opened' },
  { id: 'dead_letters', label: 'Dead letters growing' },
];

const EVENT_TYPES: Record<string, string> = {
  'budget.threshold': 'budget',
  'breaker.opened': 'breaker opened',
  'dead_letters.growing': 'dead letters',
  test: 'test',
};

/** A generic destination's signing secret, shown once right after it is created. */
function NewSecret({ value, onDone }: { value: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="callout" role="status">
      <p>
        Copy this signing secret now. It is shown only once; your receiver uses it to check the
        <code> webhook-signature</code> header of each alert.
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

/**
 * Webhook alerts (ADR 033): destinations that receive budget, breaker and dead-letter alerts, and
 * the latest deliveries. Admins add, test and delete destinations; URLs are only shown masked.
 */
export function Alerts({ projectId, role }: { projectId: string; role: Role }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AlertKind>('discord');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<AlertEvent[]>(['budget']);
  const [secret, setSecret] = useState<string | null>(null);
  const alerts = useQuery({
    queryKey: ['alerts', projectId],
    queryFn: ({ signal }) => api<AlertsData>(`/admin/projects/${projectId}/alerts`, { signal }),
    refetchInterval: 15_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['alerts', projectId] });
  const add = useMutation({
    mutationFn: () =>
      api<{ secret: string | null }>(`/admin/projects/${projectId}/alerts/destinations`, {
        method: 'POST',
        body: { name: name.trim(), kind, url: url.trim(), events },
      }),
    onSuccess: (created) => {
      setName('');
      setUrl('');
      setSecret(created.secret);
      void refresh();
    },
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/projects/${projectId}/alerts/destinations/${id}/test`, { method: 'POST' }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/projects/${projectId}/alerts/destinations/${id}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const admin = canManage(role);
  const error = add.error ?? test.error ?? remove.error;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() !== '' && url.trim() !== '' && events.length > 0) add.mutate();
  };
  const toggle = (event: AlertEvent, on: boolean) =>
    setEvents((current) => (on ? [...current, event] : current.filter((e) => e !== event)));

  if (alerts.isPending) {
    return (
      <section className="card" aria-busy="true">
        <Loading what="alerts" />
      </section>
    );
  }
  if (alerts.isError) {
    return (
      <section className="card">
        <ErrorState error={alerts.error} retry={() => void alerts.refetch()} />
      </section>
    );
  }
  const data = alerts.data;
  return (
    <>
      <section className="card" aria-busy={alerts.isFetching}>
        <div className="card-header">
          <h2>Alert destinations</h2>
          <span className="muted small">{formatCount(data.destinations.length)} in all</span>
        </div>
        {!data.enabled && (
          <p className="muted small card-text">
            Alerts are off on this gateway (ALERTS_ENABLED, or no encryption key).
          </p>
        )}
        {secret && <NewSecret value={secret} onDone={() => setSecret(null)} />}
        {admin && data.enabled ? (
          <form className="alert-form" aria-label="New alert destination" onSubmit={submit}>
            <div className="row add-row">
              <input
                aria-label="Destination name"
                placeholder="name, e.g. on-call"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                aria-label="Destination kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as AlertKind)}
              >
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input
                type="url"
                aria-label="Webhook URL"
                placeholder="https://…"
                value={url}
                maxLength={2_048}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <fieldset className="row">
              <legend className="muted small">Events</legend>
              {EVENTS.map((ev) => (
                <label key={ev.id}>
                  <input
                    type="checkbox"
                    checked={events.includes(ev.id)}
                    onChange={(e) => toggle(ev.id, e.target.checked)}
                  />{' '}
                  {ev.label}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <button type="submit" className="primary" disabled={add.isPending}>
                Add destination
              </button>
            </div>
          </form>
        ) : (
          !admin && <p className="muted small">Only admins manage alert destinations.</p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error instanceof ApiError ? error.message : 'The change failed.'}
          </p>
        )}
        {data.destinations.length === 0 ? (
          <Empty>No destinations yet: alerts are queued for nobody.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>URL</th>
                  <th>Events</th>
                  {admin && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {data.destinations.map((d) => (
                  <tr key={d.id}>
                    <td className="strong">{d.name}</td>
                    <td>{KINDS.find((k) => k.id === d.kind)?.label ?? d.kind}</td>
                    <td>
                      <code className="chip">{d.urlHint}</code>
                    </td>
                    <td className="small">{d.events.join(', ')}</td>
                    {admin && (
                      <td className="actions">
                        <button
                          type="button"
                          disabled={test.isPending || !data.enabled}
                          onClick={() => test.mutate(d.id)}
                        >
                          Send test
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(d.id)}
                        >
                          Delete
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-header">
          <h2>Recent deliveries</h2>
          <span className="muted small">the latest 50</span>
        </div>
        {data.deliveries.length === 0 ? (
          <Empty>No alerts sent yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>Destination</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th>Tries</th>
                  <th>Last answer</th>
                </tr>
              </thead>
              <tbody>
                {data.deliveries.map((d) => (
                  <tr key={d.id}>
                    <td className="small">{formatTime(d.createdAt)}</td>
                    <td>{d.destinationName}</td>
                    <td>{EVENT_TYPES[d.eventType] ?? d.eventType}</td>
                    <td>
                      <span
                        className={`badge ${d.status === 'delivered' ? 'status-success' : d.status === 'failed' ? 'status-error' : ''}`}
                      >
                        {d.status}
                      </span>
                      {d.nextAttemptAt && (
                        <div className="muted small">next {formatTime(d.nextAttemptAt)}</div>
                      )}
                    </td>
                    <td className="num">{d.attempts}</td>
                    <td className="small">
                      {d.lastError ?? (d.lastStatus !== null ? `HTTP ${d.lastStatus}` : '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
