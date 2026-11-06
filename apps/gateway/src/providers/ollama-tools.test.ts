import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sendJson,
  startFakeUpstream,
  type FakeHandler,
  type FakeUpstream,
} from '../../test/fake-upstream.js';
import { OllamaProvider } from './ollama.js';
import type { ChatRequest, StreamEvent } from './types.js';

let upstream: FakeUpstream | undefined;
let provider: OllamaProvider | undefined;

async function setup(handler: FakeHandler) {
  upstream = await startFakeUpstream(handler);
  provider = new OllamaProvider({ baseUrl: upstream.url, clock: systemClock });
  return { upstream, provider };
}

afterEach(async () => {
  await provider?.close();
  await upstream?.close();
  provider = undefined;
  upstream = undefined;
});

const signal = () => new AbortController().signal;

// Tool calls as Ollama's /api/chat documents them: a function with an arguments object, no ID.
const toolAnswer = {
  model: 'llama3.2:1b',
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
  },
  done: true,
  done_reason: 'stop',
  prompt_eval_count: 20,
  eval_count: 8,
};

const request: ChatRequest = {
  model: 'llama3.2:1b',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Weather?' },
        { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' },
      ],
    },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    },
    { role: 'tool', content: '18 C', toolCallId: 'call_1' },
  ],
  tools: [{ name: 'get_weather', parameters: { type: 'object' }, strict: true }],
  toolChoice: 'auto',
  responseFormat: { type: 'json_schema', name: 'w', schema: { type: 'object' } },
};

describe('Ollama tools, JSON output and images', () => {
  it('sends tools, format, base64 images and tool calls as Ollama documents them', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, toolAnswer));
    await provider.chat(request, signal());
    const body = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: 'user', content: 'Weather?', images: ['iVBORw0KGgo='] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Paris' } } }],
      },
      { role: 'tool', content: '18 C' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
    ]);
    expect(body.format).toEqual({ type: 'object' });
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('reads tool calls, giving each an ID and its arguments as JSON text', async () => {
    const { provider } = await setup((_req, res) => sendJson(res, 200, toolAnswer));
    const result = await provider.chat(request, signal());
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toEqual([
      {
        id: expect.stringMatching(/^call_/) as string,
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
    ]);
  });

  it('streams a tool call that comes whole in one line', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(
        `${JSON.stringify({ ...toolAnswer, done: false })}\n${JSON.stringify({
          ...toolAnswer,
          message: { role: 'assistant', content: '' },
        })}\n`,
      );
    });
    const events: StreamEvent[] = [];
    for await (const event of provider.chatStream(request, signal())) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_arguments', 'finish']);
    expect(events.at(-1)).toMatchObject({ finishReason: 'tool_calls' });
  });

  it('asks for JSON with format "json"', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, toolAnswer));
    await provider.chat(
      {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        responseFormat: { type: 'json_object' },
      },
      signal(),
    );
    expect(JSON.parse(upstream.requests[0]!.body)).toMatchObject({ format: 'json' });
  });

  it('refuses images by URL, which it would have to fetch', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, toolAnswer));
    const byUrl: ChatRequest = {
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'image', url: 'https://example.com/a.png' }] }],
    };
    await expect(provider.chat(byUrl, signal())).rejects.toMatchObject({ kind: 'bad_request' });
    expect(upstream.requests).toHaveLength(0);
  });
});
