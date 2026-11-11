import { ManualClock } from '@ai-gateway/shared';
import { describe, expect, it } from 'vitest';
import {
  captureLogger,
  inMemoryVerifier,
  RecordingBus,
  sleepsQueued,
  sseData,
  testAdmission,
  testRouting,
} from '../../test/helpers.js';
import { BODY_LIMIT_BYTES, buildApp } from '../app.js';
import { parseModelsConfig } from '../models-config.js';
import type { MockProvider } from '../providers/mock.js';
import { createRegistry } from '../providers/registry.js';
import { registerChatCompletions } from './chat-completions.js';
import { IMAGE_TOKEN_ESTIMATE } from './estimate.js';
import { MAX_IMAGE_DATA_URL_BYTES, MAX_IMAGES_PER_REQUEST } from './schema.js';

const textOnly = { tools: false, json_object: false, json_schema: false, vision: false };

function setup() {
  const clock = new ManualClock(Date.UTC(2026, 10, 6, 12, 0, 0));
  const { logger } = captureLogger();
  const models = parseModelsConfig(
    {
      deployments: {
        tools: { provider: 'mock', mock: { latencyMs: 10, completionTokens: 3 } },
        plain: { provider: 'mock', capabilities: textOnly, mock: { completionTokens: 3 } },
        'json-only': {
          provider: 'mock',
          capabilities: { ...textOnly, json_object: true },
          mock: { completionTokens: 3 },
        },
      },
      models: {
        'mock-tools': { deployment: 'tools' },
        'mock-plain': { deployment: 'plain' },
        'mock-mixed': { targets: [{ deployment: 'plain' }, { deployment: 'tools' }] },
        'mock-json-only': { deployment: 'json-only' },
      },
    },
    'tools-test',
  );
  const registry = createRegistry(models, {
    clock,
    logger,
    env: {},
    ollamaBaseUrl: 'http://127.0.0.1:1',
  });
  const app = buildApp({ logger, readiness: { checks: {}, timeoutMs: 50 } });
  const { verifier, authorization } = inMemoryVerifier(clock);
  const events = new RecordingBus();
  const admission = testAdmission(clock, logger);
  const routing = testRouting(registry, clock);
  registerChatCompletions(app, { registry, clock, verifier, events, admission, routing });

  async function post(payload: unknown, { sleeps = 2, advance = 10 } = {}) {
    const pending = Promise.resolve(
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization },
        payload: payload as object,
      }),
    );
    if (sleeps > 0) {
      await sleepsQueued(clock, sleeps);
      await clock.advance(advance);
    }
    return pending;
  }
  const stats = (id: string) => (registry.deployment(id)?.provider as MockProvider).stats();
  return { post, events, stats };
}

const weather = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
        days: { type: 'integer', minimum: 1 },
      },
      required: ['city', 'unit', 'days'],
      additionalProperties: false,
    },
  },
};
const ask = [{ role: 'user', content: 'What is the weather in Paris?' }];

interface Completion {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
}

describe('tools on /v1/chat/completions', () => {
  it('answers a tool call with null content and finish_reason "tool_calls"', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-tools', messages: ask, tools: [weather] });
    expect(res.statusCode).toBe(200);
    const choice = res.json<Completion>().choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/) as string,
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: JSON.stringify({ city: 'mock', unit: 'celsius', days: 1 }),
        },
      },
    ]);
  });

  it('calls the tool tool_choice names', async () => {
    const { post } = setup();
    const other = { type: 'function', function: { name: 'get_time' } };
    const res = await post({
      model: 'mock-tools',
      messages: ask,
      tools: [weather, other],
      tool_choice: { type: 'function', function: { name: 'get_time' } },
    });
    expect(res.json<Completion>().choices[0]?.message.tool_calls?.[0]?.function).toEqual({
      name: 'get_time',
      arguments: '{}',
    });
  });

  it('answers in text after a tool result, and with tool_choice "none"', async () => {
    const { post } = setup();
    const first = await post({ model: 'mock-tools', messages: ask, tools: [weather] });
    const message = first.json<Completion>().choices[0]!.message;
    const call = message.tool_calls![0]!;
    const res = await post({
      model: 'mock-tools',
      tools: [weather],
      messages: [
        ...ask,
        { role: 'assistant', content: null, tool_calls: message.tool_calls, refusal: null },
        { role: 'tool', tool_call_id: call.id, content: '{"temperature": 18}' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const choice = res.json<Completion>().choices[0]!;
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.content).toBe('This is a');
    expect(choice.message).not.toHaveProperty('tool_calls');

    const none = await post({
      model: 'mock-tools',
      messages: ask,
      tools: [weather],
      tool_choice: 'none',
    });
    expect(none.json<Completion>().choices[0]?.finish_reason).toBe('stop');
  });

  it("streams a tool call in OpenAI's delta shape", async () => {
    const { post } = setup();
    const res = await post(
      { model: 'mock-tools', messages: ask, tools: [weather], stream: true },
      { sleeps: 2, advance: 10 },
    );
    expect(res.statusCode).toBe(200);
    const events = sseData(res.body);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map(
      (e) =>
        JSON.parse(e) as {
          choices: { delta: Record<string, unknown>; finish_reason: string | null }[];
        },
    );
    const deltas = chunks.map((c) => c.choices[0]?.delta);
    expect(deltas[0]).toEqual({ role: 'assistant', content: '' });
    expect(deltas[1]).toEqual({
      tool_calls: [
        {
          index: 0,
          id: expect.stringMatching(/^call_/) as string,
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
      ],
    });
    const pieces = deltas.slice(2, -1) as { tool_calls: { index: number; function: object }[] }[];
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    let args = '';
    for (const piece of pieces) {
      expect(piece.tool_calls).toHaveLength(1);
      expect(piece.tool_calls[0]).toMatchObject({ index: 0 });
      expect(Object.keys(piece.tool_calls[0]!)).toEqual(['index', 'function']);
      args += (piece.tool_calls[0]!.function as { arguments: string }).arguments;
    }
    expect(JSON.parse(args)).toEqual({ city: 'mock', unit: 'celsius', days: 1 });
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it('counts tool definitions and tool calls in the prompt estimate', async () => {
    const { post, events } = setup();
    await post({ model: 'mock-tools', messages: ask });
    await post({ model: 'mock-tools', messages: ask, tools: [weather] });
    const [plain, withTools] = events.events.map((e) => e.estimatedPromptTokens ?? 0);
    expect(withTools! - plain!).toBeGreaterThan(20);
  });

  it('counts a fixed estimate per image', async () => {
    const { post, events } = setup();
    const image = { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } };
    await post({ model: 'mock-tools', messages: [{ role: 'user', content: 'hi' }] });
    await post({
      model: 'mock-tools',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, image, image] }],
    });
    const [plain, withImages] = events.events.map((e) => e.estimatedPromptTokens ?? 0);
    expect(withImages! - plain!).toBe(2 * IMAGE_TOKEN_ESTIMATE);
  });
});

describe('JSON output on /v1/chat/completions', () => {
  it('answers json_schema with JSON that matches the schema', async () => {
    const { post } = setup();
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        score: { type: 'number', minimum: 0.5 },
        ok: { type: 'boolean' },
      },
      required: ['name', 'tags', 'score', 'ok'],
      additionalProperties: false,
    };
    const res = await post({
      model: 'mock-tools',
      messages: ask,
      response_format: { type: 'json_schema', json_schema: { name: 'card', schema, strict: true } },
    });
    expect(res.statusCode).toBe(200);
    const content = res.json<Completion>().choices[0]!.message.content!;
    expect(JSON.parse(content)).toEqual({ name: 'mock', tags: ['mock'], score: 0.5, ok: true });
  });

  it('answers json_object with a JSON object', async () => {
    const { post } = setup();
    const res = await post({
      model: 'mock-json-only',
      messages: ask,
      response_format: { type: 'json_object' },
    });
    const parsed: unknown = JSON.parse(res.json<Completion>().choices[0]!.message.content!);
    expect(typeof parsed).toBe('object');
  });
});

describe('capability-aware routing', () => {
  it('answers 400 before any provider call when no deployment supports tools', async () => {
    const { post, stats, events } = setup();
    const res = await post({ model: 'mock-plain', messages: ask, tools: [weather] }, { sleeps: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: {
        message: 'No deployment of the model `mock-plain` supports tools.',
        type: 'invalid_request_error',
        param: 'tools',
        code: 'model_capability_unsupported',
      },
    });
    expect(stats('plain').requests).toBe(0);
    expect(events.events[0]).toMatchObject({ attempts: [] });
  });

  it.each([
    [{ response_format: { type: 'json_schema', json_schema: { name: 'x' } } }, 'json_schema'],
    [{ response_format: { type: 'json_object' } }, 'json_object'],
  ])('names the missing response format (%j)', async (extra, what) => {
    const { post } = setup();
    const res = await post({ model: 'mock-plain', messages: ask, ...extra }, { sleeps: 0 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { param: 'response_format', message: expect.stringContaining(what) as string },
    });
  });

  it('accepts the documented maximum: three data: images of 512 KiB each, past 1 MiB', async () => {
    const { post, stats } = setup();
    const prefix = 'data:image/png;base64,';
    const url = prefix + 'A'.repeat(MAX_IMAGE_DATA_URL_BYTES - prefix.length);
    expect(url).toHaveLength(512 * 1024);
    const image = { type: 'image_url', image_url: { url } };
    const payload = {
      model: 'mock-tools',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Compare' }, image, image, image] },
      ],
    };
    expect(JSON.stringify(payload).length).toBeGreaterThan(BODY_LIMIT_BYTES);
    expect(MAX_IMAGES_PER_REQUEST).toBe(3);
    const res = await post(payload);
    expect(res.statusCode).toBe(200);
    expect(stats('tools').requests).toBe(1);
  });

  it('needs vision for images, and tools for a conversation that holds tool calls', async () => {
    const { post } = setup();
    const image = await post(
      {
        model: 'mock-json-only',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
          },
        ],
      },
      { sleeps: 0 },
    );
    expect(image.json()).toMatchObject({ error: { param: 'messages' } });
    expect(image.json<{ error: { message: string } }>().error.message).toContain('image input');

    const history = await post(
      {
        model: 'mock-plain',
        messages: [
          ...ask,
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c1', content: 'done' },
        ],
      },
      { sleeps: 0 },
    );
    expect(history.json()).toMatchObject({ error: { param: 'tools' } });
  });

  it('skips a deployment that cannot serve the request and says so in the routing reason', async () => {
    const { post, stats, events } = setup();
    const res = await post({ model: 'mock-mixed', messages: ask, tools: [weather] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-deployment']).toBe('tools');
    expect(stats('plain').requests).toBe(0);
    const [attempt] = events.events[0]!.attempts;
    expect(attempt?.routingReason).toBe('priority 1 of 1; skipped plain (no tools)');
  });

  it('still routes plain requests to every deployment', async () => {
    const { post } = setup();
    const res = await post({ model: 'mock-mixed', messages: ask }, { sleeps: 1, advance: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-deployment']).toBe('plain');
  });
});
