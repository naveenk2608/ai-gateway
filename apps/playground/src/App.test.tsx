// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { Stores } from './settings.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const KEY = `gw_${'a1'.repeat(8)}_${'b2'.repeat(32)}`;
const GATEWAY = 'https://gw.example.com';

class MemoryStorage implements Storage {
  readonly items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

/** Stores holding a saved connection (key in this tab only), or nothing. */
function stores(withKey = true) {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  if (withKey) {
    local.setItem('ai-gateway.playground.url', GATEWAY);
    session.setItem('ai-gateway.playground.key', KEY);
  }
  return { local, session, stores: { local, session } satisfies Stores };
}

/** The URL a fetch call was made to; the client always passes a string. */
const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const encoder = new TextEncoder();
const event = (payload: unknown) =>
  encoder.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
const text = (content: string) => event({ choices: [{ index: 0, delta: { content } }] });

/**
 * A gateway: GET /v1/models lists two models; a chat streams `pieces`, then (unless `hold`) the
 * usage and [DONE]. Aborting the request errors the body, as a browser does.
 */
function stubGateway({ pieces = ['Hel', 'lo'], hold = false, models = 200 } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.endsWith('/v1/models')) {
      return Promise.resolve(
        models === 200
          ? Response.json({
              object: 'list',
              data: [{ id: 'qwen3' }, { id: 'chat-default' }],
            })
          : Response.json(
              { error: { code: 'invalid_api_key', message: 'This API key has been revoked.' } },
              { status: models },
            ),
      );
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () =>
          controller.error(new DOMException('The request was aborted.', 'AbortError')),
        );
        for (const piece of pieces) controller.enqueue(text(piece));
        if (hold) return;
        controller.enqueue(event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        controller.enqueue(
          event({
            choices: [],
            usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
          }),
        );
        controller.enqueue(event('[DONE]'));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'x-request-id': '0192f5a0-0000-7000-8000-0000000000cc',
          'x-gateway-deployment': 'gemini-3.5-flash-lite',
          'x-gateway-fallback-from': 'groq-gpt-oss-20b',
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function send(message: string) {
  const box = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(box, { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('the playground', () => {
  it('asks for a key first and calls nothing without one', () => {
    const fetchMock = stubGateway();
    render(<App stores={stores(false).stores} />);
    expect(screen.getByText('Add a gateway API key in Connection to start.')).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).disabled).toBe(
      true,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fills the model list from GET /v1/models and picks chat-default', async () => {
    const fetchMock = stubGateway();
    render(<App stores={stores().stores} />);
    const select = await screen.findByRole<HTMLSelectElement>('combobox');
    expect([...select.options].map((o) => o.value)).toEqual(['qwen3', 'chat-default']);
    expect(select.value).toBe('chat-default');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${GATEWAY}/v1/models`);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('streams a reply and shows the model, the provider after a fallback, tokens and request ID', async () => {
    const fetchMock = stubGateway();
    render(<App stores={stores().stores} />);
    await send('Say hello');
    expect(await screen.findByText('Hello')).toBeTruthy();
    const meta = await screen.findByLabelText('Reply details');
    expect(within(meta).getByText('chat-default')).toBeTruthy();
    expect(meta.textContent).toContain('Gemini · gemini-3.5-flash-lite');
    expect(within(meta).getByText('fell back from Groq · groq-gpt-oss-20b')).toBeTruthy();
    expect(await within(meta).findByText('9 in · 2 out')).toBeTruthy();
    expect(within(meta).getByText(/^first text \d/)).toBeTruthy();
    expect(
      within(meta).getByRole('button', {
        name: 'Copy request ID 0192f5a0-0000-7000-8000-0000000000cc',
      }),
    ).toBeTruthy();
    // Every call went to the gateway.
    expect(fetchMock.mock.calls.every(([url]) => urlOf(url).startsWith(`${GATEWAY}/v1/`))).toBe(
      true,
    );
  });

  it('sends the earlier turns with the next message', async () => {
    const fetchMock = stubGateway();
    render(<App stores={stores().stores} />);
    await send('First');
    await screen.findByText('9 in · 2 out');
    await send('Second');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(fetchMock.mock.calls[2]![1]!.body as string) as {
      messages: unknown[];
    };
    expect(body.messages).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Second' },
    ]);
  });

  it('stops a streaming reply, keeping what arrived', async () => {
    stubGateway({ pieces: ['Partial'], hold: true });
    render(<App stores={stores().stores} />);
    await send('Go on');
    expect(await screen.findByText('Partial')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('stopped')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('starts a new chat', async () => {
    stubGateway();
    render(<App stores={stores().stores} />);
    await send('Hi');
    await screen.findByText('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('Hello')).toBeNull();
    expect(screen.getByText(/^Send a message to chat-default/)).toBeTruthy();
  });

  it('explains a rejected key', async () => {
    stubGateway({ models: 401 });
    render(<App stores={stores().stores} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The gateway rejected this API key');
    expect(alert.textContent).toContain('This API key has been revoked.');
  });

  it('saves a new key to this tab only, then connects with it', async () => {
    const fetchMock = stubGateway();
    const { local, session, stores: s } = stores(false);
    render(<App stores={s} />);
    const form = screen.getByRole('form', { name: 'Connection settings' });
    fireEvent.change(within(form).getByLabelText('Gateway URL'), { target: { value: GATEWAY } });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: KEY } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save and connect' }));
    await screen.findByRole('combobox');
    expect([...session.items.values()]).toContain(KEY);
    expect([...local.items.values()]).not.toContain(KEY);
    expect(urlOf(fetchMock.mock.calls[0]![0])).toBe(`${GATEWAY}/v1/models`);
  });

  it('refuses a key that is not a gateway key, without calling anything', () => {
    const fetchMock = stubGateway();
    render(<App stores={stores(false).stores} />);
    const form = screen.getByRole('form', { name: 'Connection settings' });
    fireEvent.change(within(form).getByLabelText('API key'), { target: { value: 'sk-other' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save and connect' }));
    expect(within(form).getByRole('alert').textContent).toMatch(/looks like gw_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
