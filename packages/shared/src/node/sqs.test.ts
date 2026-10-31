import {
  DeleteMessageBatchCommand,
  SendMessageBatchCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';
import { createSqsClient, sqsApi } from './sqs.js';

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/usage';

/** A client whose `send` answers each command with `reply`; nothing leaves the process. */
function fakeClient(reply: (command: unknown, call: number) => unknown) {
  let call = 0;
  const send = vi.fn((command: unknown) => {
    try {
      return Promise.resolve(reply(command, call++));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  return { client: { send } as unknown as SQSClient, send };
}

const bodies = (n: number) => Array.from({ length: n }, (_, i) => `event-${i}`);

describe('sqsApi', () => {
  it('sends in batches of 10 and reports the bodies SQS refused, by index', async () => {
    const { client, send } = fakeClient((_command, call) =>
      call === 1 ? { Failed: [{ Id: '13' }, { Id: '17' }] } : {},
    );
    expect(await sqsApi(client).sendBatch(QUEUE, bodies(25))).toEqual([13, 17]);
    const entries = send.mock.calls.map(([command]) => {
      expect(command).toBeInstanceOf(SendMessageBatchCommand);
      return (command as SendMessageBatchCommand).input.Entries!.map((e) => e.MessageBody);
    });
    expect(entries.map((e) => e.length)).toEqual([10, 10, 5]);
    expect(entries.flat()).toEqual(bodies(25));
  });

  it('counts every later batch as unsent when one call fails midway', async () => {
    const { client } = fakeClient((_command, call) => {
      if (call === 1) throw new Error('connect ETIMEDOUT');
      return {};
    });
    const failed = await sqsApi(client).sendBatch(QUEUE, bodies(25));
    expect(failed).toEqual(Array.from({ length: 15 }, (_, i) => i + 10));
  });

  it('throws when nothing could be sent', async () => {
    const { client } = fakeClient(() => {
      throw new Error('connect ETIMEDOUT');
    });
    await expect(sqsApi(client).sendBatch(QUEUE, bodies(3))).rejects.toThrow('ETIMEDOUT');
  });

  it('deletes in batches of 10 and returns the receipt handles SQS kept', async () => {
    // The second call carries handles 10 and 11; SQS keeps its second entry.
    const { client, send } = fakeClient((_command, call) =>
      call === 1 ? { Failed: [{ Id: '1' }] } : {},
    );
    const handles = bodies(12).map((b) => `handle-${b}`);
    expect(await sqsApi(client).deleteBatch(QUEUE, handles)).toEqual(['handle-event-11']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([c]) => c instanceof DeleteMessageBatchCommand)).toBe(true);
  });
});

describe('createSqsClient', () => {
  it('uses placeholder credentials with an emulator endpoint, never real ones', async () => {
    const client = createSqsClient({ region: 'us-east-1', endpoint: 'http://localhost:4566' });
    const credentials = await client.config.credentials();
    expect(credentials).toMatchObject({ accessKeyId: 'test', secretAccessKey: 'test' });
    client.destroy();
  });
});
