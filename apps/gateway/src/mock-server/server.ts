import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock } from '@ai-gateway/shared';
import { z } from 'zod';
import { ProviderError } from '../providers/errors.js';
import { MockProvider, type MockSettings } from '../providers/mock.js';
import type { ChatRequest, FinishReason, Usage } from '../providers/types.js';

const MAX_BODY_BYTES = 1024 * 1024;

// Only the fields the mock reads; the rest of an OpenAI request is accepted and ignored.
const requestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'developer', 'user', 'assistant']),
        content: z.union([
          z.string(),
          z.array(z.object({ type: z.literal('text'), text: z.string() })),
        ]),
      }),
    )
    .min(1),
  max_tokens: z.number().int().positive().nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
});

export interface MockServerOptions {
  settings: MockSettings;
  clock: Clock;
  port: number;
  host: string;
}

export interface MockServer {
  url: string;
  port: number;
  /** The provider behind the server: its stats, and `update()` to change settings in tests. */
  provider: MockProvider;
  close(): Promise<void>;
}

/**
 * The mock provider over HTTP, in OpenAI's chat-completions wire format (M9), so the gateway
 * reaches it through its OpenAI-compatible adapter and a benchmark can call it directly. Timing,
 * seeded errors and drops come from the same MockProvider the gateway runs in-process.
 *
 * Routes: `POST /v1/chat/completions`, `GET /v1/models` (the adapter's health check),
 * `GET /health` and `GET /stats` (the provider's counters).
 */
export async function startMockServer(options: MockServerOptions): Promise<MockServer> {
  const provider = new MockProvider(options.settings, options.clock);
  let nextId = 0;

  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      const id = `chatcmpl-mock-${++nextId}`;
      void completions(req, res, provider, options.clock, id).catch(() => res.destroy());
      return;
    }
    const read: Record<string, () => unknown> = {
      '/v1/models': () => ({ object: 'list', data: [{ id: 'mock', object: 'model' }] }),
      '/health': () => ({ status: 'ok' }),
      '/stats': () => provider.stats(),
    };
    const handler = path === undefined ? undefined : read[path];
    if (!handler) return sendError(res, 404, 'not_found', 'invalid_request_error', 'not found');
    if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
    sendJson(res, 200, handler());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    port,
    provider,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function completions(
  req: IncomingMessage,
  res: ServerResponse,
  provider: MockProvider,
  clock: Clock,
  id: string,
): Promise<void> {
  const raw = await readBody(req);
  if (raw === undefined) {
    return sendError(res, 413, null, 'invalid_request_error', 'request body too large');
  }
  let parsed: z.output<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(JSON.parse(raw));
  } catch {
    return sendError(res, 400, null, 'invalid_request_error', 'invalid chat completion request');
  }

  const chat: ChatRequest = {
    model: parsed.model,
    messages: parsed.messages,
    ...(parsed.max_tokens ? { maxTokens: parsed.max_tokens } : {}),
  };
  const head = { id, created: Math.floor(clock.now() / 1000), model: parsed.model };
  // The caller hanging up aborts the provider, as a client disconnect does in the gateway.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  if (!parsed.stream) {
    try {
      const result = await provider.chat(chat, controller.signal);
      sendJson(res, 200, {
        ...head,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content },
            finish_reason: result.finishReason,
          },
        ],
        usage: result.usage && wireUsage(result.usage),
      });
    } catch (err) {
      failRequest(res, err);
    }
    return;
  }

  const includeUsage = parsed.stream_options?.include_usage === true;
  const chunk = (delta: object, finishReason: FinishReason | null) => ({
    ...head,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  try {
    for await (const event of provider.chatStream(chat, controller.signal)) {
      if (!res.headersSent) {
        // Headers leave with the first token, as the gateway sends them, so time to first byte
        // is the time to first token on both paths.
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
      }
      if (event.type === 'content') {
        await writeEvent(res, chunk({ content: event.text }, null));
        continue;
      }
      await writeEvent(res, chunk({}, event.finishReason));
      if (includeUsage && event.usage) {
        await writeEvent(res, {
          ...head,
          object: 'chat.completion.chunk',
          choices: [],
          usage: wireUsage(event.usage),
        });
      }
      res.end('data: [DONE]\n\n');
    }
  } catch (err) {
    failRequest(res, err);
  }
}

function wireUsage(usage: Usage) {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
  };
}

/**
 * A forced 429 or 500 becomes that status with an OpenAI-style error body. Anything else (a drop,
 * an abort, or a failure after the first byte) cuts the connection, as a broken upstream would.
 */
function failRequest(res: ServerResponse, err: unknown): void {
  if (res.headersSent && res.socket) {
    // Mid-stream: the tokens written so far still arrive, then the body stops unterminated.
    res.socket.end();
    return;
  }
  if (res.headersSent || !(err instanceof ProviderError)) {
    res.destroy();
    return;
  }
  if (err.kind === 'rate_limited') {
    const seconds = Math.ceil((err.retryAfterMs ?? 0) / 1000);
    res.setHeader('retry-after', String(seconds));
    return sendError(res, 429, 'rate_limit_exceeded', 'requests', err.message);
  }
  if (err.kind === 'server_error') return sendError(res, 500, null, 'server_error', err.message);
  res.destroy();
}

function writeEvent(res: ServerResponse, data: object): Promise<void> {
  if (res.write(`data: ${JSON.stringify(data)}\n\n`)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** The request body as text, or undefined past MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string | null,
  type: string,
  message: string,
): void {
  sendJson(res, status, { error: { message, type, param: null, code } });
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  sendError(res, 405, null, 'invalid_request_error', 'method not allowed');
}
