import { modelFamily, type ModelFamily } from '../../dashboard/src/ui/logos/families.js';
import { LOGOS, type Logo } from '../../dashboard/src/ui/logos/logos.js';

/**
 * The provider behind a deployment, from its id: the models file names deployments
 * `<provider>-<model>` (`groq-gpt-oss-20b`, `gemini-3.5-flash-lite`). The dashboard names them
 * the same way, and both use the same bundled logos (dashboard/src/ui/logos/NOTICE.md).
 */
const PROVIDERS: { prefix: string; name: string; logo: Logo | null }[] = [
  { prefix: 'groq', name: 'Groq', logo: LOGOS.groq },
  { prefix: 'gemini', name: 'Gemini', logo: LOGOS.gemini },
  { prefix: 'openai', name: 'OpenAI', logo: LOGOS.openai },
  { prefix: 'ollama', name: 'Ollama', logo: LOGOS.ollama },
  // The mock is not a company: it gets a neutral icon instead (see Conversation).
  { prefix: 'mock', name: 'Mock', logo: null },
];

export interface ServedBy {
  /** The provider's name, or the deployment id when no prefix is known. */
  name: string;
  logo: Logo | null;
  known: boolean;
  /** The model's family when it differs from the provider (Qwen on Groq), else null. */
  family: ModelFamily | null;
}

function find(deployment: string) {
  const id = deployment.toLowerCase();
  return PROVIDERS.find(
    ({ prefix }) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`),
  );
}

export function providerName(deployment: string): string {
  return find(deployment)?.name ?? deployment;
}

export function servedBy(deployment: string): ServedBy {
  const provider = find(deployment);
  const family = modelFamily(deployment);
  return {
    name: provider?.name ?? deployment,
    logo: provider?.logo ?? null,
    known: provider !== undefined,
    family: family && family.id !== provider?.prefix ? family : null,
  };
}
