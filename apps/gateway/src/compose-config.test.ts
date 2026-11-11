import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(new URL(`../../../infra/compose/${path}`, import.meta.url), 'utf8');

/**
 * A service's `environment:` mapping in a Compose file laid out as ours are (services at two
 * spaces, their keys at four, variables at six), read line by line.
 */
function serviceEnvironment(text: string, service: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`  ${service}:`);
  if (start < 0) throw new Error(`no service ${service}`);
  const env = new Map<string, string>();
  let inEnvironment = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break; // the next service or top-level key
    if (/^ {4}\S/.test(line)) {
      inEnvironment = line.trim() === 'environment:';
      continue;
    }
    const variable = inEnvironment ? /^ {6}([A-Z0-9_]+):\s*(.*)$/.exec(line) : null;
    if (variable) env.set(variable[1]!, variable[2]!.trim());
  }
  return env;
}

describe('Compose: the webhook alert key (ADR 033)', () => {
  const compose = read('docker-compose.yml');
  // The gateway encrypts destination URLs and the worker decrypts them: with a key derived from
  // API_KEY_PEPPER unless ALERTS_ENCRYPTION_KEY is set, so both need both, from the same source.
  it.each(['API_KEY_PEPPER', 'ALERTS_ENCRYPTION_KEY'])(
    'gives the gateway and the worker %s from the same variable',
    (name) => {
      const gateway = serviceEnvironment(compose, 'gateway').get(name);
      const worker = serviceEnvironment(compose, 'worker').get(name);
      expect(gateway, `gateway ${name}`).toMatch(new RegExp(`^\\$\\{${name}(:-[^}]*)?\\}$`));
      expect(worker, `worker ${name}`).toBe(gateway);
    },
  );

  it('is not overridden for one service only by the AWS demo layer', () => {
    const demo = read('aws-demo.yml');
    expect(demo).not.toContain('API_KEY_PEPPER');
    expect(demo).not.toContain('ALERTS_ENCRYPTION_KEY');
  });

  it('reads a service environment as Compose does', () => {
    const env = serviceEnvironment(compose, 'worker');
    expect(env.get('REDIS_URL')).toBe('redis://redis:6379');
    expect(env.has('OLLAMA_BASE_URL')).toBe(false); // the gateway's, not the worker's
  });
});
