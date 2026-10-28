import { useQuery } from '@tanstack/react-query';
import { FlaskConical, type LucideIcon } from 'lucide-react';
import { useCallback } from 'react';
import { api, type ModelCatalog } from '../api.js';
import { CATEGORICAL } from '../charts/theme.js';
import { modelFamily, type ModelFamily } from './logos/families.js';
import { LOGOS, type Logo } from './logos/logos.js';

export { modelFamily, type ModelFamily };

/** Who serves a deployment, as far as the API's data tells. */
export interface ProviderInfo {
  /** A stable id: a known provider's, or `unknown:<name>`. */
  id: string;
  name: string;
  /** Up to two letters for the tile shown in place of a logo. */
  initials: string;
  /** A chart colour token, fixed per provider so it is the same on every page. */
  color: string;
  /** The provider's logo (see ui/logos/NOTICE.md); unknown providers have none. */
  logo?: Logo;
  /** A neutral icon instead of a logo: the mock provider is not a company. */
  icon?: LucideIcon;
}

const KNOWN = {
  groq: { id: 'groq', name: 'Groq', initials: 'GQ', color: 'var(--chart-4)', logo: LOGOS.groq },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    initials: 'GE',
    color: 'var(--chart-3)',
    logo: LOGOS.gemini,
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    initials: 'OA',
    color: 'var(--chart-1)',
    logo: LOGOS.openai,
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    initials: 'OL',
    color: 'var(--chart-2)',
    logo: LOGOS.ollama,
  },
  mock: { id: 'mock', name: 'Mock', initials: 'MO', color: 'var(--chart-5)', icon: FlaskConical },
} satisfies Record<string, ProviderInfo>;

/** The model's family when it differs from the provider serving it; null otherwise. */
export function familyOnHost(
  provider: ProviderInfo,
  model: string | null | undefined,
): ModelFamily | null {
  const family = modelFamily(model);
  return family && family.id !== provider.id ? family : null;
}

/** What the API says about a deployment: its provider kind, and its id and model when known. */
export interface DeploymentFacts {
  /** The adapter kind: `mock`, `ollama` or `openai-compatible`. */
  provider: string;
  /** The deployment id from the models file, e.g. `groq-gpt-oss-20b`. */
  deployment?: string | null;
  /** The provider's own model name, e.g. `openai/gpt-oss-20b`. */
  model?: string | null;
}

/** A tile for a provider the dashboard does not know: its name's initials, in a fixed colour. */
export function unknownProvider(name: string): ProviderInfo {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  const sum = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  return {
    id: `unknown:${name}`,
    name,
    initials: (letters.slice(0, 2) || '?').toUpperCase(),
    color: CATEGORICAL[sum % CATEGORICAL.length] ?? CATEGORICAL[0],
  };
}

/**
 * The provider behind a deployment. The admin API returns the adapter kind, the deployment id and
 * the provider's model name, not the base URL, so an `openai-compatible` deployment is named from
 * its id first (the models file names them `groq-…`, `gemini-…`, `openai-…`), then its model.
 * Anything not recognised gets a neutral tile rather than a guess.
 */
export function identifyProvider({ provider, deployment, model }: DeploymentFacts): ProviderInfo {
  if (provider === 'mock') return KNOWN.mock;
  if (provider === 'ollama') return KNOWN.ollama;
  if (provider !== 'openai-compatible') return unknownProvider(provider);

  const id = (deployment ?? '').toLowerCase();
  const name = (model ?? '').toLowerCase();
  for (const key of ['groq', 'gemini', 'openai', 'mock'] as const) {
    if (id === key || id.startsWith(`${key}-`) || id.startsWith(`${key}.`)) return KNOWN[key];
  }
  if (name.startsWith('gemini-')) return KNOWN.gemini;
  // OpenAI's own model names; "openai/…" names are open-weight models hosted elsewhere.
  if (/^(gpt-|chatgpt-|o\d)/.test(name)) return KNOWN.openai;
  return unknownProvider('OpenAI-compatible');
}

/**
 * Names the provider of a deployment by id, using the model catalog for the provider's model
 * name. The catalog query is shared with the Models and Settings pages. The provider carries the
 * model's family (`family`) when it differs from the host.
 */
export function useProviderOf(): (
  provider: string,
  deployment?: string | null,
) => ProviderInfo & { family: ModelFamily | null } {
  const catalog = useQuery({
    queryKey: ['catalog'],
    queryFn: ({ signal }) => api<ModelCatalog>('/admin/models', { signal }),
  });
  const deployments = catalog.data?.deployments;
  return useCallback(
    (provider: string, deployment?: string | null) => {
      const model = deployments?.find((d) => d.id === deployment)?.providerModel;
      const info = identifyProvider({ provider, deployment, model });
      // Without the catalog, the deployment id usually names the model (groq-qwen3.8-27b).
      return { ...info, family: familyOnHost(info, model ?? deployment) };
    },
    [deployments],
  );
}
