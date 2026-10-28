/**
 * The provider behind a deployment, from its id: the models file names deployments
 * `<provider>-<model>` (`groq-gpt-oss-20b`, `gemini-3.5-flash-lite`). The dashboard names them
 * the same way. An id that follows no known prefix is shown as it is.
 */
const PROVIDERS: [prefix: string, name: string][] = [
  ['groq', 'Groq'],
  ['gemini', 'Gemini'],
  ['openai', 'OpenAI'],
  ['ollama', 'Ollama'],
  ['mock', 'Mock'],
];

export function providerName(deployment: string): string {
  const id = deployment.toLowerCase();
  const match = PROVIDERS.find(
    ([prefix]) => id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`),
  );
  return match ? match[1] : deployment;
}
