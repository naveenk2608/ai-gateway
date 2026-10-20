import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type FakeHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

export interface FakeUpstream {
  url: string;
  requests: RecordedRequest[];
  /** Responses whose connection closed before they finished (the caller hung up). */
  readonly closedEarly: number;
  close(): Promise<void>;
}

/** A local HTTP server standing in for a model provider, for adapter and gateway tests. */
export async function startFakeUpstream(handler: FakeHandler): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  let closedEarly = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      res.on('close', () => {
        if (!res.writableFinished) closedEarly++;
      });
      void Promise.resolve(handler(recorded, res)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get closedEarly() {
      return closedEarly;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** An OpenAI-style SSE body for the given text chunks. */
export function openAIStream(parts: string[], finishReason = 'stop', withUsage = true): string {
  const chunk = (choices: unknown[], usage: unknown = undefined) =>
    `data: ${JSON.stringify({ id: 'up-1', object: 'chat.completion.chunk', choices, ...(usage ? { usage } : {}) })}\n\n`;
  return [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    ...parts.map((text) => chunk([{ index: 0, delta: { content: text }, finish_reason: null }])),
    chunk([{ index: 0, delta: {}, finish_reason: finishReason }]),
    ...(withUsage
      ? [
          chunk([], {
            prompt_tokens: 5,
            completion_tokens: parts.length,
            total_tokens: 5 + parts.length,
          }),
        ]
      : []),
    'data: [DONE]\n\n',
  ].join('');
}
