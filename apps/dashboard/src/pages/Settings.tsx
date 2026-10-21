import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import {
  analyticsPath,
  api,
  ApiError,
  canManage,
  type CostResponse,
  type Limits,
  type Member,
  type ModelCatalog,
  type OverviewResponse,
  type Project,
  type Role,
} from '../api.js';
import {
  formatCount,
  formatLatency,
  formatTime,
  formatUsd,
  parseUsd,
  usdInput,
} from '../format.js';
import { initials } from '../shell/UserMenu.js';
import { budgetUse, Meter } from '../ui/Meter.js';
import { QueryCard } from '../ui/QueryCard.js';
import { Tabs, type Tab } from '../ui/Tabs.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';
import { ApiKeys } from './ApiKeys.js';

const ROLES: Role[] = ['viewer', 'admin', 'owner'];

type TabId = 'project' | 'limits' | 'members' | 'keys' | 'routing';

const TABS: Tab<TabId>[] = [
  { id: 'project', label: 'Project' },
  { id: 'limits', label: 'Limits and budget' },
  { id: 'members', label: 'Members' },
  { id: 'keys', label: 'API keys' },
  { id: 'routing', label: 'Routing' },
];

/** The tab named in the URL (`#settings/<tab>`), or the first one. */
export function settingsTab(section: string | null): TabId {
  return TABS.find((t) => t.id === section)?.id ?? 'project';
}

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

/** Saves part of the project; the project and the user's project list refresh after. */
function useSaveProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api<Project>(`/admin/projects/${projectId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['project', projectId] });
      void client.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** The project's identity: name, ID, the viewer's role and when it was created. */
function ProjectSummary({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="project-summary">
      <span className="kpi-icon" aria-hidden="true">
        <FolderKanban size={18} />
      </span>
      <div className="project-summary-text">
        <div className="tile-title">{project.name}</div>
        <div className="muted small">
          Project ID <code>{project.id}</code>{' '}
          <button
            type="button"
            className="ghost small-button"
            onClick={() =>
              void navigator.clipboard.writeText(project.id).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? 'Copied' : 'Copy ID'}
          </button>
        </div>
        <div className="muted small">Created {formatTime(project.createdAt)}</div>
      </div>
      <span className="badge tone-accent">your role: {project.role}</span>
    </div>
  );
}

/** Name and model allow-list. Only admins and owners see the form. */
function ProjectForm({ project, models }: { project: Project; models: string[] }) {
  const [name, setName] = useState(project.name);
  const [allowed, setAllowed] = useState(project.allowedModels?.join(', ') ?? '');
  const save = useSaveProject(project.id);

  if (!canManage(project.role)) {
    return (
      <dl className="facts">
        <dt>Name</dt>
        <dd>{project.name}</dd>
        <dt>Allowed models</dt>
        <dd>{project.allowedModels?.join(', ') ?? 'every configured model'}</dd>
      </dl>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const list = allowed
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== '');
    save.mutate({ name: name.trim(), allowedModels: list.length === 0 ? null : list });
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

/** The largest value of a per-minute series, or null when the series is not per minute. */
function busiestMinute(window: { stepSeconds: number }, values: readonly number[]): number | null {
  return window.stepSeconds === 60 ? Math.max(0, ...values) : null;
}

/**
 * One limit as a tile: the limit, and when it is set and something was measured against it, a
 * meter of that measurement.
 */
function LimitTile({
  label,
  limit,
  unit,
  used,
  usedText,
}: {
  label: string;
  limit: string;
  unit?: string;
  /** Measured use as a share of the limit; null shows no meter. */
  used: number | null;
  /** What was measured, or why nothing was. */
  usedText: string;
}) {
  return (
    <div className="tile" role="group" aria-label={label}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {limit}
        {unit && <span className="muted small"> {unit}</span>}
      </div>
      {used !== null && <Meter share={used} label={`${label} used`} valueText={usedText} />}
      <div className="muted small">{usedText}</div>
    </div>
  );
}

/** The project's limits and budget as meters of what was measured, then the form to change them. */
function LimitsTab({ project }: { project: Project }) {
  const lastHour = { range: '1h' as const };
  // Per-minute series for the last hour; they share caches with the Overview and Cost pages.
  const overview = useQuery({
    queryKey: ['overview', project.id, lastHour],
    queryFn: ({ signal }) =>
      api<OverviewResponse>(analyticsPath('overview', project.id, lastHour), { signal }),
  });
  const cost = useQuery({
    queryKey: ['cost', project.id, lastHour],
    queryFn: ({ signal }) =>
      api<CostResponse>(analyticsPath('cost', project.id, lastHour), { signal }),
  });
  const { limits, budget } = project;

  const requests = overview.data
    ? busiestMinute(
        overview.data.window,
        overview.data.series.map((p) => p.requests - p.rejected),
      )
    : null;
  const tokens = cost.data
    ? busiestMinute(
        cost.data.window,
        cost.data.series.map((p) => p.totalTokens),
      )
    : null;
  const measured = (query: { isPending: boolean; isError: boolean }, value: number | null) =>
    query.isPending
      ? 'loading…'
      : query.isError || value === null
        ? 'use unavailable'
        : `busiest minute in the last hour: ${formatCount(value)}`;
  const share = (value: number | null, limit: number | null) =>
    value === null || limit === null ? null : value / limit;
  const spent = overview.data?.month.spentMicroUsd ?? null;

  return (
    <>
      <section className="card">
        <div className="card-header">
          <h2>Project limits</h2>
        </div>
        <div className="tiles">
          <LimitTile
            label="Requests per minute"
            limit={showLimit(limits.requestsPerMinute)}
            unit={limits.requestsPerMinute === null ? undefined : '/ min'}
            used={share(requests, limits.requestsPerMinute)}
            usedText={measured(overview, requests)}
          />
          <LimitTile
            label="Tokens per minute"
            limit={showLimit(limits.tokensPerMinute)}
            unit={limits.tokensPerMinute === null ? undefined : '/ min'}
            used={share(tokens, limits.tokensPerMinute)}
            usedText={measured(cost, tokens)}
          />
          <LimitTile
            label="Concurrent requests"
            limit={showLimit(limits.concurrentRequests)}
            unit={limits.concurrentRequests === null ? undefined : 'at once'}
            used={null}
            usedText="in-flight requests: not measured"
          />
          <LimitTile
            label="Monthly budget"
            limit={
              budget.monthlyLimitMicroUsd === null ? 'none' : formatUsd(budget.monthlyLimitMicroUsd)
            }
            used={
              spent === null || budget.monthlyLimitMicroUsd === null
                ? null
                : budgetUse(spent, budget.monthlyLimitMicroUsd)
            }
            usedText={
              overview.isPending
                ? 'loading…'
                : spent === null
                  ? 'spend unavailable'
                  : `${formatUsd(spent)} spent in ${overview.data?.month.period ?? ''} (UTC)`
            }
          />
          <LimitTile
            label="Most one request may cost"
            limit={
              budget.maxRequestCostMicroUsd === null
                ? 'no cap'
                : formatUsd(budget.maxRequestCostMicroUsd)
            }
            used={null}
            usedText="checked before each request, at its worst-case cost"
          />
        </div>
        <p className="muted small card-text">
          Limits cover all of the project&apos;s keys together; each key can have lower ones. The
          per-minute use is admitted requests and tokens per clock minute, not the limiter&apos;s
          own window.
        </p>
      </section>
      {canManage(project.role) && <LimitsForm project={project} />}
    </>
  );
}

function LimitsForm({ project }: { project: Project }) {
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
  const save = useSaveProject(project.id);

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
    save.mutate({
      limits: parsedLimits,
      budget: { monthlyLimitMicroUsd: monthly, maxRequestCostMicroUsd: perRequest },
    });
  };

  return (
    <section className="card">
      <h2>Change limits and budget</h2>
      <form className="form" onSubmit={submit} aria-label="Limits and budget">
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
            Save limits and budget
          </button>
        </div>
      </form>
    </section>
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
      <div className="card-header">
        <h2>Members</h2>
        {members.data && (
          <span className="muted small">{formatCount(members.data.data.length)} in all</span>
        )}
      </div>
      {isOwner ? (
        <form
          className="row add-row"
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
                <th>Member</th>
                <th>Role</th>
                <th>Since</th>
                {isOwner && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {members.data.data.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <div className="name-cell">
                      <span className="avatar" aria-hidden="true">
                        {initials(m.email)}
                      </span>
                      <span>
                        {m.email}
                        {m.userId === userId && <span className="muted small"> (you)</span>}
                      </span>
                    </div>
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
                      <span className={m.role === 'viewer' ? 'badge' : 'badge tone-accent'}>
                        {m.role}
                      </span>
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
      <p className="muted small card-text">
        Viewers see every page; admins also manage keys, limits and the project; owners also manage
        members.
      </p>
    </section>
  );
}

/** Deployments and routing policies, read-only: they come from the gateway's models file. */
function Routing({ catalog }: { catalog: ModelCatalog }) {
  return (
    <>
      <p className="muted small">
        Read from the gateway&apos;s models file at startup; edit that file to add or change models.
      </p>
      <h3>Models and routing policies</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Policy</th>
              <th>Targets, in order</th>
            </tr>
          </thead>
          <tbody>
            {catalog.models.map((m) => (
              <tr key={m.name}>
                <td className="strong">
                  {m.name}
                  {!m.available && <span className="badge alert-exceeded">unavailable</span>}
                </td>
                <td>
                  <span className="badge tone-accent">{m.policy}</span>
                </td>
                <td>
                  <ol className="targets">
                    {m.targets.map((t) => (
                      <li key={t.deployment}>
                        <span className="chip">
                          {m.policy === 'weighted' ? `${t.deployment} ×${t.weight}` : t.deployment}
                        </span>
                      </li>
                    ))}
                  </ol>
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
                <td className="strong">
                  {d.id}
                  {!d.enabled && <span className="badge alert-exceeded">disabled</span>}
                </td>
                <td>{d.provider}</td>
                <td className="mono">{d.providerModel}</td>
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
        className="row add-row"
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

export function Settings({
  projectId,
  userId,
  tab,
}: {
  projectId: string;
  userId: string;
  /** The tab from the URL, `#settings/<tab>`; null or unknown opens the first. */
  tab: string | null;
}) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: ({ signal }) => api<Project>(`/admin/projects/${projectId}`, { signal }),
  });
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  const current = settingsTab(tab);
  const data = project.data;

  // Every tab but Routing depends on the project (and the viewer's role in it).
  const needsProject = current !== 'routing';
  const gate =
    needsProject && !data ? (
      <section className="card" aria-busy={project.isPending}>
        {project.isError ? (
          <ErrorState error={project.error} retry={() => void project.refetch()} />
        ) : (
          <Loading what="project settings" />
        )}
      </section>
    ) : null;

  return (
    <Tabs label="Settings" tabs={TABS} current={current} href={(id) => `settings/${id}`}>
      {gate ??
        (current === 'project' && data ? (
          <>
            <section className="card">
              <div className="card-header">
                <h2>Project</h2>
              </div>
              <ProjectSummary project={data} />
              <ProjectForm
                key={data.updatedAt}
                project={data}
                models={catalog.data?.models.map((m) => m.name) ?? []}
              />
            </section>
            <NewProject />
          </>
        ) : current === 'limits' && data ? (
          <LimitsTab key={data.updatedAt} project={data} />
        ) : current === 'members' && data ? (
          <Members projectId={projectId} role={data.role} userId={userId} />
        ) : current === 'keys' && data ? (
          <ApiKeys projectId={projectId} role={data.role} />
        ) : (
          <QueryCard
            title="Deployments and routing"
            what="deployments"
            query={catalog}
            isEmpty={(c) => c.models.length === 0 && c.deployments.length === 0}
            empty="The models file configures no models or deployments."
          >
            {(c) => <Routing catalog={c} />}
          </QueryCard>
        ))}
    </Tabs>
  );
}
