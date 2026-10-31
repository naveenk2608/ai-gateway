/**
 * Creates the usage queue and its dead-letter queue on LocalStack, for running the gateway and
 * worker with EVENT_BUS=sqs locally (ADR 023), and prints the settings to use. Idempotent.
 *
 *   docker compose --profile aws-local up -d
 *   pnpm sqs:local
 *
 * It only talks to a local endpoint (LOCALSTACK_URL, default http://localhost:4566) with
 * placeholder credentials; any other host is refused, so it can never create queues on AWS.
 */
import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../packages/shared/src/node/sqs.js';

const endpoint = process.env.LOCALSTACK_URL ?? 'http://localhost:4566';
const region = 'us-east-1';
const name = 'ai-gateway-usage';
/** Matches Terraform's backstop: above the worker's WORKER_MAX_DELIVERIES (5). */
const maxReceiveCount = 10;

if (!['localhost', '127.0.0.1', 'localstack'].includes(new URL(endpoint).hostname)) {
  console.error(`Refusing ${endpoint}: this script only creates queues on a local LocalStack.`);
  process.exit(1);
}

const client = createSqsClient({ region, endpoint });
try {
  const dlq = await client.send(new CreateQueueCommand({ QueueName: `${name}-dlq` }));
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: Attributes!.QueueArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  console.log(
    [
      '# LocalStack queues are ready. For the gateway and worker:',
      'EVENT_BUS=sqs',
      `SQS_QUEUE_URL=${queue.QueueUrl!}`,
      `SQS_DLQ_URL=${dlq.QueueUrl!}`,
      `AWS_REGION=${region}`,
      `SQS_ENDPOINT=${endpoint}`,
    ].join('\n'),
  );
} catch (err) {
  console.error(
    `Could not create the queues on ${endpoint}. Is LocalStack running ` +
      '(`docker compose --profile aws-local up -d`)?',
  );
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  client.destroy();
}
