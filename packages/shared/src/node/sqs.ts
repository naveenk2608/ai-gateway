import {
  ChangeMessageVisibilityBatchCommand,
  DeleteMessageBatchCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

/** SQS takes at most this many entries per batch call. */
export const SQS_MAX_BATCH = 10;

export interface SqsClientOptions {
  region: string;
  /**
   * A local SQS emulator such as LocalStack. Omitted, the region's SQS endpoint is used with the
   * SDK's default credentials: environment variables, or the instance role on EC2.
   */
  endpoint?: string | undefined;
}

/**
 * The placeholder credentials LocalStack accepts. A client with an emulator endpoint always uses
 * them, so it never looks up, or sends, real AWS credentials.
 */
const EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

export function createSqsClient(options: SqsClientOptions): SQSClient {
  return new SQSClient({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint, credentials: EMULATOR_CREDENTIALS } : {}),
    // Callers retry with their own backoff (buffered publishing, the consumer loop).
    maxAttempts: 2,
  });
}

export interface SqsMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  /** Deliveries so far, this one included. */
  receiveCount: number;
}

export interface QueueDepth {
  /** Messages waiting to be received. */
  visible: number;
  /** Messages received and not yet deleted (being processed, or left by a crashed consumer). */
  inFlight: number;
  /** Messages sent with a delay that has not passed. */
  delayed: number;
}

/**
 * The SQS calls the event bus and the usage consumer make, behind one small interface so their
 * unit tests can use a fake. Batch calls are split into SQS-sized batches here.
 */
export interface SqsApi {
  /** Sends the bodies; resolves with the indexes of those SQS did not accept. */
  sendBatch(queueUrl: string, bodies: string[]): Promise<number[]>;
  send(queueUrl: string, body: string, attributes?: Record<string, string>): Promise<void>;
  receive(
    queueUrl: string,
    options: { max: number; waitSeconds: number; visibilitySeconds: number },
    signal?: AbortSignal,
  ): Promise<SqsMessage[]>;
  /** Deletes (acknowledges) messages; resolves with the receipt handles SQS did not delete. */
  deleteBatch(queueUrl: string, receiptHandles: string[]): Promise<string[]>;
  /** Keeps received messages hidden for `seconds` more, so no other consumer gets them meanwhile. */
  extendVisibility(queueUrl: string, receiptHandles: string[], seconds: number): Promise<void>;
  depth(queueUrl: string): Promise<QueueDepth>;
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += SQS_MAX_BATCH) out.push(items.slice(i, i + SQS_MAX_BATCH));
  return out;
}

export function sqsApi(client: SQSClient): SqsApi {
  return {
    async sendBatch(queueUrl, bodies) {
      const failed: number[] = [];
      for (const [n, chunk] of chunks(bodies.map((body, index) => ({ body, index }))).entries()) {
        try {
          const reply = await client.send(
            new SendMessageBatchCommand({
              QueueUrl: queueUrl,
              Entries: chunk.map((e) => ({ Id: String(e.index), MessageBody: e.body })),
            }),
          );
          for (const f of reply.Failed ?? []) failed.push(Number(f.Id));
        } catch (err) {
          // Nothing of this chunk or the ones after it was sent.
          if (n === 0) throw err;
          for (const later of chunks(bodies.map((_, i) => i)).slice(n)) failed.push(...later);
          break;
        }
      }
      return failed.sort((a, b) => a - b);
    },

    async send(queueUrl, body, attributes = {}) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: body,
          MessageAttributes: Object.fromEntries(
            Object.entries(attributes).map(([name, value]) => [
              name,
              { DataType: 'String', StringValue: value },
            ]),
          ),
        }),
      );
    },

    async receive(queueUrl, options, signal) {
      const reply = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: Math.min(options.max, SQS_MAX_BATCH),
          WaitTimeSeconds: options.waitSeconds,
          VisibilityTimeout: options.visibilitySeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
        signal ? { abortSignal: signal } : {},
      );
      return (reply.Messages ?? []).flatMap((m) =>
        m.MessageId && m.ReceiptHandle
          ? [
              {
                messageId: m.MessageId,
                receiptHandle: m.ReceiptHandle,
                body: m.Body ?? '',
                receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 1),
              },
            ]
          : [],
      );
    },

    async deleteBatch(queueUrl, receiptHandles) {
      const failed: string[] = [];
      for (const chunk of chunks(receiptHandles)) {
        const reply = await client.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((handle, i) => ({ Id: String(i), ReceiptHandle: handle })),
          }),
        );
        for (const f of reply.Failed ?? []) failed.push(chunk[Number(f.Id)]!);
      }
      return failed;
    },

    async extendVisibility(queueUrl, receiptHandles, seconds) {
      for (const chunk of chunks(receiptHandles)) {
        await client.send(
          new ChangeMessageVisibilityBatchCommand({
            QueueUrl: queueUrl,
            Entries: chunk.map((handle, i) => ({
              Id: String(i),
              ReceiptHandle: handle,
              VisibilityTimeout: seconds,
            })),
          }),
        );
      }
    },

    async depth(queueUrl) {
      const reply = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      );
      const count = (name: string) => Number(reply.Attributes?.[name as never] ?? 0);
      return {
        visible: count('ApproximateNumberOfMessages'),
        inFlight: count('ApproximateNumberOfMessagesNotVisible'),
        delayed: count('ApproximateNumberOfMessagesDelayed'),
      };
    },
  };
}
