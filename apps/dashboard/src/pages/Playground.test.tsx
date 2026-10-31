// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ID } from '../../e2e/fixtures.js';
import type { ModelCatalog, RequestDetail, Role } from '../api.js';
import { Playground } from './Playground.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const KEY = `gw_${'a1'.repeat(8)}_${'b2'.repeat(32)}`;
const API_KEY_ID = '0192f5a0-0000-7000-8000-0000000000aa';
const REQUEST_ID = '0192f5a0-0000-7000-8000-0000000000cc';
const KEYS_PATH = `/admin/projects/${PROJECT_ID}/api-keys`;

const deployment = (id: string, provider: string, providerModel: string) => ({
  id,
  provider,
  providerModel,
  enabled: true,
  timeoutMs: 30_000,
  streamIdleTimeoutMs: 30_000,
  maxOutputTokens: 1_024,
});

const catalog: ModelCatalog = {
  deployments: [
    deployment('groq-gpt-oss-20b', 'openai-compatible', 'openai/gpt-oss-20b'),
    deployment('gemini-3.5-flash-lite', 'openai-compatible', 'gemini-3.5-flash-lite'),
  ],
  models: [],
};

const detail = {
  id: REQUEST_ID,
  usage: {
    source: 'reported',
    promptTokens: 9,
    completionTokens: 2,
    totalTokens: 11,
    costMicroUsd: 1_250,
  },
} as RequestDetail;

const encoder = new TextEncoder();
const event = (payload: unknown) =>
  encoder.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
const text = (content: string) => event({ choices: [{ index: 0, delta: { content } }] });

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * The gateway: the admin API creates and revokes keys, lists the catalog and the recorded
 * request; /v1 lists two models and streams `pieces`, then (unless `hold`) usage and [DONE].
 * With `chatStatus`, the chat fails with that status instead.
 */
function stubGateway({
  pieces = ['Hel', 'lo'],
  hold = false,
  chatStatus = 200,
  recorded = detail,
}: { pieces?: string[]; hold?: boolean; chatStatus?: number; recorded?: RequestDetail } = {}) {
  let keys = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = urlOf(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && path === KEYS_PATH) {
      keys += 1;
      return Promise.resolve(
        Response.json(
          {
            apiKey: {
              id: `${API_KEY_ID.slice(0, -2)}${String(keys).padStart(2, '0')}`,
              name: 'playground',
              status: 'expiring',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
            key: KEY,
          },
          { status: 201 },
        ),
      );
    }
    if (method === 'POST' && path.endsWith('/revoke')) return Promise.resolve(Response.json({}));
    if (path === '/admin/models') return Promise.resolve(Response.json(catalog));
    if (path === `/admin/requests/${REQUEST_ID}`) return Promise.resolve(Response.json(recorded));
    if (path === '/v1/models') {
      return Promise.resolve(
        Response.json({ object: 'list', data: [{ id: 'qwen3' }, { id: 'chat-default' }] }),
      );
    }
    if (path === '/v1/chat/completions' && chatStatus !== 200) {
      return Promise.resolve(
        Response.json(
          { error: { code: 'invalid_api_key', message: 'This API key has expired.' } },
          { status: chatStatus, headers: { 'x-request-id': REQUEST_ID } },
        ),
      );
    }
    if (path === '/v1/chat/completions') {
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
            'x-request-id': REQUEST_ID,
            'x-gateway-deployment': 'gemini-3.5-flash-lite',
            'x-gateway-fallback-from': 'groq-gpt-oss-20b',
          },
        }),
      );
    }
    return Promise.resolve(Response.json({ error: { code: 'not_found' } }, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function show(role: Role = 'owner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Playground projectId={PROJECT_ID} role={role} />
    </QueryClientProvider>,
  );
}

type Call = [RequestInfo | URL, RequestInit | undefined];
const callsTo = (fetchMock: ReturnType<typeof stubGateway>, path: string) =>
  (fetchMock.mock.calls as Call[]).filter(([url]) => urlOf(url) === path);
const bearer = (init: RequestInit | undefined) =>
  (init?.headers as Record<string, string> | undefined)?.authorization;

async function send(message: string) {
  const box = await screen.findByRole('textbox', { name: 'Message' });
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(box, { target: { value: message } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('the Playground page', () => {
  it('tells a viewer why it is not available, and creates no key', () => {
    const fetchMock = stubGateway();
    show('viewer');
    expect(screen.getByText(/only owners and admins may create keys/)).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a one-hour "playground" key, then lists the models with it', async () => {
    const fetchMock = stubGateway();
    show('admin');
    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Model' });
    expect([...select.options].map((o) => o.value)).toEqual(['qwen3', 'chat-default']);
    expect(select.value).toBe('chat-default');

    const [create] = callsTo(fetchMock, KEYS_PATH);
    expect(JSON.parse(create![1]!.body as string)).toEqual({
      name: 'playground',
      expiresInSeconds: 3600,
    });
    const [models] = callsTo(fetchMock, '/v1/models');
    expect(bearer(models![1])).toBe(`Bearer ${KEY}`);
    expect(models![1]).toMatchObject({ credentials: 'omit' });
    expect(screen.getByRole('status').textContent).toMatch(/held only in this page/);
  });

  it('streams a reply with its model, provider, fallback, tokens, cost and request link', async () => {
    const fetchMock = stubGateway();
    show();
    await send('Say hello');
    expect(await screen.findByText('Hello')).toBeTruthy();
    const meta = await screen.findByLabelText('Reply details');
    expect(within(meta).getByText('chat-default')).toBeTruthy();
    expect(within(meta).getByText('Gemini')).toBeTruthy();
    expect(within(meta).getByText('gemini-3.5-flash-lite')).toBeTruthy();
    expect(within(meta).getByText('fell back from Groq · groq-gpt-oss-20b')).toBeTruthy();
    expect(await within(meta).findByText('9 in · 2 out')).toBeTruthy();
    expect(within(meta).getByText(/^first text \d/)).toBeTruthy();
    expect(await within(meta).findByText('$0.001250')).toBeTruthy();
    const link = within(meta).getByRole<HTMLAnchorElement>('link', {
      name: `Open request ${REQUEST_ID} on the Requests page`,
    });
    expect(link.getAttribute('href')).toBe(`#requests/${REQUEST_ID}`);
    expect(link.target).toBe('_blank');

    // The key goes to /v1 only; admin calls rely on the session cookie.
    for (const [url, init] of fetchMock.mock.calls as Call[]) {
      expect(bearer(init) !== undefined).toBe(urlOf(url).startsWith('/v1/'));
    }
  });

  it('sends the earlier turns with the next message', async () => {
    const fetchMock = stubGateway();
    show();
    await send('First');
    await screen.findByText('9 in · 2 out');
    await send('Second');
    await waitFor(() => expect(callsTo(fetchMock, '/v1/chat/completions')).toHaveLength(2));
    const body = JSON.parse(callsTo(fetchMock, '/v1/chat/completions')[1]![1]!.body as string) as {
      messages: unknown[];
    };
    expect(body.messages).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Second' },
    ]);
  });

  it('says when the model has no price, rather than showing a cost', async () => {
    stubGateway({ recorded: { ...detail, usage: { ...detail.usage!, costMicroUsd: null } } });
    show();
    await send('Hi');
    const meta = await screen.findByLabelText('Reply details');
    expect(await within(meta).findByText('no price for this model')).toBeTruthy();
  });

  it('stops a streaming reply, keeping what arrived, and starts a new chat', async () => {
    stubGateway({ pieces: ['Partial'], hold: true });
    show();
    await send('Go on');
    expect(await screen.findByText('Partial')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('stopped')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('Partial')).toBeNull();
    expect(screen.getByText(/^Send a message to chat-default/)).toBeTruthy();
  });

  it('offers a new key when the gateway rejects the current one', async () => {
    const fetchMock = stubGateway({ chatStatus: 401 });
    show();
    await send('Hi');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("The Playground's key was rejected");
    fireEvent.click(within(alert).getByRole('button', { name: 'Start a new key' }));
    await waitFor(() => expect(callsTo(fetchMock, KEYS_PATH)).toHaveLength(2));
    // The replaced key is revoked.
    await waitFor(() =>
      expect(callsTo(fetchMock, `${KEYS_PATH}/${API_KEY_ID.slice(0, -2)}01/revoke`)).toHaveLength(
        1,
      ),
    );
  });

  it('revokes its key when the page goes away, even as the tab closes', async () => {
    const fetchMock = stubGateway();
    const view = show();
    await screen.findByRole('combobox', { name: 'Model' });
    view.unmount();
    const [revoke] = callsTo(fetchMock, `${KEYS_PATH}/${API_KEY_ID.slice(0, -2)}01/revoke`);
    expect(revoke![1]).toMatchObject({ method: 'POST', keepalive: true });
  });
});
