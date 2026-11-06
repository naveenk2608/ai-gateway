import type { AddressInfo } from 'node:net';
import OpenAI, { BadRequestError } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createGateway, type Gateway } from '../src/gateway.js';
import { parseModelsConfig } from '../src/models-config.js';
import type { MockProvider } from '../src/providers/mock.js';
import { createApiKey, createProject } from './db-fixtures.js';
import { captureLogger, testConfig } from './helpers.js';

/**
 * Contract test for tools and JSON output (M13): the official OpenAI Node SDK, unmodified,
 * against the gateway and the mock, including the SDK's own tool-calling loop.
 */
const models = parseModelsConfig(
  {
    deployments: {
      mock: { provider: 'mock', mock: { latencyMs: 10, ttftMs: 10, completionTokens: 6 } },
      plain: {
        provider: 'mock',
        capabilities: { tools: false, json_object: false, json_schema: false, vision: false },
      },
    },
    models: {
      'mock-tools': { deployment: 'mock' },
      'mock-plain': { deployment: 'plain' },
    },
  },
  'sdk-tools',
);

const EXPECTED_TEXT = 'This is a deterministic response from';

const weatherParameters = {
  type: 'object',
  properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['c', 'f'] } },
  required: ['city', 'unit'],
  additionalProperties: false,
};
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Current weather for a city',
      parameters: weatherParameters,
    },
  },
];

let gateway: Gateway;
let client: OpenAI;

beforeAll(async () => {
  gateway = createGateway(testConfig(), captureLogger().logger, { models });
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

describe('tool calling through the gateway with the OpenAI SDK', () => {
  it('runs the loop by hand: a tool call, a tool result, then the final answer', async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'What is the weather in Paris?' },
    ];
    const first = await client.chat.completions.create({ model: 'mock-tools', messages, tools });
    const choice = first.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    const call = choice.message.tool_calls?.[0];
    expect(call?.type).toBe('function');
    if (call?.type !== 'function') throw new Error('expected a function call');
    expect(call.function.name).toBe('get_weather');
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'mock', unit: 'c' });

    // The reply goes back exactly as the SDK returned it, then the tool's result.
    messages.push(choice.message);
    messages.push({ role: 'tool', tool_call_id: call.id, content: '{"temperature": 18}' });
    const final = await client.chat.completions.create({ model: 'mock-tools', messages, tools });
    expect(final.choices[0]?.finish_reason).toBe('stop');
    expect(final.choices[0]?.message.content).toBe(EXPECTED_TEXT);
  });

  it.each([false, true])("runs the SDK's runTools loop (stream: %s)", async (stream) => {
    const seen: unknown[] = [];
    const getWeather = (args: { city: string; unit: string }) => {
      seen.push(args);
      return { temperature: 18, unit: args.unit };
    };
    const params = {
      model: 'mock-tools',
      messages: [{ role: 'user' as const, content: 'What is the weather in Paris?' }],
      tools: [
        {
          type: 'function' as const,
          function: {
            name: 'get_weather',
            description: 'Current weather for a city',
            parameters: weatherParameters,
            function: getWeather,
            parse: (input: string) => JSON.parse(input) as { city: string; unit: string },
          },
        },
      ],
    };
    const runner = stream
      ? client.chat.completions.runTools({ ...params, stream: true })
      : client.chat.completions.runTools(params);
    expect(await runner.finalContent()).toBe(EXPECTED_TEXT);
    expect(seen).toEqual([{ city: 'mock', unit: 'c' }]);
    const calls = runner.messages.filter((m) => m.role === 'assistant' && 'tool_calls' in m);
    expect(calls).toHaveLength(1);
  });

  it("assembles streamed tool-call deltas with the SDK's stream helper", async () => {
    const runner = client.chat.completions.stream({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools,
    });
    const final = await runner.finalChatCompletion();
    const choice = final.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    const call = choice.message.tool_calls?.[0];
    if (call?.type !== 'function') throw new Error('expected a function call');
    expect(call.id).toMatch(/^call_/);
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'mock', unit: 'c' });
  });

  it('answers 400 for tools on a route with no tool-capable deployment, calling no provider', async () => {
    const error = await client.chat.completions
      .create({ model: 'mock-plain', messages: [{ role: 'user', content: 'Hi' }], tools })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({
      status: 400,
      code: 'model_capability_unsupported',
      param: 'tools',
    });
    const plain = gateway.registry.deployment('plain')?.provider as MockProvider;
    expect(plain.stats().requests).toBe(0);
  });
});

describe('JSON output through the gateway with the OpenAI SDK', () => {
  const Card = z
    .object({
      title: z.string(),
      tags: z.array(z.string()).min(1),
      score: z.number().min(0),
      done: z.boolean(),
      size: z.enum(['s', 'm', 'l']),
    })
    .strict();

  it.each([false, true])('returns JSON that matches a json_schema (stream: %s)', async (stream) => {
    const schema = z.toJSONSchema(Card) as Record<string, unknown>;
    const request = {
      model: 'mock-tools',
      messages: [{ role: 'user' as const, content: 'Make a card' }],
      response_format: {
        type: 'json_schema' as const,
        json_schema: { name: 'card', schema, strict: true },
      },
    };
    let content: string;
    if (stream) {
      const runner = client.chat.completions.stream(request);
      content = (await runner.finalChatCompletion()).choices[0]?.message.content ?? '';
    } else {
      const completion = await client.chat.completions.create(request);
      content = completion.choices[0]?.message.content ?? '';
    }
    expect(Card.safeParse(JSON.parse(content)).success).toBe(true);
  });

  it('answers json_object with a JSON object', async () => {
    const completion = await client.chat.completions.create({
      model: 'mock-tools',
      messages: [{ role: 'user', content: 'Reply in JSON' }],
      response_format: { type: 'json_object' },
    });
    const parsed: unknown = JSON.parse(completion.choices[0]?.message.content ?? '');
    expect(parsed).toBeTypeOf('object');
  });
});
