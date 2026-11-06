import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sendJson,
  startFakeUpstream,
  type FakeHandler,
  type FakeUpstream,
} from '../../test/fake-upstream.js';
import { dialectFor } from './dialects.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { ChatRequest, StreamEvent } from './types.js';

let upstream: FakeUpstream | undefined;
let provider: OpenAICompatibleProvider | undefined;

async function setup(handler: FakeHandler, providerName = 'openai-compatible') {
  upstream = await startFakeUpstream(handler);
  provider = new OpenAICompatibleProvider({
    baseUrl: `${upstream.url}/v1`,
    apiKey: 'test-key-not-secret',
    clock: systemClock,
    dialect: dialectFor('openai-compatible', providerName),
  });
  return { upstream, provider };
}

afterEach(async () => {
  await provider?.close();
  await upstream?.close();
  provider = undefined;
  upstream = undefined;
});

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const signal = () => new AbortController().signal;

const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';

const streamOf =
  (chunks: unknown[]): FakeHandler =>
  (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(chunks));
  };

const delta = (d: object, finish: string | null = null) => ({
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const conversation: ChatRequest = {
  model: 'm',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture, and the weather?' },
        { type: 'image', url: 'https://example.com/cat.png', detail: 'low' },
      ],
    },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_abc123def456', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    },
    { role: 'tool', content: '{"temperature":18}', toolCallId: 'call_abc123def456' },
  ],
  maxTokens: 64,
  tools: [
    {
      name: 'get_weather',
      description: 'Weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      strict: true,
    },
  ],
  toolChoice: { name: 'get_weather' },
  parallelToolCalls: false,
  responseFormat: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: true },
};

const okCompletion = {
  choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
};

describe('the OpenAI-compatible request body', () => {
  it("sends tools, tool calls, tool results, images and the response format in OpenAI's form", async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, okCompletion));
    await provider.chat(conversation, signal());
    const body = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>;
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this picture, and the weather?' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'low' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc123def456',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', content: '{"temperature":18}', tool_call_id: 'call_abc123def456' },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Weather for a city',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object' }, strict: true },
    });
  });

  it("drops what Gemini's docs do not list: strict and parallel_tool_calls", async () => {
    const { upstream, provider } = await setup(
      (_req, res) => sendJson(res, 200, okCompletion),
      'gemini',
    );
    await provider.chat({ ...conversation, toolChoice: 'auto' }, signal());
    const body = JSON.parse(upstream.requests[0]!.body) as {
      tools: { function: Record<string, unknown> }[];
      parallel_tool_calls?: boolean;
      tool_choice: unknown;
    };
    expect(body.tools[0]?.function).not.toHaveProperty('strict');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(body.tool_choice).toBe('auto');
  });

  it('gives Mistral nine-character tool-call IDs, the same in calls and results', async () => {
    const { upstream, provider } = await setup(
      (_req, res) => sendJson(res, 200, okCompletion),
      'mistral',
    );
    await provider.chat(conversation, signal());
    const body = JSON.parse(upstream.requests[0]!.body) as {
      messages: { tool_calls?: { id: string }[]; tool_call_id?: string }[];
      tools: { function: Record<string, unknown> }[];
    };
    const sentId = body.messages[1]?.tool_calls?.[0]?.id;
    expect(sentId).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(body.messages[2]?.tool_call_id).toBe(sentId);
    expect(body.tools[0]?.function).not.toHaveProperty('strict');
  });

  it('sends no tool fields for a request without tools', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, okCompletion));
    await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, signal());
    const body = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>;
    for (const field of ['tools', 'tool_choice', 'parallel_tool_calls', 'response_format']) {
      expect(body).not.toHaveProperty(field);
    }
  });
});

describe('tool calls in OpenAI-compatible answers', () => {
  it('reads tool calls with text or object arguments, and generates missing IDs', async () => {
    const { provider } = await setup((_req, res) =>
      sendJson(res, 200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
                { type: 'function', function: { name: 'b', arguments: { y: 2 } } },
              ],
            },
            // Some providers say "stop" even when the model called tools.
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const result = await provider.chat(conversation, signal());
    expect(result.content).toBe('');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'a', arguments: '{"x":1}' },
      {
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/) as string,
        name: 'b',
        arguments: '{"y":2}',
      },
    ]);
  });

  it('turns IDs it mapped for Mistral back into the IDs the client sent', async () => {
    let sentId = '';
    const { provider } = await setup((req, res) => {
      const body = JSON.parse(req.body) as { messages: { tool_calls?: { id: string }[] }[] };
      sentId = body.messages[1]!.tool_calls![0]!.id;
      sendJson(res, 200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: sentId, function: { name: 'get_weather', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }, 'mistral');
    const result = await provider.chat(conversation, signal());
    expect(result.toolCalls?.[0]?.id).toBe('call_abc123def456');
  });

  it('streams tool-call deltas split across chunks, in order', async () => {
    const { provider } = await setup(
      streamOf([
        delta({ role: 'assistant', content: null }),
        delta({
          tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }),
        delta({
          tool_calls: [
            { index: 1, id: 'call_b', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        }),
        delta({}, 'tool_calls'),
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } },
      ]),
    );
    expect(await collect(provider.chatStream(conversation, signal()))).toEqual([
      { type: 'tool_call', index: 0, id: 'call_a', name: 'f' },
      { type: 'tool_arguments', index: 0, text: '{"q":' },
      { type: 'tool_arguments', index: 0, text: '"x"}' },
      { type: 'tool_call', index: 1, id: 'call_b', name: 'g' },
      { type: 'tool_arguments', index: 1, text: '{}' },
      {
        type: 'finish',
        finishReason: 'tool_calls',
        usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
        rateLimit: undefined,
      },
    ]);
  });

  it('streams whole tool calls sent in one chunk without an index', async () => {
    const { provider } = await setup(
      streamOf([
        delta({
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"n":1}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{"n":2}' } },
          ],
        }),
        delta({}, 'stop'),
      ]),
    );
    const events = await collect(provider.chatStream(conversation, signal()));
    expect(events.slice(0, 4)).toEqual([
      { type: 'tool_call', index: 0, id: 'c1', name: 'a' },
      { type: 'tool_arguments', index: 0, text: '{"n":1}' },
      { type: 'tool_call', index: 1, id: 'c2', name: 'b' },
      { type: 'tool_arguments', index: 1, text: '{"n":2}' },
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'finish', finishReason: 'tool_calls' });
  });

  it('asks Groq for structured output without streaming, and replays it as a stream', async () => {
    const { upstream, provider } = await setup(
      (_req, res) =>
        sendJson(res, 200, {
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      'groq',
    );
    const events = await collect(
      provider.chatStream({ ...conversation, tools: undefined, toolChoice: undefined }, signal()),
    );
    expect(JSON.parse(upstream.requests[0]!.body)).toMatchObject({ stream: false });
    expect(events).toEqual([
      { type: 'content', text: '{"ok":true}' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        rateLimit: undefined,
      },
    ]);
  });

  it('rejects a streamed tool call that never names its function', async () => {
    const { provider } = await setup(
      streamOf([
        delta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
        delta({}, 'stop'),
      ]),
    );
    await expect(collect(provider.chatStream(conversation, signal()))).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});
