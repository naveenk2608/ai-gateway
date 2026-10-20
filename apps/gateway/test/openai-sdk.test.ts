import type { AddressInfo } from 'node:net';
import OpenAI, { APIError, NotFoundError, RateLimitError } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/** Contract test: the official OpenAI Node SDK, unmodified, pointed at the gateway. */
const models = parseModelsConfig(
  {
    deployments: {
      mock: { provider: 'mock', mock: { latencyMs: 10, ttftMs: 10, completionTokens: 6 } },
      limited: { provider: 'mock', mock: { failWith: 429, retryAfterMs: 1_000 } },
      drop: { provider: 'mock', mock: { completionTokens: 10, dropAfterTokens: 3 } },
    },
    models: {
      'mock-1': { deployment: 'mock' },
      'mock-limited': { deployment: 'limited' },
      'mock-drop': { deployment: 'drop' },
    },
  },
  'sdk-contract',
);

const EXPECTED_TEXT = 'This is a deterministic response from';
const messages = [{ role: 'user' as const, content: 'Say hello' }];

let gateway: Gateway;
let client: OpenAI;

beforeAll(async () => {
  const config = testConfig();
  gateway = createGateway(config, captureLogger().logger, { models });
  await gateway.start();
  const { port } = gateway.app.server.address() as AddressInfo;
  const key = await createApiKey(gateway.db, await createProject(gateway.db));
  client = new OpenAI({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: key.plaintext,
    maxRetries: 0,
  });
});

afterAll(async () => {
  await gateway.shutdown();
});

describe('OpenAI Node SDK against the gateway', () => {
  it('creates a chat completion', async () => {
    const completion = await client.chat.completions.create({ model: 'mock-1', messages });
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('mock-1');
    expect(completion.choices[0]?.message.content).toBe(EXPECTED_TEXT);
    expect(completion.choices[0]?.finish_reason).toBe('stop');
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 });
  });

  it('streams chunks, including the usage chunk', async () => {
    const stream = await client.chat.completions.create({
      model: 'mock-1',
      messages,
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let finishReason: string | null = null;
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      text += choice?.delta.content ?? '';
      finishReason = choice?.finish_reason ?? finishReason;
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe(EXPECTED_TEXT);
    expect(finishReason).toBe('stop');
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 6, total_tokens: 9 });
  });

  it("assembles a final completion with the SDK's stream helper", async () => {
    const runner = client.chat.completions.stream({ model: 'mock-1', messages });
    const final = await runner.finalChatCompletion();
    expect(final.choices[0]?.message.content).toBe(EXPECTED_TEXT);
    expect(final.choices[0]?.finish_reason).toBe('stop');
  });

  it('raises NotFoundError for an unknown model', async () => {
    const error = await client.chat.completions
      .create({ model: 'no-such-model', messages })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error).toMatchObject({ status: 404, code: 'model_not_found', param: 'model' });
  });

  it('raises RateLimitError when the upstream rate-limits', async () => {
    const error = await client.chat.completions
      .create({ model: 'mock-limited', messages })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ status: 429, code: 'upstream_rate_limited' });
  });

  it('raises an APIError when the stream fails after it started', async () => {
    const stream = await client.chat.completions.create({
      model: 'mock-drop',
      messages,
      stream: true,
    });
    let text = '';
    const error = await (async () => {
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    })().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({ code: 'upstream_unavailable' });
    expect(text).toBe('This is a');
  });
});
