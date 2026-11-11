import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDocs,
  databaseTables,
  dataModelSection,
  missingSettings,
  missingTables,
  namesRoute,
  routesIn,
} from './check-docs.js';

describe('docs check', () => {
  it('finds /v1 and /admin registrations in source, and nothing else', () => {
    const code = `
      app.withTypeProvider<ZodTypeProvider>().post('/v1/chat/completions', { schema }, handler);
      routes.get(\`/admin/projects/:projectId/routes\`, opts, handler);
      routes.delete('/admin/projects/:projectId/members/:userId', opts, handler);
      app.get('/health', handler);
      redis.get('/v1/not-a-route' + key);
      cache.get(key);
      routes.get(\`\${base}/history\`, handler);
    `;
    expect(routesIn('x.ts', code).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /v1/chat/completions',
      'GET /admin/projects/:projectId/routes',
      'DELETE /admin/projects/:projectId/members/:userId',
    ]);
  });

  it('counts a route as named only with its method and the whole path', () => {
    const readme =
      '| `GET /admin/models/quotas` | any |\n`POST /v1/embeddings` and `GET /admin/analytics/requests?limit&cursor`';
    expect(namesRoute(readme, { method: 'GET', path: '/admin/models/quotas' })).toBe(true);
    expect(namesRoute(readme, { method: 'GET', path: '/admin/models' })).toBe(false);
    expect(namesRoute(readme, { method: 'POST', path: '/v1/embeddings' })).toBe(true);
    expect(namesRoute(readme, { method: 'GET', path: '/v1/embeddings' })).toBe(false);
    expect(namesRoute(readme, { method: 'GET', path: '/admin/analytics/requests' })).toBe(true);
  });

  it('names each setting missing from .env.example, set, commented out or described', () => {
    const env = '# RETRY_MAX_ATTEMPTS=3\nCACHE_ENABLED=false\n# Uses SEMANTIC_CACHE_ENABLED too.\n';
    expect(
      missingSettings(
        ['CACHE_ENABLED', 'RETRY_MAX_ATTEMPTS', 'SEMANTIC_CACHE_ENABLED', 'RETRY_MAX', 'NEW_ONE'],
        env,
      ),
    ).toEqual(['NEW_ONE', 'RETRY_MAX']);
  });

  it("names each table of the Database interface missing from the README's data model table", () => {
    const db = `
      interface Other { not_a_table: string }
      export interface Database {
        users: UsersTable;
        usage_rollups_hour: UsageRollupsTable;
        guardrail_results: GuardrailResultsTable;
      }`;
    expect(databaseTables(db)).toEqual(['users', 'usage_rollups_hour', 'guardrail_results']);
    const readme =
      '## Usage\n`guardrail_results` elsewhere\n### Data model\n| `users` | x |\n| `usage_rollups_minute`, `_hour` | y |\n### Security\n';
    expect(dataModelSection(readme)).not.toContain('Security');
    expect(missingTables(databaseTables(db), readme)).toEqual([
      'usage_rollups_hour',
      'guardrail_results',
    ]);
  });

  it('passes on this repository, having checked every setting, route and table', () => {
    const found = checkDocs(fileURLToPath(new URL('..', import.meta.url)));
    expect(found.settings).toEqual([]);
    expect(found.routes).toEqual([]);
    expect(found.tables).toEqual([]);
    expect(found.checked.settings).toBeGreaterThan(50);
    expect(found.checked.routes).toBeGreaterThan(40);
    expect(found.checked.tables).toBeGreaterThan(20);
  });
});
