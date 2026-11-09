import type { Clock } from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';
import { sql } from 'kysely';
import { z } from 'zod';
import { ROUTING_POLICIES, type ModelRoute } from '../models-config.js';
import type { Route } from '../providers/registry.js';

/**
 * A route as a project admin may set it (ADR 034): the models file's rules for a route's targets
 * (1 to 10, weights 1 to 1,000, last resort), with any policy. Which deployments it may use is
 * checked against the file's route (`overrideIssues`).
 */
export const routeOverrideSchema = z
  .object({
    policy: z.enum(ROUTING_POLICIES),
    targets: z
      .array(
        z
          .object({
            deployment: z.string().min(1).max(128),
            weight: z.number().int().min(1).max(1_000).default(1),
            lastResort: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict();

/** Why an override cannot replace the file's route: only its deployments, each once. */
export function overrideIssues(file: ModelRoute, override: ModelRoute): string[] {
  const allowed = new Set(file.targets.map((t) => t.deployment));
  const seen = new Set<string>();
  const issues: string[] = [];
  override.targets.forEach((t, i) => {
    if (!allowed.has(t.deployment)) {
      issues.push(
        `targets[${i}]: "${t.deployment}" is not a deployment of this model in the models file ` +
          `(allowed: ${[...allowed].join(', ')})`,
      );
    }
    if (seen.has(t.deployment)) issues.push(`targets[${i}]: "${t.deployment}" is listed twice`);
    seen.add(t.deployment);
  });
  return issues;
}

export interface RouteOverrideSettings {
  /** Off: every project uses the models file's routes (ROUTE_OVERRIDES_ENABLED). */
  enabled: boolean;
  /** How often every override is read again, in case a reload message was lost. */
  refreshMs: number;
}

/**
 * Each project's active route overrides on this instance (ADR 034): the highest version per
 * (project, model) in `route_overrides`, unless it is a reset. Loaded at start (if Postgres is
 * down, the models file applies and loading is retried), reloaded for one project when a `routes`
 * message arrives on the invalidation channel, and reloaded in full every `refreshMs`.
 */
export class RouteOverrides {
  readonly settings: RouteOverrideSettings;
  readonly #o: { db: Db; logger: Logger; clock: Clock };
  #active = new Map<string, Map<string, ModelRoute>>();
  readonly #stop = new AbortController();
  #loop: Promise<void> | undefined;

  constructor(settings: RouteOverrideSettings, deps: { db: Db; logger: Logger; clock: Clock }) {
    this.settings = settings;
    this.#o = deps;
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  start(): void {
    if (!this.settings.enabled || this.#loop) return;
    this.#loop = (async () => {
      while (!this.#stop.signal.aborted) {
        await this.reloadAll();
        try {
          await this.#o.clock.sleep(this.settings.refreshMs, this.#stop.signal);
        } catch {
          return;
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    await this.#loop;
  }

  /** Reads every active override; on failure keeps what it had (logged). Never throws. */
  async reloadAll(): Promise<void> {
    if (!this.settings.enabled) return;
    try {
      const rows = await sql<{ project_id: string; model: string; route: ModelRoute | null }>`
        SELECT DISTINCT ON (project_id, model) project_id, model, route
          FROM route_overrides
         ORDER BY project_id, model, version DESC`.execute(this.#o.db);
      const next = new Map<string, Map<string, ModelRoute>>();
      for (const r of rows.rows) {
        if (r.route === null) continue;
        const project = next.get(r.project_id) ?? new Map<string, ModelRoute>();
        project.set(r.model, r.route);
        next.set(r.project_id, project);
      }
      this.#active = next;
    } catch (err) {
      this.#o.logger.warn({ err }, 'route overrides could not be loaded; keeping the last ones');
    }
  }

  /** Reads one project's active overrides. Never throws. */
  async reloadProject(projectId: string): Promise<void> {
    if (!this.settings.enabled) return;
    try {
      const rows = await sql<{ model: string; route: ModelRoute | null }>`
        SELECT DISTINCT ON (model) model, route
          FROM route_overrides
         WHERE project_id = ${projectId}
         ORDER BY model, version DESC`.execute(this.#o.db);
      const project = new Map<string, ModelRoute>();
      for (const r of rows.rows) if (r.route !== null) project.set(r.model, r.route);
      const next = new Map(this.#active);
      if (project.size > 0) next.set(projectId, project);
      else next.delete(projectId);
      this.#active = next;
    } catch (err) {
      this.#o.logger.warn({ err, projectId }, 'route overrides could not be reloaded');
    }
  }

  /** The project's active override of `model`, if any. */
  active(projectId: string, model: string): ModelRoute | undefined {
    return this.#active.get(projectId)?.get(model);
  }

  /**
   * The route this project uses: its override (policy and targets, in its order) applied to the
   * file's route, keeping only deployments the file's route has enabled; the file's route when
   * there is no override or none of its deployments is enabled.
   */
  apply(projectId: string, route: Route): Route {
    if (!this.settings.enabled) return route;
    const override = this.active(projectId, route.model);
    if (!override) return route;
    const byId = new Map(route.targets.map((t) => [t.deployment.id, t.deployment]));
    const targets = override.targets.flatMap((t) => {
      const deployment = byId.get(t.deployment);
      return deployment ? [{ deployment, weight: t.weight, lastResort: t.lastResort }] : [];
    });
    if (targets.length === 0) return route;
    return { ...route, policy: override.policy, targets };
  }
}
