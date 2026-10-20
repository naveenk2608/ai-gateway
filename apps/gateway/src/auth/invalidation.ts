import { closeRedis, createRedis, type Logger, type Redis } from '@ai-gateway/shared/node';
import { z } from 'zod';
import type { KeyVerifier } from './key-verifier.js';

export const INVALIDATION_CHANNEL = 'gw:auth:invalidate';

const messageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), keyId: z.string() }),
  z.object({ kind: z.literal('project'), projectId: z.string() }),
]);

export type InvalidationMessage = z.output<typeof messageSchema>;

export interface AuthInvalidationOptions {
  verifier: KeyVerifier;
  /** The shared command connection, used to publish. */
  redis: Redis;
  redisUrl: string;
  logger: Logger;
  channel?: string;
}

/**
 * Tells every gateway instance to drop cached keys after a revocation, rotation or allow-list
 * change. Delivery is best effort (Redis pub/sub): a lost message only delays the change until the
 * cache TTL, which is the bound the tests assert. After a reconnect the whole cache is dropped,
 * since messages sent while disconnected are gone.
 */
export class AuthInvalidation {
  readonly #options: AuthInvalidationOptions;
  readonly #channel: string;
  #subscriber: Redis | undefined;

  constructor(options: AuthInvalidationOptions) {
    this.#options = options;
    this.#channel = options.channel ?? INVALIDATION_CHANNEL;
  }

  start(): void {
    const { logger, verifier } = this.#options;
    // A dedicated connection: a subscribed connection cannot run other commands. The offline
    // queue lets SUBSCRIBE wait for the first connect; ioredis resubscribes after reconnects.
    const subscriber = createRedis(this.#options.redisUrl, logger, {
      offlineQueue: true,
      role: 'auth-invalidation',
    });
    this.#subscriber = subscriber;
    let connectedBefore = false;
    subscriber.on('ready', () => {
      if (connectedBefore) verifier.clear();
      connectedBefore = true;
    });
    subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== this.#channel) return;
      this.#apply(raw);
    });
    subscriber.subscribe(this.#channel).catch((err: unknown) => {
      logger.warn({ err }, 'auth invalidation subscribe failed');
    });
  }

  /** Applies the change locally at once, then tells the other instances. */
  async publish(message: InvalidationMessage): Promise<void> {
    this.#applyMessage(message);
    try {
      await this.#options.redis.publish(this.#channel, JSON.stringify(message));
    } catch (err) {
      // Other instances fall back to the cache TTL.
      this.#options.logger.warn({ err, kind: message.kind }, 'auth invalidation publish failed');
    }
  }

  async close(): Promise<void> {
    if (this.#subscriber) await closeRedis(this.#subscriber);
  }

  #apply(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const result = messageSchema.safeParse(parsed);
    if (!result.success) {
      this.#options.logger.warn('ignored malformed auth invalidation message');
      return;
    }
    this.#applyMessage(result.data);
  }

  #applyMessage(message: InvalidationMessage): void {
    if (message.kind === 'api_key') this.#options.verifier.invalidateKey(message.keyId);
    else this.#options.verifier.invalidateProject(message.projectId);
  }
}
