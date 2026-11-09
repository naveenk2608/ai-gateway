import { Ajv, type ValidateFunction } from 'ajv';
import { GatewayError } from '../errors.js';
import type { ChatResult, StreamEvent } from '../providers/types.js';
import type { OpenStream } from '../proxy/attempt.js';
import type { ChatCompletionMessage, ChatCompletionRequest } from '../proxy/schema.js';
import {
  blockedTermsPattern,
  DETECTOR_LABEL,
  findMatches,
  maskMatches,
  MAX_MATCH_LENGTH,
  type DetectorType,
} from './detectors.js';
import { activeTypes, type GuardrailPolicy } from './policy.js';

/**
 * What a check found and did, for the request's record (ADR 035): a type and a count, never a
 * value. `check` is a detector type, `blocked_terms`, `prompt_size`, `schema` or `image`.
 */
export interface GuardrailFinding {
  stage: 'input' | 'output';
  check: string;
  count: number;
  action: 'mask' | 'block' | 'flag' | 'retry' | 'fail' | 'none';
}

/** Adds up findings per (stage, check, action). */
export class Findings {
  readonly #byKey = new Map<string, GuardrailFinding>();

  add(stage: GuardrailFinding['stage'], check: string, action: GuardrailFinding['action'], n = 1) {
    if (n <= 0) return;
    const key = `${stage}|${check}|${action}`;
    const found = this.#byKey.get(key);
    if (found) found.count += n;
    else this.#byKey.set(key, { stage, check, count: n, action });
  }

  list(): GuardrailFinding[] {
    return [...this.#byKey.values()];
  }
}

/** Scans text with one stage's detector actions and blocked terms, masking as told. */
class Scanner {
  readonly #actions: Record<DetectorType, string>;
  readonly #enabled: Set<DetectorType>;
  readonly #mask: Set<DetectorType>;
  readonly #terms: RegExp | null;
  readonly #termsAction: 'block' | 'flag';
  readonly #stage: GuardrailFinding['stage'];
  readonly #findings: Findings;

  constructor(
    stage: GuardrailFinding['stage'],
    actions: Record<DetectorType, string>,
    findings: Findings,
    terms?: GuardrailPolicy['blockedTerms'],
  ) {
    this.#stage = stage;
    this.#actions = actions;
    this.#enabled = activeTypes(actions);
    this.#mask = activeTypes(actions, 'mask');
    this.#terms = terms ? blockedTermsPattern(terms.terms) : null;
    this.#termsAction = terms?.action ?? 'flag';
    this.#findings = findings;
  }

  get active(): boolean {
    return this.#enabled.size > 0 || this.#terms !== null;
  }

  /** `text` with the values to mask replaced; every match is counted. */
  scan(text: string): string {
    const matches = findMatches(text, this.#enabled);
    for (const m of matches) {
      this.#findings.add(this.#stage, m.type, this.#actions[m.type] as GuardrailFinding['action']);
    }
    if (this.#terms) {
      this.#terms.lastIndex = 0;
      const n = [...text.matchAll(this.#terms)].length;
      this.#findings.add(this.#stage, 'blocked_terms', this.#termsAction, n);
    }
    return this.#mask.size > 0 && matches.length > 0
      ? maskMatches(text, matches, this.#mask)
      : text;
  }

  /** Masked text and whether anything in it is masked, without counting (stream hold-back). */
  matchesIn(text: string) {
    return findMatches(text, this.#mask);
  }

  maskOnly(text: string, upTo: number): { masked: string; cut: number } {
    const matches = this.matchesIn(text);
    let cut = upTo;
    for (const m of matches) if (m.start < cut && m.end > cut) cut = m.start;
    return {
      masked: maskMatches(
        text.slice(0, cut),
        matches.filter((m) => m.end <= cut),
        this.#mask,
      ),
      cut,
    };
  }
}

const blocked = (what: string) =>
  new GatewayError(
    'guardrail_blocked',
    `The request contains ${what}, which this project's guardrails do not allow.`,
    { httpStatus: 400 },
  );

/** The 400 for the first blocking finding, or null: the type is named, never the value. */
export function blockingError(findings: Findings): GatewayError | null {
  const found = findings.list().find((f) => f.stage === 'input' && f.action === 'block');
  if (!found) return null;
  if (found.check === 'blocked_terms') return blocked('a blocked word or phrase');
  return blocked(DETECTOR_LABEL[found.check as DetectorType] ?? found.check);
}

/**
 * Checks every text of a chat request a provider would see (ADR 035): message text in every role
 * (string or text parts), tool results and earlier tool-call arguments. Images are not read, only
 * counted. Returns the request with masked values replaced; blocking is the caller's (after all
 * findings are counted).
 */
export function scanChatInput(
  body: ChatCompletionRequest,
  policy: GuardrailPolicy,
  findings: Findings,
): ChatCompletionRequest {
  const scanner = new Scanner('input', policy.input, findings, policy.blockedTerms);
  if (!scanner.active) return body;
  let images = 0;
  const content = (c: unknown): unknown => {
    if (typeof c === 'string') return scanner.scan(c);
    if (!Array.isArray(c)) return c;
    return c.map((part: { type: string; text?: string }) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return { ...part, text: scanner.scan(part.text) };
      }
      if (part.type === 'image_url') images++;
      return part;
    });
  };
  const messages = body.messages.map((m) => {
    const next = { ...m, content: content(m.content) } as ChatCompletionMessage;
    if (m.role === 'assistant' && m.tool_calls) {
      (next as typeof m).tool_calls = m.tool_calls.map((call) => ({
        ...call,
        function: { ...call.function, arguments: scanner.scan(call.function.arguments) },
      }));
    }
    return next;
  });
  findings.add('input', 'image', 'none', images);
  return { ...body, messages };
}

/** Checks embeddings input the same way. */
export function scanEmbeddingsInput(
  input: string[],
  policy: GuardrailPolicy,
  findings: Findings,
): string[] {
  const scanner = new Scanner('input', policy.input, findings, policy.blockedTerms);
  return scanner.active ? input.map((text) => scanner.scan(text)) : input;
}

/** The answer with the detectors' `mask` values replaced in its text and tool-call arguments. */
export function scanAnswer(
  answer: ChatResult,
  policy: GuardrailPolicy,
  findings: Findings,
): ChatResult {
  const scanner = new Scanner('output', policy.output, findings);
  if (!scanner.active) return answer;
  return {
    ...answer,
    content: scanner.scan(answer.content),
    ...(answer.toolCalls
      ? {
          toolCalls: answer.toolCalls.map((c) => ({ ...c, arguments: scanner.scan(c.arguments) })),
        }
      : {}),
  };
}

/**
 * A stream whose content and tool-call arguments are scanned with the output detectors (ADR 035).
 * Each channel holds back its last MAX_MATCH_LENGTH characters (moved back to the start of a
 * match that reaches past them), so a value split across chunks is found whole; the rest is sent
 * on with values to mask replaced. Everything held back is sent, scanned, before the finish
 * event. Findings are counted once, on each channel's whole text, when the stream finishes.
 */
export function scanStream(
  stream: OpenStream,
  policy: GuardrailPolicy,
  findings: Findings,
): OpenStream {
  const scanner = new Scanner('output', policy.output, findings);
  if (!scanner.active) return stream;
  const held = new Map<string, string>();
  const whole = new Map<string, string>();
  const queue: StreamEvent[] = [];
  const release = (channel: string, text: string, final: boolean): string => {
    const buffer = (held.get(channel) ?? '') + text;
    whole.set(channel, (whole.get(channel) ?? '') + text);
    const upTo = final ? buffer.length : Math.max(0, buffer.length - MAX_MATCH_LENGTH);
    const { masked, cut } = scanner.maskOnly(buffer, upTo);
    held.set(channel, buffer.slice(cut));
    return masked;
  };
  const transform = (r: IteratorResult<StreamEvent>): IteratorResult<StreamEvent> => {
    if (r.done) return r;
    const e = r.value;
    if (e.type === 'content')
      return { done: false, value: { ...e, text: release('c', e.text, false) } };
    if (e.type === 'tool_arguments') {
      return { done: false, value: { ...e, text: release(`t${e.index}`, e.text, false) } };
    }
    if (e.type === 'finish') {
      // Send what is held back first, then the finish event; count findings on the whole text.
      const tail = release('c', '', true);
      if (tail !== '') queue.push({ type: 'content', text: tail });
      for (const channel of [...held.keys()].filter((k) => k.startsWith('t'))) {
        const rest = release(channel, '', true);
        if (rest !== '')
          queue.push({ type: 'tool_arguments', index: Number(channel.slice(1)), text: rest });
      }
      for (const text of whole.values()) scanner.scan(text);
      queue.push(e);
      return { done: false, value: queue.shift()! };
    }
    return r;
  };
  return {
    first: transform(stream.first),
    next: async () => {
      if (queue.length > 0) return { done: false, value: queue.shift()! };
      return transform(await stream.next());
    },
    close: (error?: unknown) => stream.close(error),
  };
}

const ajv = new Ajv({ strict: false, allErrors: false, validateSchema: true });
/** Compiled schemas by their JSON text; at most a few hundred kept. */
const compiled = new Map<string, ValidateFunction | null>();

/**
 * Whether a JSON answer is acceptable (ADR 035): for `json_schema` it parses and matches the
 * schema (Ajv), for `json_object` it parses. True when the request asked for no JSON, the answer
 * is a tool call, or the schema cannot be compiled (nothing to check against).
 */
export function answerMatchesFormat(
  format: ChatCompletionRequest['response_format'],
  answer: ChatResult,
): boolean {
  if (!format || format.type === 'text') return true;
  if ((answer.toolCalls?.length ?? 0) > 0) return true;
  let value: unknown;
  try {
    value = JSON.parse(answer.content);
  } catch {
    return false;
  }
  if (format.type === 'json_object') return true;
  const schema = format.json_schema.schema;
  if (!schema) return true;
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (validate === undefined) {
    try {
      validate = ajv.compile(schema);
    } catch {
      validate = null;
    }
    if (compiled.size >= 500) compiled.clear();
    compiled.set(key, validate);
  }
  return validate === null ? true : validate(value) === true;
}
