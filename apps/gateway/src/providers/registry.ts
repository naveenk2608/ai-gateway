import type { Clock } from '@ai-gateway/shared';
import type { Logger } from '@ai-gateway/shared/node';
import type { DeploymentConfig, ModelsConfig } from '../models-config.js';
import { MockProvider } from './mock.js';
import type { Provider } from './types.js';

/** One configured upstream: a provider instance plus the model and timeouts to use with it. */
export interface Deployment {
  id: string;
  provider: Provider;
  /** The provider's model name, sent upstream. */
  providerModel: string;
  timeoutMs: number;
  streamIdleTimeoutMs: number;
}

export interface RegistryDeps {
  clock: Clock;
  logger: Logger;
}

export class ProviderRegistry {
  readonly #deployments: Map<string, Deployment>;
  readonly #models: Map<string, Deployment>;

  constructor(deployments: Map<string, Deployment>, models: Map<string, Deployment>) {
    this.#deployments = deployments;
    this.#models = models;
  }

  /** The deployment serving a logical model name, if the model is configured and available. */
  resolve(model: string): Deployment | undefined {
    return this.#models.get(model);
  }

  deployment(id: string): Deployment | undefined {
    return this.#deployments.get(id);
  }

  modelNames(): string[] {
    return [...this.#models.keys()];
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#deployments.values()].map((d) => d.provider.close()));
  }
}

function createProvider(config: DeploymentConfig, deps: RegistryDeps): Provider {
  switch (config.provider) {
    case 'mock':
      return new MockProvider(config.mock, deps.clock);
  }
}

/** Builds providers for every deployment and maps each logical model to its deployment. */
export function createRegistry(config: ModelsConfig, deps: RegistryDeps): ProviderRegistry {
  const deployments = new Map<string, Deployment>();
  for (const [id, deployment] of Object.entries(config.deployments)) {
    deployments.set(id, {
      id,
      provider: createProvider(deployment, deps),
      providerModel: deployment.model,
      timeoutMs: deployment.timeoutMs,
      streamIdleTimeoutMs: deployment.streamIdleTimeoutMs,
    });
  }

  const models = new Map<string, Deployment>();
  for (const [name, model] of Object.entries(config.models)) {
    const deployment = deployments.get(model.deployment);
    if (deployment) models.set(name, deployment);
  }

  deps.logger.info(
    { models: [...models.keys()], deployments: [...deployments.keys()] },
    'model registry loaded',
  );
  return new ProviderRegistry(deployments, models);
}
