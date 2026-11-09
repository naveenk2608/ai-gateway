import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  ApiError,
  canManage,
  ROUTING_POLICIES,
  type ProjectRoutes,
  type Role,
  type RouteHistory,
  type RouteSpec,
} from '../api.js';
import { formatTime } from '../format.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

type Target = RouteSpec['targets'][number];

/** Moves the target at `from` one place up (-1) or down (+1). */
function move(targets: Target[], from: number, by: -1 | 1): Target[] {
  const to = from + by;
  if (to < 0 || to >= targets.length) return targets;
  const next = [...targets];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

const describe = (route: RouteSpec | null) =>
  route === null
    ? "the models file's route"
    : `${route.policy}: ${route.targets
        .map(
          (t) =>
            `${t.deployment}${t.weight !== 1 ? ` x${t.weight}` : ''}${t.lastResort ? ' (last resort)' : ''}`,
        )
        .join(', ')}`;

/** The editor for one model: starts from its active route (the override, else the file's). */
function ModelRoute({
  projectId,
  model,
  admin,
  enabled,
}: {
  projectId: string;
  model: ProjectRoutes['models'][number];
  admin: boolean;
  enabled: boolean;
}) {
  const client = useQueryClient();
  const active = model.override?.route ?? model.file;
  const [policy, setPolicy] = useState(active.policy);
  const [targets, setTargets] = useState<Target[]>(active.targets);
  const encoded = encodeURIComponent(model.name);
  const base = `/admin/projects/${projectId}/routes/${encoded}`;
  const history = useQuery({
    queryKey: ['route-history', projectId, model.name],
    queryFn: ({ signal }) => api<RouteHistory>(`${base}/history`, { signal }),
  });
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['routes', projectId] }),
      client.invalidateQueries({ queryKey: ['route-history', projectId, model.name] }),
    ]);
  const save = useMutation({
    mutationFn: () => api(base, { method: 'PUT', body: { policy, targets } }),
    onSuccess: () => void refresh(),
  });
  const reset = useMutation({
    mutationFn: () => api(`${base}/reset`, { method: 'POST' }),
    onSuccess: () => void refresh(),
  });
  const rollback = useMutation({
    mutationFn: (version: number) => api(`${base}/rollback`, { method: 'POST', body: { version } }),
    onSuccess: () => void refresh(),
  });
  const error = save.error ?? reset.error ?? rollback.error;
  const editable = admin && enabled;
  const unused = model.file.targets.filter(
    (f) => !targets.some((t) => t.deployment === f.deployment),
  );
  const set = (i: number, patch: Partial<Target>) =>
    setTargets(targets.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  return (
    <>
      <p className="muted small card-text">
        {model.override
          ? `Overridden for this project (version ${model.override.version}, ${formatTime(model.override.createdAt)}).`
          : "This project uses the models file's route."}{' '}
        From the file: {describe(model.file)}.
      </p>
      <form
        className="route-editor"
        aria-label={`Route of ${model.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (editable && targets.length > 0) save.mutate();
        }}
      >
        <label className="route-field">
          <span>Policy</span>
          <select
            aria-label="Policy"
            value={policy}
            disabled={!editable}
            onChange={(e) => setPolicy(e.target.value as RouteSpec['policy'])}
          >
            {ROUTING_POLICIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Deployment</th>
                <th>Weight</th>
                <th>Last resort</th>
                {editable && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {targets.map((t, i) => (
                <tr key={t.deployment}>
                  <td className="num">{i + 1}</td>
                  <td className="mono small">{t.deployment}</td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Weight of ${t.deployment}`}
                      min={1}
                      max={1_000}
                      value={t.weight}
                      disabled={!editable}
                      onChange={(e) => set(i, { weight: Math.max(1, Number(e.target.value) || 1) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${t.deployment} is a last resort`}
                      checked={t.lastResort}
                      disabled={!editable}
                      onChange={(e) => set(i, { lastResort: e.target.checked })}
                    />
                  </td>
                  {editable && (
                    <td className="actions">
                      <button
                        type="button"
                        aria-label={`Move ${t.deployment} up`}
                        disabled={i === 0}
                        onClick={() => setTargets(move(targets, i, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${t.deployment} down`}
                        disabled={i === targets.length - 1}
                        onClick={() => setTargets(move(targets, i, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${t.deployment}`}
                        disabled={targets.length === 1}
                        onClick={() => setTargets(targets.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="row">
            {unused.map((u) => (
              <button
                key={u.deployment}
                type="button"
                onClick={() => setTargets([...targets, { ...u }])}
              >
                Add {u.deployment}
              </button>
            ))}
            <button type="submit" className="primary" disabled={save.isPending}>
              Save as a new version
            </button>
            <button
              type="button"
              disabled={reset.isPending || !model.override}
              onClick={() => reset.mutate()}
            >
              Reset to the models file
            </button>
          </div>
        )}
        {!admin && <p className="muted small">Only admins change routing.</p>}
        {admin && !enabled && (
          <p className="muted small">Routing overrides are off on this gateway.</p>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error instanceof ApiError ? error.message : 'The change failed.'}
          </p>
        )}
      </form>
      <h3>History</h3>
      {history.isPending ? (
        <Loading what="route history" />
      ) : history.isError ? (
        <ErrorState error={history.error} retry={() => void history.refetch()} />
      ) : history.data.versions.length === 0 ? (
        <Empty>No changes yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Change</th>
                <th>Route</th>
                <th>By</th>
                <th>When</th>
                {editable && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {history.data.versions.map((v) => (
                <tr key={v.version}>
                  <td className="num">{v.version}</td>
                  <td>{v.action === 'rollback' ? `rollback to ${v.rolledBackTo}` : v.action}</td>
                  <td className="small">{describe(v.route)}</td>
                  <td className="small">{v.createdBy ?? '—'}</td>
                  <td className="small">{formatTime(v.createdAt)}</td>
                  {editable && (
                    <td className="actions">
                      <button
                        type="button"
                        disabled={
                          rollback.isPending || v.version === history.data.versions[0]?.version
                        }
                        onClick={() => rollback.mutate(v.version)}
                      >
                        Roll back to {v.version}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * Routing edited from the dashboard (ADR 034): a project admin overrides a model's policy and
 * targets for this project, using only the deployments the models file lists for it; each save
 * is a new version, with history and rollback. Viewers see it read-only.
 */
export function RouteEditor({ projectId, role }: { projectId: string; role: Role }) {
  const routes = useQuery({
    queryKey: ['routes', projectId],
    queryFn: ({ signal }) => api<ProjectRoutes>(`/admin/projects/${projectId}/routes`, { signal }),
  });
  const [selected, setSelected] = useState<string | null>(null);
  if (routes.isPending) return <Loading what="routes" />;
  if (routes.isError) {
    return <ErrorState error={routes.error} retry={() => void routes.refetch()} />;
  }
  const models = routes.data.models;
  if (models.length === 0) return <Empty>The models file configures no models.</Empty>;
  const model = models.find((m) => m.name === selected) ?? models[0]!;
  return (
    <>
      <label className="route-field">
        <span>Model</span>
        <select
          aria-label="Model to route"
          value={model.name}
          onChange={(e) => setSelected(e.target.value)}
        >
          {models.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
              {m.override ? ' (overridden)' : ''}
            </option>
          ))}
        </select>
      </label>
      {/* A new key per model and version, so the form starts from the route now active. */}
      <ModelRoute
        key={`${model.name}/${model.override?.version ?? 0}`}
        projectId={projectId}
        model={model}
        admin={canManage(role)}
        enabled={routes.data.enabled}
      />
    </>
  );
}
