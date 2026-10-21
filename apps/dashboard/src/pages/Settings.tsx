import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  canManage,
  type Limits,
  type Member,
  type ModelCatalog,
  type Project,
  type Role,
} from '../api.js';
import { ApiKeys } from './ApiKeys.js';
import { formatLatency, formatTime, formatUsd, parseUsd, usdInput } from '../format.js';
import { QueryCard } from '../ui/QueryCard.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const ROLES: Role[] = ['viewer', 'admin', 'owner'];

function MutationError({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p className="error-text" role="alert">
      {error instanceof ApiError ? error.message : 'The change failed.'}
    </p>
  );
}

/** A positive whole number, or null for an empty field (no limit); NaN if invalid. */
function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return /^[1-9]\d*$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

const showLimit = (value: number | null) =>
  value === null ? 'no limit' : value.toLocaleString('en-US');

/** Name, model allow-list, limits and budget. Only admins and owners see the form. */
function ProjectSettings({ project, models }: { project: Project; models: string[] }) {
  const client = useQueryClient();
  const [name, setName] = useState(project.name);
  const [allowed, setAllowed] = useState(project.allowedModels?.join(', ') ?? '');
  const [limits, setLimits] = useState({
    requestsPerMinute: project.limits.requestsPerMinute?.toString() ?? '',
    tokensPerMinute: project.limits.tokensPerMinute?.toString() ?? '',
    concurrentRequests: project.limits.concurrentRequests?.toString() ?? '',
  });
  const [budget, setBudget] = useState({
    monthly: usdInput(project.budget.monthlyLimitMicroUsd),
    perRequest: usdInput(project.budget.maxRequestCostMicroUsd),
  });
  const [invalid, setInvalid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: unknown) =>
      api<Project>(`/admin/projects/${project.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['project', project.id] });
      void client.invalidateQueries({ queryKey: ['me'] });
    },
  });

  if (!canManage(project.role)) {
    return (
      <dl className="facts">
        <dt>Name</dt>
        <dd>{project.name}</dd>
        <dt>Allowed models</dt>
        <dd>{project.allowedModels?.join(', ') ?? 'every configured model'}</dd>
        <dt>Requests per minute</dt>
        <dd>{showLimit(project.limits.requestsPerMinute)}</dd>
        <dt>Tokens per minute</dt>
        <dd>{showLimit(project.limits.tokensPerMinute)}</dd>
        <dt>Concurrent requests</dt>
        <dd>{showLimit(project.limits.concurrentRequests)}</dd>
        <dt>Monthly budget</dt>
        <dd>
          {project.budget.monthlyLimitMicroUsd === null
            ? 'none'
            : formatUsd(project.budget.monthlyLimitMicroUsd)}
        </dd>
        <dt>Most one request may cost</dt>
        <dd>
          {project.budget.maxRequestCostMicroUsd === null
            ? 'no cap'
            : formatUsd(project.budget.maxRequestCostMicroUsd)}
        </dd>
      </dl>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedLimits = {
      requestsPerMinute: parseLimit(limits.requestsPerMinute),
      tokensPerMinute: parseLimit(limits.tokensPerMinute),
      concurrentRequests: parseLimit(limits.concurrentRequests),
    } satisfies Limits;
    const monthly = parseUsd(budget.monthly);
    const perRequest = parseUsd(budget.perRequest);
    if (Object.values(parsedLimits).some((v) => Number.isNaN(v))) {
      setInvalid('Limits must be whole numbers above zero, or empty for no limit.');
      return;
    }
    if (Number.isNaN(monthly) || Number.isNaN(perRequest) || perRequest === 0) {
      setInvalid('Budgets are dollar amounts (up to 6 decimals), or empty for none.');
      return;
    }
    setInvalid(null);
    const list = allowed
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '');
    save.mutate({
      name: name.trim(),
      allowedModels: list.length === 0 ? null : list,
      limits: parsedLimits,
      budget: { monthlyLimitMicroUsd: monthly, maxRequestCostMicroUsd: perRequest },
    });
  };

  return (
    <form className="form" onSubmit={submit} aria-label="Project settings">
      <label>
        Name
        <input value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Allowed models (comma-separated; empty allows every model)
        <input
          value={allowed}
          placeholder={models.join(', ')}
          onChange={(e) => setAllowed(e.target.value)}
        />
      </label>
      <fieldset>
        <legend>Limits for all of the project&apos;s keys (empty: no limit)</legend>
        <label>
          Requests per minute
          <input
            inputMode="numeric"
            value={limits.requestsPerMinute}
            onChange={(e) => setLimits({ ...limits, requestsPerMinute: e.target.value })}
          />
        </label>
        <label>
          Tokens per minute
          <input
            inputMode="numeric"
            value={limits.tokensPerMinute}
            onChange={(e) => setLimits({ ...limits, tokensPerMinute: e.target.value })}
          />
        </label>
        <label>
          Concurrent requests
          <input
            inputMode="numeric"
            value={limits.concurrentRequests}
            onChange={(e) => setLimits({ ...limits, concurrentRequests: e.target.value })}
          />
        </label>
      </fieldset>
      <fieldset>
        <legend>Budget in US dollars (empty: none)</legend>
        <label>
          Per UTC month
          <input
            inputMode="decimal"
            value={budget.monthly}
            onChange={(e) => setBudget({ ...budget, monthly: e.target.value })}
          />
        </label>
        <label>
          Most one request may cost
          <input
            inputMode="decimal"
            value={budget.perRequest}
            onChange={(e) => setBudget({ ...budget, perRequest: e.target.value })}
          />
        </label>
      </fieldset>
      {invalid && (
        <p className="error-text" role="alert">
          {invalid}
        </p>
      )}
      <MutationError error={save.error} />
      {save.isSuccess && !save.isPending && <p className="muted small">Saved.</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          Save project settings
        </button>
      </div>
    </form>
  );
}

function Members({ projectId, role, userId }: { projectId: string; role: Role; userId: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('viewer');
  const [password, setPassword] = useState('');
  const members = useQuery({
    queryKey: ['members', projectId],
    queryFn: ({ signal }) =>
      api<{ data: Member[] }>(`/admin/projects/${projectId}/members`, { signal }),
  });
  const refresh = () => client.invalidateQueries({ queryKey: ['members', projectId] });
  const add = useMutation({
    mutationFn: () =>
      api<Member>(`/admin/projects/${projectId}/members`, {
        method: 'POST',
        body: { email: email.trim(), role: newRole, ...(password ? { password } : {}) },
      }),
    onSuccess: () => {
      setEmail('');
      setPassword('');
      void refresh();
    },
  });
  const change = useMutation({
    mutationFn: ({ member, to }: { member: string; to: Role }) =>
      api(`/admin/projects/${projectId}/members/${member}`, {
        method: 'PATCH',
        body: { role: to },
      }),
    onSuccess: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: (member: string) =>
      api(`/admin/projects/${projectId}/members/${member}`, { method: 'DELETE' }),
    onSuccess: () => void refresh(),
  });
  const isOwner = role === 'owner';

  return (
    <section className="card" aria-busy={members.isFetching}>
      <h2>Members</h2>
      {isOwner ? (
        <form
          className="row"
          aria-label="Add member"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim() !== '') add.mutate();
          }}
        >
          <input
            type="email"
            aria-label="Member email"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select
            aria-label="Member role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input
            type="password"
            aria-label="Initial password for a new user"
            placeholder="password, new users only"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" className="primary" disabled={add.isPending}>
            Add member
          </button>
        </form>
      ) : (
        <p className="muted small">Only owners manage members.</p>
      )}
      <MutationError error={add.error ?? change.error ?? remove.error} />
      {members.isPending ? (
        <Loading what="members" />
      ) : members.isError ? (
        <ErrorState error={members.error} retry={() => void members.refetch()} />
      ) : members.data.data.length === 0 ? (
        <Empty>This project has no members.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Since</th>
                {isOwner && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.data.data.map((m) => (
                <tr key={m.userId}>
                  <td>
                    {m.email}
                    {m.userId === userId && <span className="muted small"> (you)</span>}
                  </td>
                  <td>
                    {isOwner ? (
                      <select
                        aria-label={`Role of ${m.email}`}
                        value={m.role}
                        disabled={change.isPending}
                        onChange={(e) =>
                          change.mutate({ member: m.userId, to: e.target.value as Role })
                        }
                      >
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                    ) : (
                      m.role
                    )}
                  </td>
                  <td className="small">{formatTime(m.createdAt)}</td>
                  {isOwner && (
                    <td className="actions">
                      <button
                        type="button"
                        className="danger"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Remove ${m.email} from this project?`))
                            remove.mutate(m.userId);
                        }}
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
      )}
    </section>
  );
}

/** Deployments and routing policies, read-only: they come from the gateway's models file. */
function Routing({ catalog }: { catalog: ModelCatalog }) {
  return (
    <>
      <p className="muted small">
        Read from the gateway&apos;s models file at startup; edit that file to change them.
      </p>
      <h3>Models and routing policies</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Policy</th>
              <th>Targets</th>
            </tr>
          </thead>
          <tbody>
            {catalog.models.map((m) => (
              <tr key={m.name}>
                <td>
                  {m.name}
                  {!m.available && <span className="badge alert-exceeded">unavailable</span>}
                </td>
                <td>{m.policy}</td>
                <td>
                  {m.targets
                    .map((t) =>
                      m.policy === 'weighted' ? `${t.deployment} ×${t.weight}` : t.deployment,
                    )
                    .join(' → ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Deployments</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Deployment</th>
              <th>Provider</th>
              <th>Model</th>
              <th className="num">Timeout</th>
              <th className="num">Output cap</th>
            </tr>
          </thead>
          <tbody>
            {catalog.deployments.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.id}
                  {!d.enabled && <span className="badge alert-exceeded">disabled</span>}
                </td>
                <td>{d.provider}</td>
                <td>{d.providerModel}</td>
                <td className="num">{formatLatency(d.timeoutMs)}</td>
                <td className="num">{d.maxOutputTokens.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function NewProject() {
  const client = useQueryClient();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<Project>('/admin/projects', { method: 'POST', body: { name: name.trim() } }),
    onSuccess: () => {
      setName('');
      void client.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <section className="card">
      <h2>New project</h2>
      <p className="muted small">You become its owner.</p>
      <form
        className="row"
        aria-label="New project"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '') create.mutate();
        }}
      >
        <input
          aria-label="Project name"
          placeholder="Project name"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={create.isPending || name.trim() === ''}>
          Create project
        </button>
      </form>
      <MutationError error={create.error} />
      {create.isSuccess && <p className="muted small">Created; pick it in the project menu.</p>}
    </section>
  );
}

export function Settings({ projectId, userId }: { projectId: string; userId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => api<Project>(`/admin/projects/${projectId}`, { signal }),
  });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  const role = project.data?.role;

  return (
    <>
      <QueryCard
        title="Project"
        what="project settings"
        query={project}
        isEmpty={() => false}
        empty={null}
      >
        {(data) => (
          <ProjectSettings
            key={data.updatedAt}
            project={data}
            models={catalog.data?.models.map((m) => m.name) ?? []}
          />
        )}
      </QueryCard>
      {role && <Members projectId={projectId} role={role} userId={userId} />}
      {role && <ApiKeys projectId={projectId} role={role} />}
      <QueryCard
        title="Deployments and routing"
        what="deployments"
        query={catalog}
        isEmpty={(data) => data.models.length === 0 && data.deployments.length === 0}
        empty="The models file configures no models or deployments."
      >
        {(data) => <Routing catalog={data} />}
      </QueryCard>
      <NewProject />
    </>
  );
}
