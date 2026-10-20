import { systemClock } from '@ai-gateway/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendJson,
  startFakeUpstream,
  type FakeHandler,
  type FakeUpstream,
} from '../../test/fake-upstream.js';
import { OllamaProvider } from './ollama.js';
import type { ChatRequest, StreamEvent } from './types.js';

const request: ChatRequest = {
  model: 'llama3.2:1b',
  messages: [
    { role: 'developer', content: 'Answer briefly.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Hi' },
        { type: 'text', text: 'there' },
      ],
    },
  ],
  maxTokens: 64,
  temperature: 0.3,
  seed: 7,
};

/** Shapes from Ollama's /api/chat documentation. */
const finalPart = {
  model: 'llama3.2:1b',
  created_at: '2026-10-20T10:00:00Z',
  message: { role: 'assistant', content: '' },
  done: true,
  done_reason: 'stop',
  total_duration: 1_000_000,
  prompt_eval_count: 12,
  eval_count: 3,
};

function part(content: string) {
  return {
    model: 'llama3.2:1b',
    created_at: '2026-10-20T10:00:00Z',
    message: { role: 'assistant', content },
    done: false,
  };
}

const ndjson = (...objects: unknown[]) => objects.map((o) => JSON.stringify(o)).join('\n') + '\n';

let upstream: FakeUpstream | undefined;
let provider: OllamaProvider | undefined;

async function setup(handler: FakeHandler) {
  upstream = await startFakeUpstream(handler);
  provider = new OllamaProvider({ baseUrl: `${upstream.url}/`, clock: systemClock });
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

describe('OllamaProvider.chat', () => {
  it('posts to /api/chat with plain-text messages and options, and reads the counts', async () => {
    const { upstream, provider } = await setup((_req, res) =>
      sendJson(res, 200, { ...finalPart, message: { role: 'assistant', content: 'Hello!' } }),
    );
    expect(await provider.chat(request, signal())).toEqual({
      content: 'Hello!',
      finishReason: 'stop',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
    const sent = upstream.requests[0]!;
    expect(sent.url).toBe('/api/chat');
    expect(sent.headers.authorization).toBeUndefined();
    expect(JSON.parse(sent.body)).toEqual({
      model: 'llama3.2:1b',
      messages: [
        { role: 'system', content: 'Answer briefly.' },
        { role: 'user', content: 'Hi\nthere' },
      ],
      stream: false,
      options: { num_predict: 64, temperature: 0.3, seed: 7 },
    });
  });

  it('maps done_reason "length" and reports missing counts as no usage', async () => {
    const { provider } = await setup((_req, res) =>
      sendJson(res, 200, {
        ...finalPart,
        message: { role: 'assistant', content: 'Hel' },
        done_reason: 'length',
        prompt_eval_count: undefined,
      }),
    );
    expect(await provider.chat(request, signal())).toEqual({
      content: 'Hel',
      finishReason: 'length',
      usage: null,
    });
  });

  it('normalizes a missing model (404) to not_found without keeping the message', async () => {
    const { provider } = await setup((_req, res) =>
      sendJson(res, 404, { error: "model 'llama3.2:1b' not found, try pulling it first" }),
    );
    const error = await provider.chat(request, signal()).catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: 'not_found', upstreamStatus: 404 });
    expect(String(error)).not.toContain('try pulling');
  });

  it('reports an Ollama server that is not running as connection', async () => {
    const { upstream, provider: unused } = await setup(() => undefined);
    await unused.close();
    await upstream.close();
    const offline = new OllamaProvider({ baseUrl: upstream.url, clock: systemClock });
    provider = offline;
    await expect(offline.chat(request, signal())).rejects.toMatchObject({ kind: 'connection' });
  });
});

describe('OllamaProvider.chatStream', () => {
  it('yields each line as content and finishes with the final line counts', async () => {
    const { upstream, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(ndjson(part('Hel'), part('lo'), part(''), finalPart));
    });
    expect(await collect(provider.chatStream(request, signal()))).toEqual([
      { type: 'content', text: 'Hel' },
      { type: 'content', text: 'lo' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      },
    ]);
    expect(JSON.parse(upstream.requests[0]!.body)).toMatchObject({ stream: true });
  });

  it('turns an error line into server_error', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(ndjson(part('Hel'), { error: 'out of memory' }));
    });
    await expect(collect(provider.chatStream(request, signal()))).rejects.toMatchObject({
      kind: 'server_error',
    });
  });

  it('treats a stream that ends before the final line as interrupted', async () => {
    const { provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(ndjson(part('Hel')));
    });
    await expect(collect(provider.chatStream(request, signal()))).rejects.toMatchObject({
      kind: 'connection',
    });
  });

  it('closes the connection to Ollama when the signal aborts mid-stream', async () => {
    const { upstream, provider } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(ndjson(part('first')));
    });
    const controller = new AbortController();
    const iterator = provider.chatStream(request, controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'content', text: 'first' });

    const next = iterator.next().catch((err: unknown) => err);
    controller.abort(new Error('client gone'));
    expect(await next).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(upstream.closedEarly).toBe(1));
  });
});

describe('OllamaProvider.probe', () => {
  it('lists local models', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, { models: [] }));
    await provider.probe(signal());
    expect(upstream.requests[0]).toMatchObject({ method: 'GET', url: '/api/tags' });
  });

  it('fails when the server cannot be reached', async () => {
    const { upstream, provider } = await setup((_req, res) => sendJson(res, 200, {}));
    await upstream.close();
    await expect(provider.probe(signal())).rejects.toMatchObject({ kind: 'connection' });
  });
});
