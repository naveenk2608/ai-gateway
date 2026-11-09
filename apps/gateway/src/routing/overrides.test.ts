import { systemClock } from '@ai-gateway/shared';
import type { Db } from '@ai-gateway/shared/node';
import { describe, expect, it } from 'vitest';
import { captureLogger } from '../../test/helpers.js';
import type { ModelRoute } from '../models-config.js';
import type { Deployment, Route } from '../providers/registry.js';
import { overrideIssues, RouteOverrides, routeOverrideSchema } from './overrides.js';

const file: ModelRoute = {
  policy: 'priority',
  targets: [
    { deployment: 'a', weight: 1, lastResort: false },
    { deployment: 'b', weight: 1, lastResort: false },
    { deployment: 'mock', weight: 1, lastResort: true },
  ],
};

describe('routeOverrideSchema and overrideIssues', () => {
  it("accepts a reordered, reweighted route over the file's deployments", () => {
    const parsed = routeOverrideSchema.parse({
      policy: 'weighted',
      targets: [{ deployment: 'b', weight: 3 }, { deployment: 'a' }],
    });
    expect(parsed.targets).toEqual([
      { deployment: 'b', weight: 3, lastResort: false },
      { deployment: 'a', weight: 1, lastResort: false },
    ]);
    expect(overrideIssues(file, parsed)).toEqual([]);
  });

  it('names a deployment the file does not list for the model, and one listed twice', () => {
    expect(
      overrideIssues(file, {
        policy: 'priority',
        targets: [
          { deployment: 'a', weight: 1, lastResort: false },
          { deployment: 'z', weight: 1, lastResort: false },
          { deployment: 'a', weight: 1, lastResort: false },
        ],
      }),
    ).toEqual([
      'targets[1]: "z" is not a deployment of this model in the models file (allowed: a, b, mock)',
      'targets[2]: "a" is listed twice',
    ]);
  });

  it('refuses an unknown policy, no targets, a weight out of range and unknown fields', () => {
    const bad = [
      { policy: 'fastest', targets: [{ deployment: 'a' }] },
      { policy: 'priority', targets: [] },
      { policy: 'weighted', targets: [{ deployment: 'a', weight: 0 }] },
      { policy: 'priority', targets: [{ deployment: 'a', baseUrl: 'https://x' }] },
      { policy: 'priority', targets: [{ deployment: 'a' }], apiKey: 'x' },
    ];
    for (const body of bad) expect(routeOverrideSchema.safeParse(body).success).toBe(false);
  });
});

describe('RouteOverrides.apply', () => {
  const deployment = (id: string) => ({ id }) as unknown as Deployment;
  // `b` is not enabled on this gateway (its key is unset), so the route has a and mock only.
  const route: Route = {
    model: 'm',
    type: 'chat',
    policy: 'priority',
    targets: [
      { deployment: deployment('a'), weight: 1, lastResort: false },
      { deployment: deployment('mock'), weight: 1, lastResort: true },
    ],
  };

  function store(active: Record<string, ModelRoute>, enabled = true) {
    const rows = Object.entries(active).map(([model, r]) => ({ project_id: 'p', model, route: r }));
    // Answers the store's one query with the rows above.
    const db = {
      getExecutor: () => ({
        transformQuery: (node: unknown) => node,
        compileQuery: (node: unknown) => ({ sql: '', parameters: [], query: node }),
        executeQuery: () => Promise.resolve({ rows }),
      }),
    } as unknown as Db;
    return new RouteOverrides(
      { enabled, refreshMs: 60_000 },
      { db, logger: captureLogger().logger, clock: systemClock },
    );
  }

  it("uses the override's policy and order, keeping only enabled deployments", async () => {
    const overrides = store({
      m: {
        policy: 'weighted',
        targets: [
          { deployment: 'mock', weight: 1, lastResort: false },
          { deployment: 'b', weight: 5, lastResort: false },
          { deployment: 'a', weight: 2, lastResort: false },
        ],
      },
    });
    await overrides.reloadAll();
    const applied = overrides.apply('p', route);
    expect(applied.policy).toBe('weighted');
    expect(applied.targets.map((t) => [t.deployment.id, t.weight, t.lastResort])).toEqual([
      ['mock', 1, false],
      ['a', 2, false],
    ]);
    // Another project, and another model, keep the file's route.
    expect(overrides.apply('other', route)).toBe(route);
    expect(overrides.apply('p', { ...route, model: 'n' })).toEqual({ ...route, model: 'n' });
  });

  it("keeps the file's route when none of the override's deployments is enabled, or when off", async () => {
    const only = {
      policy: 'priority' as const,
      targets: [{ deployment: 'b', weight: 1, lastResort: false }],
    };
    const overrides = store({ m: only });
    await overrides.reloadAll();
    expect(overrides.apply('p', route)).toBe(route);
    const off = store({ m: only }, false);
    await off.reloadAll();
    expect(off.apply('p', route)).toBe(route);
  });
});
