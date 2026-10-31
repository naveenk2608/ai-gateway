import { randomBytes } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient, sqsApi, type SqsApi } from '../packages/shared/src/node/sqs.js';

/**
 * SQS tests run against LocalStack from `docker compose --profile aws-local up -d` (ADR 023),
 * never against AWS: the client always has an emulator endpoint and placeholder credentials.
 */
export const LOCALSTACK_URL = process.env.LOCALSTACK_URL ?? 'http://localhost:4566';
export const LOCALSTACK_REGION = 'us-east-1';

/** Whether LocalStack's SQS answers. */
export async function localstackAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCALSTACK_URL}/_localstack/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await res.json()) as { services?: Record<string, string> };
    return ['available', 'running'].includes(body.services?.sqs ?? '');
  } catch {
    return false;
  }
}

export interface TestQueues {
  queueUrl: string;
  dlqUrl: string;
  /** The queue's name, as the consumer records it in failed_events (`sqs:<name>`). */
  name: string;
  sqs: SqsApi;
  remove(): Promise<void>;
}

/**
 * A usage queue and dead-letter queue of their own, with a redrive policy like the one
 * Terraform sets, so tests never see each other's messages.
 */
export async function createTestQueues(maxReceiveCount = 10): Promise<TestQueues> {
  const client = createSqsClient({ region: LOCALSTACK_REGION, endpoint: LOCALSTACK_URL });
  const name = `test-usage-${randomBytes(4).toString('hex')}`;
  const dlq = await client.send(new CreateQueueCommand({ QueueName: `${name}-dlq` }));
  const dlqArn = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn.Attributes!.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  return {
    queueUrl: queue.QueueUrl!,
    dlqUrl: dlq.QueueUrl!,
    name,
    sqs: sqsApi(client),
    async remove() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }));
      client.destroy();
    },
  };
}
