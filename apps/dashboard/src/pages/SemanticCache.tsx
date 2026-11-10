import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  api,
  canManage,
  type Role,
  type SemanticPolicy,
  type SemanticSettings,
  type SemanticSummary,
} from '../api.js';
import { formatCount, formatUsd } from '../format.js';
import { QueryCard } from '../ui/QueryCard.js';
import { ErrorState, Loading } from '../ui/states.js';

const MODES: { id: SemanticPolicy['mode']; label: string }[] = [
  { id: 'off', label: 'off' },
  { id: 'header', label: 'only requests sending x-gateway-semantic-cache: on' },
  { id: 'all', label: 'every eligible request (unless it sends off)' },
];

/**
 * The project's semantic cache settings (ADR 040): the mode, the similarity a hit needs, how long
 * answers are kept and how many. Admins edit; viewers read.
 */
export function SemanticCacheSettings({ projectId, role }: { projectId: string; role: Role }) {
  const query = useQuery({
    queryKey: ['semantic-cache', projectId],
    queryFn: ({ signal }) =>
      api<SemanticSettings>(`/admin/projects/${projectId}/semantic-cache`, { signal }),
  });
  if (query.isPending) return <Loading what="semantic cache settings" />;
  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <section className="card">
      <div className="card-header">
        <h2>Semantic cache</h2>
      </div>
      <SemanticForm
        key={JSON.stringify(query.data.policy)}
        projectId={projectId}
        editable={canManage(role)}
        settings={query.data}
      />
    </section>
  );
}

function SemanticForm({
  projectId,
  editable,
  settings,
}: {
  projectId: string;
  editable: boolean;
  settings: SemanticSettings;
}) {
  const client = useQueryClient();
  const initial = settings.policy;
  const [mode, setMode] = useState(initial.mode);
  const [threshold, setThreshold] = useState(
    initial.threshold === null ? '' : String(initial.threshold),
  );
  const [ttl, setTtl] = useState(String(initial.ttlSeconds));
  const [cap, setCap] = useState(String(initial.maxEntries));
  const save = useMutation({
    mutationFn: () =>
      api(`/admin/projects/${projectId}/semantic-cache`, {
        method: 'PUT',
        body: {
          mode,
          threshold: threshold.trim() === '' ? null : Number(threshold),
          ttlSeconds: Number(ttl),
          maxEntries: Number(cap),
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['semantic-cache', projectId] }),
  });
  const disabled = !editable;
  return (
    <form
      className="guardrail-form card-text"
      aria-label="Semantic cache"
      onSubmit={(e) => {
        e.preventDefault();
        if (editable) save.mutate();
      }}
    >
      {!settings.enabled ? (
        <p className="muted small">
          The semantic cache is off on this gateway (SEMANTIC_CACHE_ENABLED).
        </p>
      ) : !settings.available ? (
        <p className="muted small">
          The database has no pgvector, so the semantic cache cannot run on this gateway.
        </p>
      ) : (
        <p className="muted small">Embeddings model: {settings.embeddingModel}.</p>
      )}
      <div className="row">
        <label className="route-field">
          <span>Mode</span>
          <select
            aria-label="Semantic cache mode"
            value={mode}
            disabled={disabled}
            onChange={(e) => setMode(e.target.value as SemanticPolicy['mode'])}
          >
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="route-field">
          <span>Similarity a hit needs (empty: {settings.defaultThreshold})</span>
          <input
            type="number"
            aria-label="Similarity threshold"
            min={0.5}
            max={1}
            step={0.001}
            value={threshold}
            disabled={disabled}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </label>
        <label className="route-field">
          <span>Keep answers for (seconds)</span>
          <input
            type="number"
            aria-label="Answer lifetime in seconds"
            min={60}
            value={ttl}
            disabled={disabled}
            onChange={(e) => setTtl(e.target.value)}
          />
        </label>
        <label className="route-field">
          <span>Most stored answers</span>
          <input
            type="number"
            aria-label="Most stored answers"
            min={1}
            value={cap}
            disabled={disabled}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
      </div>
      <p className="muted small">
        Only requests the exact cache would take (temperature 0, or x-gateway-cache: on) whose last
        message is text from the user, after an exact-cache miss. A hit needs the same model, system
        prompt, earlier messages and parameters, and a last message at least this similar. Every
        lookup makes an embedding call, hit or miss. Lower thresholds also answer requests that only
        look alike (miles to kilometres for kilometres to miles): see the measured false-hit rates
        in the README.
      </p>
      {editable ? (
        <div className="row">
          <button type="submit" className="primary" disabled={save.isPending}>
            Save semantic cache
          </button>
        </div>
      ) : (
        <p className="muted small">Only admins change the semantic cache.</p>
      )}
      {save.isError && <ErrorState error={save.error} />}
      {save.isSuccess && !save.isPending && <p className="muted small">Saved.</p>}
    </form>
  );
}

/** List and billed cost, as the Cost page shows them. */
const both = (m: { listMicroUsd: number; billedMicroUsd: number }) =>
  `${formatUsd(m.listMicroUsd)} list · ${formatUsd(m.billedMicroUsd)} billed`;

/**
 * What the semantic cache did in the range (ADR 040): hits, misses and errors, the embedding calls
 * every lookup paid for, the cost the hits avoided, and the net of the two.
 */
export function SemanticCacheSummary({ projectId, range }: { projectId: string; range: string }) {
  const query = useQuery({
    queryKey: ['semantic-cache-summary', projectId, range],
    queryFn: ({ signal }) =>
      api<SemanticSummary>(
        `/admin/projects/${projectId}/semantic-cache/summary?range=${encodeURIComponent(range)}`,
        { signal },
      ),
  });
  return (
    <QueryCard
      title="Semantic cache"
      what="the semantic cache summary"
      query={query}
      isEmpty={(s) => s.lookups.hit + s.lookups.miss + s.lookups.error === 0}
      empty={`No semantic cache lookups in the last ${range}.`}
    >
      {(s) => (
        <div className="table-wrap">
          <table aria-label="Semantic cache summary">
            <tbody>
              <tr>
                <th scope="row">Lookups</th>
                <td>
                  {formatCount(s.lookups.hit)} hits · {formatCount(s.lookups.miss)} misses ·{' '}
                  {formatCount(s.lookups.error)} errors
                  {s.hitSimilarity !== null &&
                    ` · mean hit similarity ${s.hitSimilarity.toFixed(3)}`}
                </td>
              </tr>
              <tr>
                <th scope="row">Embedding calls (hits and misses)</th>
                <td>
                  {both(s.embedding)} · {formatCount(s.embedding.tokens)} tokens
                  {s.embedding.unpriced > 0 && ` · ${formatCount(s.embedding.unpriced)} unpriced`}
                </td>
              </tr>
              <tr>
                <th scope="row">Cost the hits avoided</th>
                <td>
                  {both(s.avoided)}
                  {s.avoided.unpriced > 0 && ` · ${formatCount(s.avoided.unpriced)} unpriced`}
                </td>
              </tr>
              <tr>
                <th scope="row">Net saving</th>
                <td>{both(s.net)}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small card-text">
            The net saving is the cost the hits avoided (their stored answers&apos; tokens at the
            answering model&apos;s price) less every embedding call; it is negative when lookups
            cost more than hits saved. Embedding calls count toward the budget but not the spend
            chart above.
          </p>
        </div>
      )}
    </QueryCard>
  );
}
