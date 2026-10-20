/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/), without a tracing SDK (ADR 017): IDs
 * that tie the gateway's request, its provider attempts and the worker's insert together in logs.
 * Nothing is recorded as a span; the IDs are log fields and `traceparent` headers.
 */
export interface TraceContext {
  /** 32 lowercase hex digits, shared by every hop of the trace. */
  traceId: string;
  /** 16 lowercase hex digits: this hop's span. */
  spanId: string;
  /** The span this one continues: the caller's, or null when the trace starts here. */
  parentSpanId: string | null;
  /** `01` when the caller sampled (recorded) the trace, otherwise `00`; passed on unchanged. */
  flags: '00' | '01';
}

/** version-traceid-parentid-flags, plus fields a later version may append. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZEROS = /^0+$/;

/**
 * Parses a `traceparent` header. Returns null for anything the spec says to ignore: a malformed
 * or uppercase value, version `ff`, extra fields on version `00`, or an all-zero ID.
 */
export function parseTraceparent(
  value: string | undefined,
): Pick<TraceContext, 'traceId' | 'parentSpanId' | 'flags'> | null {
  if (value === undefined || value.length > 512) return null;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return null;
  const [, version, traceId, parentId, flags, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
  if (ZEROS.test(traceId) || ZEROS.test(parentId)) return null;
  // Only the sampled bit is defined for version 00, which is the version passed on.
  return { traceId, parentSpanId: parentId, flags: Number.parseInt(flags, 16) & 1 ? '01' : '00' };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  do crypto.getRandomValues(buffer);
  while (buffer.every((b) => b === 0));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const newSpanId = (): string => randomHex(8);

/** The span for a request that arrived with `traceparent` (continuing it) or without (a new trace). */
export function startSpan(traceparent: string | undefined): TraceContext {
  const parent = parseTraceparent(traceparent);
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: newSpanId(),
    parentSpanId: parent?.parentSpanId ?? null,
    flags: parent?.flags ?? '00',
  };
}

/** A span under `parent`, for one step of its work (a provider attempt, a worker insert). */
export function childSpan(
  parent: Pick<TraceContext, 'traceId' | 'spanId' | 'flags'>,
): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: newSpanId(),
    parentSpanId: parent.spanId,
    flags: parent.flags,
  };
}

/** The `traceparent` header naming `span` as the parent of whatever receives it. */
export function formatTraceparent(span: TraceContext): string {
  return `00-${span.traceId}-${span.spanId}-${span.flags}`;
}

/** The log fields for a span; parentSpanId only when there is one. */
export function traceLogFields(span: TraceContext): Record<string, string> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === null ? {} : { parentSpanId: span.parentSpanId }),
  };
}
