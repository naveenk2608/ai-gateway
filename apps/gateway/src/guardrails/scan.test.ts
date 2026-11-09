import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../providers/types.js';
import type { OpenStream } from '../proxy/attempt.js';
import type { ChatCompletionRequest } from '../proxy/schema.js';
import { guardrailPolicySchema, type GuardrailPolicyInput } from './policy.js';
import {
  answerMatchesFormat,
  blockingError,
  Findings,
  scanAnswer,
  scanChatInput,
  scanEmbeddingsInput,
  scanStream,
} from './scan.js';

const policy = (input: GuardrailPolicyInput) => guardrailPolicySchema.parse(input);

describe('scanChatInput', () => {
  it('masks every text a provider sees and counts images without reading them', () => {
    const findings = new Findings();
    const body: ChatCompletionRequest = {
      model: 'm',
      messages: [
        { role: 'system', content: 'Escalate to ops@example.com' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'My card is 4111 1111 1111 1111' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"email":"jane@example.com"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'Found: call 9876543210' },
      ],
    };
    const masked = scanChatInput(
      body,
      policy({ input: { email: 'mask', card: 'mask', phone: 'flag' } }),
      findings,
    );
    expect(JSON.stringify(masked)).not.toMatch(/example\.com"|4111 1111|ops@/);
    expect(masked.messages[0]!.content).toBe('Escalate to [EMAIL]');
    expect(JSON.stringify(masked.messages[1]!.content)).toContain('My card is [CARD]');
    expect(JSON.stringify(masked.messages[1]!.content)).toContain('https://example.com/a.png');
    expect(masked.messages[2]).toMatchObject({
      tool_calls: [{ function: { arguments: '{"email":"[EMAIL]"}' } }],
    });
    // Flagged, not masked.
    expect(masked.messages[3]!.content).toBe('Found: call 9876543210');
    expect(findings.list()).toEqual(
      expect.arrayContaining([
        { stage: 'input', check: 'email', count: 2, action: 'mask' },
        { stage: 'input', check: 'card', count: 1, action: 'mask' },
        { stage: 'input', check: 'phone', count: 1, action: 'flag' },
        { stage: 'input', check: 'image', count: 1, action: 'none' },
      ]),
    );
    // The original request is unchanged.
    expect(body.messages[0]!.content).toBe('Escalate to ops@example.com');
  });

  it('names the blocked type, never the value, and counts blocked words', () => {
    const findings = new Findings();
    scanChatInput(
      { model: 'm', messages: [{ role: 'user', content: 'PAN ABCPE1234F, the Secret plan' }] },
      policy({ input: { pan: 'block' }, blockedTerms: { terms: ['secret plan'], action: 'flag' } }),
      findings,
    );
    const error = blockingError(findings);
    expect(error).toMatchObject({ code: 'guardrail_blocked', httpStatus: 400 });
    expect(error!.message).toBe(
      "The request contains a PAN, which this project's guardrails do not allow.",
    );
    expect(error!.message).not.toContain('ABCPE1234F');
    expect(findings.list()).toContainEqual({
      stage: 'input',
      check: 'blocked_terms',
      count: 1,
      action: 'flag',
    });
  });

  it('leaves the request as it is with no checks on', () => {
    const body: ChatCompletionRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'jane@example.com' }],
    };
    expect(scanChatInput(body, policy({}), new Findings())).toBe(body);
  });

  it('masks embeddings input', () => {
    const findings = new Findings();
    expect(
      scanEmbeddingsInput(
        ['a jane@example.com', 'b'],
        policy({ input: { email: 'mask' } }),
        findings,
      ),
    ).toEqual(['a [EMAIL]', 'b']);
  });
});

/** A stream that yields `events` in order. */
function streamOf(events: StreamEvent[]): OpenStream {
  const rest = events.slice(1);
  return {
    first: { done: false, value: events[0]! },
    next: () =>
      Promise.resolve(
        rest.length > 0 ? { done: false, value: rest.shift()! } : { done: true, value: undefined },
      ),
    close: () => {},
  };
}

async function drain(stream: OpenStream): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  let r = stream.first;
  while (!r.done) {
    out.push(r.value);
    r = await stream.next();
  }
  return out;
}

describe('scanStream', () => {
  it('masks a value split across two chunks, holding back what a match could still need', async () => {
    const findings = new Findings();
    const events = await drain(
      scanStream(
        streamOf([
          { type: 'content', text: 'Write to jane.d' },
          { type: 'content', text: 'oe@example.com, card 4111 1111 ' },
          { type: 'content', text: '1111 1111 thanks' },
          { type: 'finish', finishReason: 'stop', usage: null },
        ]),
        policy({ output: { email: 'mask', card: 'mask' } }),
        findings,
      ),
    );
    const text = events.map((e) => (e.type === 'content' ? e.text : '')).join('');
    expect(text).toBe('Write to [EMAIL], card [CARD] thanks');
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    expect(findings.list()).toEqual(
      expect.arrayContaining([
        { stage: 'output', check: 'email', count: 1, action: 'mask' },
        { stage: 'output', check: 'card', count: 1, action: 'mask' },
      ]),
    );
  });

  it('sends text on once it is more than the hold-back behind', async () => {
    const long = 'x'.repeat(600);
    const events = await drain(
      scanStream(
        streamOf([
          { type: 'content', text: long },
          { type: 'finish', finishReason: 'stop', usage: null },
        ]),
        policy({ output: { email: 'mask' } }),
        new Findings(),
      ),
    );
    expect(events[0]).toEqual({ type: 'content', text: 'x'.repeat(600 - 256) });
    expect(events[1]).toEqual({ type: 'content', text: 'x'.repeat(256) });
  });

  it('masks tool-call arguments in answers', () => {
    const findings = new Findings();
    const answer = scanAnswer(
      {
        content: 'Call 9876543210',
        toolCalls: [{ id: 'c', name: 'f', arguments: '{"to":"jane@example.com"}' }],
        finishReason: 'tool_calls',
        usage: null,
      },
      policy({ output: { email: 'mask', phone: 'flag' } }),
      findings,
    );
    expect(answer.content).toBe('Call 9876543210');
    expect(answer.toolCalls![0]!.arguments).toBe('{"to":"[EMAIL]"}');
  });
});

describe('answerMatchesFormat', () => {
  const answer = (content: string) => ({ content, finishReason: 'stop' as const, usage: null });
  const format = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'city',
      schema: {
        type: 'object',
        properties: { city: { type: 'string' }, population: { type: 'number' } },
        required: ['city', 'population'],
        additionalProperties: false,
      },
    },
  };

  it('checks a JSON answer against its schema, and json_object answers only parse', () => {
    expect(answerMatchesFormat(format, answer('{"city":"Pune","population":7.2}'))).toBe(true);
    expect(answerMatchesFormat(format, answer('{"city":"Pune"}'))).toBe(false);
    expect(answerMatchesFormat(format, answer('{"city":"Pune","population":"many"}'))).toBe(false);
    expect(answerMatchesFormat(format, answer('not json'))).toBe(false);
    expect(answerMatchesFormat({ type: 'json_object' }, answer('{"a":1}'))).toBe(true);
    expect(answerMatchesFormat({ type: 'json_object' }, answer('{"a":'))).toBe(false);
    expect(answerMatchesFormat(undefined, answer('anything'))).toBe(true);
  });
});
