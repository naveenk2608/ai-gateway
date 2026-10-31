import type { SqsApi } from '@ai-gateway/shared/node';
import { BufferedEventBus, type BufferedBusOptions } from './buffered.js';

export interface SqsBusOptions extends BufferedBusOptions {
  sqs: SqsApi;
  queueUrl: string;
}

/**
 * EventBus over an SQS queue (ADR 023), for the AWS deployment: the same buffering as the Redis
 * adapter, written with SendMessageBatch. SQS may deliver a message twice; the worker's
 * idempotent inserts make that harmless (ADR 014).
 */
export class SqsBus extends BufferedEventBus {
  readonly #options: SqsBusOptions;

  constructor(options: SqsBusOptions) {
    super(options);
    this.#options = options;
  }

  protected async write(batch: string[]): Promise<string[]> {
    try {
      const failed = await this.#options.sqs.sendBatch(this.#options.queueUrl, batch);
      if (failed.length > 0) {
        this.#options.logger.warn(
          { failed: failed.length, batch: batch.length },
          'some usage events were not accepted by SQS',
        );
      }
      return failed.map((i) => batch[i]!);
    } catch (err) {
      this.#options.logger.warn({ err, batch: batch.length }, 'usage event write failed');
      return batch;
    }
  }
}
