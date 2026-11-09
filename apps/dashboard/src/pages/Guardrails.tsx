import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  ApiError,
  canManage,
  type AnalyticsFilters,
  type GuardrailPolicy,
  type GuardrailResults,
  type GuardrailSummary,
  type Role,
} from '../api.js';
import { formatCount, formatTime } from '../format.js';
import { Empty, ErrorState, Loading } from '../ui/states.js';

const TYPES: { id: keyof GuardrailPolicy['input']; label: string }[] = [
  { id: 'email', label: 'Email addresses' },
  { id: 'phone', label: 'Phone numbers (Indian mobile, E.164)' },
  { id: 'card', label: 'Payment card numbers (Luhn)' },
  { id: 'aadhaar', label: 'Aadhaar numbers (Verhoeff)' },
  { id: 'pan', label: 'PAN' },
];
const INPUT_ACTIONS = ['off', 'mask', 'block', 'flag'] as const;
const OUTPUT_ACTIONS = ['off', 'mask', 'flag'] as const;
const SCHEMA_ACTIONS = ['off', 'flag', 'retry'] as const;
const RESULT_ACTIONS = ['block', 'flag', 'mask', 'retry', 'fail'] as const;

const CHECK_LABELS: Record<string, string> = {
  email: 'email',
  phone: 'phone',
  card: 'card',
  aadhaar: 'Aadhaar',
  pan: 'PAN',
  blocked_terms: 'blocked words',
  prompt_size: 'prompt size',
  schema: 'JSON schema',
};

/**
 * The project's guardrails (ADR 035): checks before the model (detectors, blocked words, a prompt
 * cap) and after it (JSON schema, detectors on answers). Admins edit; viewers read.
 */
export function GuardrailSettings({ projectId, role }: { projectId: string; role: Role }) {
  const query = useQuery({
    queryKey: ['guardrails', projectId],
    queryFn: ({ signal }) =>
      api<{ enabled: boolean; policy: GuardrailPolicy }>(
        `/admin/projects/${projectId}/guardrails`,
        {
          signal,
        },
      ),
  });
  if (query.isPending) return <Loading what="guardrails" />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <GuardrailForm
      key={JSON.stringify(query.data.policy)}
      projectId={projectId}
      editable={canManage(role)}
      enabled={query.data.enabled}
      initial={query.data.policy}
    />
  );
}

function GuardrailForm({
  projectId,
  editable,
  enabled,
  initial,
}: {
  projectId: string;
  editable: boolean;
  enabled: boolean;
  initial: GuardrailPolicy;
}) {
  const client = useQueryClient();
  const [policy, setPolicy] = useState(initial);
  const [terms, setTerms] = useState(initial.blockedTerms.terms.join('\n'));
  const [cap, setCap] = useState(
    initial.maxPromptTokens === null ? '' : String(initial.maxPromptTokens),
  );
  const save = useMutation({
    mutationFn: () =>
      api(`/admin/projects/${projectId}/guardrails`, {
        method: 'PUT',
        body: {
          ...policy,
          blockedTerms: {
            ...policy.blockedTerms,
            terms: terms
              .split('\n')
              .map((t) => t.trim())
              .filter((t) => t !== ''),
          },
          maxPromptTokens: cap.trim() === '' ? null : Number(cap),
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['guardrails', projectId] }),
  });
  const setInput = (id: keyof GuardrailPolicy['input'], value: string) =>
    setPolicy({ ...policy, input: { ...policy.input, [id]: value } });
  const setOutput = (id: string, value: string) =>
    setPolicy({ ...policy, output: { ...policy.output, [id]: value } });
  const disabled = !editable;

  return (
    <form
      className="guardrail-form"
      aria-label="Guardrails"
      onSubmit={(e) => {
        e.preventDefault();
        if (editable) save.mutate();
      }}
    >
      {!enabled && (
        <p className="muted small">Guardrails are off on this gateway (GUARDRAILS_ENABLED).</p>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Detector</th>
              <th>Before the model</th>
              <th>On answers</th>
            </tr>
          </thead>
          <tbody>
            {TYPES.map((t) => (
              <tr key={t.id}>
                <td>{t.label}</td>
                <td>
                  <select
                    aria-label={`${t.label} before the model`}
                    value={policy.input[t.id]}
                    disabled={disabled}
                    onChange={(e) => setInput(t.id, e.target.value)}
                  >
                    {INPUT_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`${t.label} on answers`}
                    value={policy.output[t.id]}
                    disabled={disabled}
                    onChange={(e) => setOutput(t.id, e.target.value)}
                  >
                    {OUTPUT_ACTIONS.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="route-field">
        <span>Blocked words and phrases, one per line (whole words, any case)</span>
        <textarea
          aria-label="Blocked words and phrases"
          rows={3}
          value={terms}
          disabled={disabled}
          onChange={(e) => setTerms(e.target.value)}
        />
      </label>
      <div className="row">
        <label className="route-field">
          <span>When one is found</span>
          <select
            aria-label="Blocked words action"
            value={policy.blockedTerms.action}
            disabled={disabled}
            onChange={(e) =>
              setPolicy({
                ...policy,
                blockedTerms: {
                  ...policy.blockedTerms,
                  action: e.target.value as 'block' | 'flag',
                },
              })
            }
          >
            <option>block</option>
            <option>flag</option>
          </select>
        </label>
        <label className="route-field">
          <span>Most prompt tokens (empty: no cap)</span>
          <input
            type="number"
            aria-label="Most prompt tokens"
            min={1}
            value={cap}
            disabled={disabled}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <label className="route-field">
          <span>JSON answers that break their schema</span>
          <select
            aria-label="JSON schema check"
            value={policy.output.schema}
            disabled={disabled}
            onChange={(e) => setOutput('schema', e.target.value)}
          >
            {SCHEMA_ACTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        mask: replaced by a placeholder such as [EMAIL] before the provider sees it; block: the
        request gets a 400 naming the type; flag: recorded only. retry: one more try on the next
        deployment, then a 502. Values found are never stored: only their types and counts.
      </p>
      {editable ? (
        <div className="row">
          <button type="submit" className="primary" disabled={save.isPending}>
            Save guardrails
          </button>
        </div>
      ) : (
        <p className="muted small">Only admins change guardrails.</p>
      )}
      {save.error && (
        <p className="error-text" role="alert">
          {save.error instanceof ApiError ? save.error.message : 'The change failed.'}
        </p>
      )}
    </form>
  );
}

/** Requests the guardrails flagged, blocked, masked or retried, with filters. */
export function GuardrailResultsTable({
  projectId,
  filters,
}: {
  projectId: string;
  filters: AnalyticsFilters;
}) {
  const [action, setAction] = useState('');
  const [check, setCheck] = useState('');
  const params = new URLSearchParams({ range: filters.range });
  if (action) params.set('action', action);
  if (check) params.set('check', check);
  const results = useQuery({
    queryKey: ['guardrail-results', projectId, filters.range, action, check],
    queryFn: ({ signal }) =>
      api<GuardrailResults>(`/admin/projects/${projectId}/guardrails/results?${params}`, {
        signal,
      }),
    refetchInterval: 30_000,
  });
  return (
    <>
      <div className="filters" role="group" aria-label="Guardrail filters">
        <label>
          Action
          <select aria-label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">all</option>
            {RESULT_ACTIONS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label>
          Check
          <select aria-label="Check" value={check} onChange={(e) => setCheck(e.target.value)}>
            <option value="">all</option>
            {Object.entries(CHECK_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {results.isPending ? (
        <Loading what="guardrail results" />
      ) : results.isError ? (
        <ErrorState error={results.error} retry={() => void results.refetch()} />
      ) : results.data.data.length === 0 ? (
        <Empty>{`No request in the last ${filters.range} matched a guardrail.`}</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Request</th>
                <th>Stage</th>
                <th>Check</th>
                <th>Found</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {results.data.data.map((r) => (
                <tr key={`${r.requestId}/${r.stage}/${r.check}/${r.action}`}>
                  <td className="small">{formatTime(r.createdAt)}</td>
                  <td>
                    <a className="mono small" href={`#requests/${r.requestId}`}>
                      {r.requestId.slice(-8)}
                    </a>
                    {r.model && <span className="muted small block">{r.model}</span>}
                  </td>
                  <td>{r.stage === 'input' ? 'before' : 'after'}</td>
                  <td>{CHECK_LABELS[r.check] ?? r.check}</td>
                  <td className="num">{formatCount(r.findings)}</td>
                  <td>
                    <span
                      className={`badge ${r.action === 'block' || r.action === 'fail' ? 'status-error' : r.action === 'mask' ? 'tone-accent' : ''}`}
                    >
                      {r.action}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** How many requests the guardrails blocked, flagged and masked in the range (Overview). */
export function GuardrailCounts({
  projectId,
  filters,
}: {
  projectId: string;
  filters: AnalyticsFilters;
}) {
  const summary = useQuery({
    queryKey: ['guardrail-summary', projectId, filters.range],
    queryFn: ({ signal }) =>
      api<GuardrailSummary>(
        `/admin/projects/${projectId}/guardrails/summary?range=${filters.range}`,
        { signal },
      ),
    refetchInterval: 30_000,
  });
  return (
    <section className="card" aria-busy={summary.isPending}>
      <div className="card-header">
        <h2>Guardrails, last {filters.range}</h2>
        <a className="card-link" href="#security">
          Security
        </a>
      </div>
      {summary.isError ? (
        <ErrorState error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <dl className="facts">
          <dt>Blocked</dt>
          <dd>{summary.data ? formatCount(summary.data.requests.blocked) : '…'}</dd>
          <dt>Flagged</dt>
          <dd>{summary.data ? formatCount(summary.data.requests.flagged) : '…'}</dd>
          <dt>Masked</dt>
          <dd>{summary.data ? formatCount(summary.data.requests.masked) : '…'}</dd>
        </dl>
      )}
    </section>
  );
}
