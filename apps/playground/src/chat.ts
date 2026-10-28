import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GatewayProblem,
  streamChat,
  type ChatMessage,
  type Connection,
  type Served,
  type Usage,
} from './gateway.js';

/** After this long without response headers, the reply says the gateway may be waking up. */
export const SLOW_AFTER_MS = 4_000;

export interface UserTurn {
  id: number;
  role: 'user';
  content: string;
}

export interface ReplyTurn {
  id: number;
  role: 'assistant';
  model: string;
  content: string;
  status: 'waiting' | 'streaming' | 'done' | 'stopped' | 'failed';
  /** No response headers yet after SLOW_AFTER_MS. */
  slow: boolean;
  served: Served | null;
  /** Measured in this browser, from sending: so they include network time (and any wake-up). */
  firstTextMs: number | null;
  totalMs: number | null;
  usage: Usage | null;
  finishReason: string | null;
  problem: GatewayProblem | null;
}

export type Turn = UserTurn | ReplyTurn;

/** The conversation as the API takes it: every turn with text, failed replies left out. */
export function history(turns: Turn[]): ChatMessage[] {
  return turns.flatMap((t): ChatMessage[] =>
    t.role === 'user'
      ? [{ role: 'user' as const, content: t.content }]
      : t.content !== '' && (t.status === 'done' || t.status === 'stopped')
        ? [{ role: 'assistant' as const, content: t.content }]
        : [],
  );
}

/**
 * The chat: turns in memory only (nothing about the conversation is stored), one reply streaming
 * at a time.
 */
export function useChat(connection: Connection | null, model: string) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const nextId = useRef(1);
  const running = useRef<AbortController | null>(null);

  // Stop a running reply when the page goes away.
  useEffect(() => () => running.current?.abort(), []);

  const update = useCallback((id: number, change: Partial<ReplyTurn>) => {
    setTurns((all) =>
      all.map((t) => (t.id === id && t.role === 'assistant' ? { ...t, ...change } : t)),
    );
  }, []);

  /** Streams a reply to the conversation in `before`, which ends with a user turn. */
  const reply = useCallback(
    (before: Turn[]) => {
      if (!connection || running.current) return;
      const id = nextId.current++;
      const turn: ReplyTurn = {
        id,
        role: 'assistant',
        model,
        content: '',
        status: 'waiting',
        slow: false,
        served: null,
        firstTextMs: null,
        totalMs: null,
        usage: null,
        finishReason: null,
        problem: null,
      };
      setTurns([...before, turn]);
      const controller = new AbortController();
      running.current = controller;
      const started = performance.now();
      const elapsed = () => performance.now() - started;
      let served = false;
      let firstText: number | null = null;
      const slow = setTimeout(() => {
        if (!served) update(id, { slow: true });
      }, SLOW_AFTER_MS);

      void streamChat(
        connection,
        { model, messages: history(before) },
        {
          onServed: (info) => {
            served = true;
            update(id, { served: info, slow: false, status: 'streaming' });
          },
          onText: (text) => {
            firstText ??= elapsed();
            setTurns((all) =>
              all.map((t) =>
                t.id === id && t.role === 'assistant'
                  ? { ...t, content: t.content + text, firstTextMs: firstText }
                  : t,
              ),
            );
          },
        },
        controller.signal,
      )
        .then(
          (outcome) =>
            update(id, {
              status: 'done',
              totalMs: elapsed(),
              usage: outcome.usage,
              finishReason: outcome.finishReason,
            }),
          (err: unknown) => {
            if (controller.signal.aborted) {
              update(id, { status: 'stopped', slow: false, totalMs: elapsed() });
              return;
            }
            const problem =
              err instanceof GatewayProblem
                ? err
                : new GatewayProblem('server', 'Something went wrong while reading the reply.');
            update(id, { status: 'failed', slow: false, totalMs: elapsed(), problem });
          },
        )
        .finally(() => {
          clearTimeout(slow);
          if (running.current === controller) running.current = null;
        });
    },
    [connection, model, update],
  );

  const send = useCallback(
    (text: string) => {
      const content = text.trim();
      if (content === '') return;
      reply([...turns, { id: nextId.current++, role: 'user', content }]);
    },
    [turns, reply],
  );

  /** Sends the conversation again without the last reply, which failed. */
  const retry = useCallback(() => {
    const last = turns.at(-1);
    if (last?.role !== 'assistant' || last.status !== 'failed') return;
    reply(turns.slice(0, -1));
  }, [turns, reply]);

  const stop = useCallback(() => running.current?.abort(), []);

  const reset = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setTurns([]);
  }, []);

  const busy = turns.some(
    (t) => t.role === 'assistant' && (t.status === 'waiting' || t.status === 'streaming'),
  );
  return { turns, busy, send, retry, stop, reset };
}
