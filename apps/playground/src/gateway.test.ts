import { describe, expect, it, vi } from 'vitest';
import {
  GatewayProblem,
  listModels,
  problemFrom,
  retryAfterSeconds,
  streamChat,
  type Fetch,
  type Served,
} from './gateway.js';
import { describeProblem, formatWait } from './problems.js';
import { providerName, servedBy } from './providers.js';

const conn = { gatewayUrl: 'https://gw.example.com', apiKey: 'gw_test_placeholder' };

/** An SSE response body from data payloads. */
function sse(payloads: unknown[], headers: Record<string, string> = {}): Response {
  const text = payloads
    .map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
    .join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream', ...headers } });
}

const chunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });

const errorResponse = (status: number, code: string, message: string, headers = {}) =>
  Response.json({ error: { code, message, type: 'x' } }, { status, headers });

describe('listModels', () => {
  it('asks the gateway, and only the gateway, with the key as a bearer token', async () => {
    const fetchMock = vi.fn<Fetch>(() =>
      Promise.resolve(
        Response.json({ object: 'list', data: [{ id: 'chat-default' }, { id: 'qwen3' }] }),
      ),
    );
    expect(await listModels(conn, undefined, fetchMock)).toEqual(['chat-default', 'qwen3']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://gw.example.com/v1/models');
    expect(init).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { authorization: 'Bearer gw_test_placeholder' },
    });
  });

  it('turns a network or CORS failure into "unreachable"', async () => {
    const fetchMock = vi.fn<Fetch>(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(listModels(conn, undefined, fetchMock)).rejects.toMatchObject({
      kind: 'unreachable',
    });
  });
});

describe('streamChat', () => {
  it('streams the text and reports how the reply was served, with the usage', async () => {
    const fetchMock = vi.fn<Fetch>(() =>
      Promise.resolve(
        sse(
          [
            chunk('Hel'),
            chunk('lo'),
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } },
            '[DONE]',
          ],
          {
            'x-request-id': 'req-1',
            'x-gateway-deployment': 'gemini-3.5-flash-lite',
            'x-gateway-fallback-from': 'groq-gpt-oss-20b',
          },
        ),
      ),
    );
    const text: string[] = [];
    let served: Served | undefined;
    const outcome = await streamChat(
      conn,
      { model: 'chat-default', messages: [{ role: 'user', content: 'Hi' }] },
      { onServed: (s) => (served = s), onText: (t) => text.push(t) },
      new AbortController().signal,
      fetchMock,
    );
    expect(text.join('')).toBe('Hello');
    expect(served).toEqual({
      requestId: 'req-1',
      deployment: 'gemini-3.5-flash-lite',
      fallbackFrom: ['groq-gpt-oss-20b'],
      cacheHit: false,
    });
    expect(outcome).toEqual({
      finishReason: 'stop',
      usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 },
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'chat-default',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('fails with the error the gateway sends inside a stream that had started', async () => {
    const fetchMock = vi.fn<Fetch>(() =>
      Promise.resolve(
        sse([chunk('Par'), { error: { code: 'upstream_error', message: 'The provider failed.' } }]),
      ),
    );
    const text: string[] = [];
    await expect(
      streamChat(
        conn,
        { model: 'm', messages: [] },
        { onServed: () => undefined, onText: (t) => text.push(t) },
        new AbortController().signal,
        fetchMock,
      ),
    ).rejects.toMatchObject({ kind: 'server', message: 'The provider failed.' });
    expect(text).toEqual(['Par']);
  });

  it('treats a stream that ends without [DONE] as cut off', async () => {
    const fetchMock = vi.fn<Fetch>(() => Promise.resolve(sse([chunk('a')])));
    await expect(
      streamChat(
        conn,
        { model: 'm', messages: [] },
        { onServed: () => undefined, onText: () => undefined },
        new AbortController().signal,
        fetchMock,
      ),
    ).rejects.toMatchObject({ message: 'The reply stream ended early.' });
  });
});

describe('problems', () => {
  it('reads a 401 as a rejected key', async () => {
    const problem = await problemFrom(
      errorResponse(401, 'invalid_api_key', 'This API key has been revoked.', {
        'x-request-id': 'req-2',
      }),
    );
    expect(problem).toMatchObject({ kind: 'auth', status: 401, requestId: 'req-2' });
    expect(describeProblem(problem).title).toBe('The gateway rejected this API key');
    expect(describeProblem(problem).detail).toContain('This API key has been revoked.');
  });

  it('reads a 403 as a model the project may not use', async () => {
    const problem = await problemFrom(
      errorResponse(403, 'model_not_allowed', 'This project is not allowed to use the model `x`.'),
    );
    const { title, detail } = describeProblem(problem, { model: 'x' });
    expect(problem.kind).toBe('forbidden');
    expect(title).toBe('This model is not allowed for this key');
    expect(detail).toContain('ask a project admin to allow `x`');
  });

  it('reads a 429 rate limit with its retry time', async () => {
    const problem = await problemFrom(
      errorResponse(429, 'rpm_limit_exceeded', 'Rate limit reached: 60 requests per minute.', {
        'retry-after': '12',
      }),
    );
    expect(problem).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 12 });
    expect(describeProblem(problem).detail).toBe(
      'Rate limit reached: 60 requests per minute. Try again in 12 s.',
    );
  });

  it('reads a 429 for the budget as a spent budget, and when the month ends', async () => {
    const problem = await problemFrom(
      errorResponse(429, 'budget_exceeded', "The project's monthly budget is used up.", {
        'retry-after': String(3 * 86_400),
      }),
    );
    const { title, detail } = describeProblem(problem);
    expect(problem.kind).toBe('budget');
    expect(title).toBe("The project's monthly budget is used up");
    expect(detail).toContain('The month ends in 3 days.');
  });

  it('reads a 502/503 without the gateway error body as the gateway not answering yet', async () => {
    const problem = await problemFrom(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(problem.kind).toBe('unreachable');
    const { detail } = describeProblem(problem, { origin: 'https://pg.example.com' });
    expect(detail).toContain('waking up');
    expect(detail).toContain('ALLOWED_ORIGINS includes https://pg.example.com');
  });

  it("keeps the gateway's own 503s apart, with their retry time", async () => {
    const problem = await problemFrom(
      errorResponse(503, 'deployments_unavailable', 'Every deployment is failing.', {
        'retry-after': '30',
      }),
    );
    expect(problem.kind).toBe('unavailable');
    expect(describeProblem(problem).detail).toBe('Every deployment is failing. Try again in 30 s.');
  });

  it('parses Retry-After as seconds or a date, and formats waits', () => {
    expect(retryAfterSeconds('7')).toBe(7);
    expect(retryAfterSeconds(new Date(61_000).toUTCString(), 1_000)).toBe(60);
    expect(retryAfterSeconds(null)).toBeNull();
    expect(retryAfterSeconds('soon')).toBeNull();
    expect([45, 90, 7_200, 3 * 86_400].map(formatWait)).toEqual(['45 s', '2 min', '2 h', '3 days']);
  });

  it('is an Error, so it can be thrown and caught', () => {
    expect(new GatewayProblem('server', 'x')).toBeInstanceOf(Error);
  });
});

describe('providerName', () => {
  it("names a deployment's provider from its id, and keeps unknown ids as they are", () => {
    expect(providerName('groq-gpt-oss-20b')).toBe('Groq');
    expect(providerName('groq-qwen3.8-27b')).toBe('Groq');
    expect(providerName('gemini-3.5-flash-lite')).toBe('Gemini');
    expect(providerName('mock')).toBe('Mock');
    expect(providerName('ollama-llama3.2')).toBe('Ollama');
    expect(providerName('groqish')).toBe('groqish');
    expect(providerName('acme-large')).toBe('acme-large');
  });
});

describe('servedBy', () => {
  it("gives the provider's logo, and the model family when it is not the provider's own", () => {
    const qwen = servedBy('groq-qwen3.8-27b');
    expect(qwen).toMatchObject({ name: 'Groq', known: true });
    expect(decodeURIComponent(qwen.logo?.src ?? '')).toContain('<title>Groq</title>');
    expect(qwen.family?.name).toBe('Qwen');
    expect(servedBy('groq-gpt-oss-20b').family?.name).toBe('OpenAI');
    expect(servedBy('ollama-llama3.2').family?.name).toBe('Llama');
    expect(servedBy('gemini-3.5-flash-lite').family).toBeNull();
  });

  it('has no logo for the mock (an icon is drawn) or for an unknown deployment', () => {
    expect(servedBy('mock')).toMatchObject({ name: 'Mock', logo: null, known: true });
    expect(servedBy('acme-large')).toMatchObject({ name: 'acme-large', logo: null, known: false });
  });
});
