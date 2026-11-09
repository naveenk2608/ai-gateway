import { describe, expect, it } from 'vitest';
import { GatewayError } from '../errors.js';
import { parseIdempotencyKey, requestFingerprint } from './idempotency.js';

/** The 400's message, or the key when it parses. */
function parse(value: string | string[] | undefined): string | undefined {
  try {
    return parseIdempotencyKey(value);
  } catch (err) {
    if (err instanceof GatewayError) {
      expect(err.httpStatus).toBe(400);
      expect(err.code).toBe('invalid_idempotency_key');
      return `400: ${err.message.split('.')[0]}`;
    }
    throw err;
  }
}

describe('parseIdempotencyKey (RFC 9651 String, draft -08)', () => {
  it('reads a quoted key, as the draft shows it', () => {
    expect(parse('"8e03978e-40d5-43e8-bc93-6894a57f9324"')).toBe(
      '8e03978e-40d5-43e8-bc93-6894a57f9324',
    );
    expect(parse('  "a b"  ')).toBe('a b');
    expect(parse('"say \\"hi\\" \\\\ bye"')).toBe('say "hi" \\ bye');
    expect(parse(undefined)).toBeUndefined();
  });

  it('refuses anything that is not one String of 1 to 255 printable ASCII characters', () => {
    expect(parse('8e03978e')).toBe('400: The Idempotency-Key header is not a quoted string');
    expect(parse('"open')).toBe('400: The Idempotency-Key header has no closing quote');
    expect(parse('"a\\nb"')).toMatch(/escapes a character other than/);
    expect(parse('"tab\there"')).toMatch(/not printable ASCII/);
    expect(parse('"é"')).toMatch(/not printable ASCII/);
    expect(parse('"a";p=1')).toMatch(/something after the quoted string/);
    expect(parse('"a", "b"')).toMatch(/something after the quoted string/);
    expect(parse('""')).toMatch(/is empty/);
    expect(parse(`"${'k'.repeat(256)}"`)).toMatch(/longer than 255/);
    expect(parse(`"${'k'.repeat(255)}"`)).toBe('k'.repeat(255));
    expect(parse(['"a"', '"b"'])).toMatch(/more than once/);
  });
});

describe('requestFingerprint', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.5,
  };

  it('ignores stream, stream_options, user and the order of keys', () => {
    const fp = requestFingerprint(body);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      requestFingerprint({
        temperature: 0.5,
        user: 'u-1',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ content: 'hi', role: 'user' }],
        model: 'm',
      }),
    ).toBe(fp);
  });

  it('changes with anything else in the body', () => {
    const fp = requestFingerprint(body);
    expect(requestFingerprint({ ...body, temperature: 0.6 })).not.toBe(fp);
    expect(requestFingerprint({ ...body, messages: [{ role: 'user', content: 'hi!' }] })).not.toBe(
      fp,
    );
    expect(requestFingerprint({ ...body, max_tokens: 5 })).not.toBe(fp);
  });
});
