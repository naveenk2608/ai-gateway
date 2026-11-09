import { randomBytes } from 'node:crypto';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { childSpan, type TraceContext } from '../trace-context.js';

/**
 * OpenTelemetry tracing (M17, ADR 037), off unless OTEL_EXPORTER_OTLP_ENDPOINT is set: then the
 * SDK is loaded and spans are exported over OTLP/HTTP. Spans use the IDs the gateway already makes
 * for each request and attempt (ADR 017), so logs, `traceparent` headers and exported traces agree.
 * Nothing about prompts or answers is put on a span: only names, IDs, models, deployments,
 * outcomes, status codes and counts.
 */

/** A started span, or a no-op one when tracing is off. */
export interface SpanHandle {
  readonly recording: boolean;
  set(attributes: Attributes): void;
  /** Ends the span; `error` marks it failed with that short code (never a provider's text). */
  end(error?: string): void;
}

const NOOP: SpanHandle = { recording: false, set: () => undefined, end: () => undefined };

let tracer: Tracer | null = null;
let stop: (() => Promise<void>) | null = null;

/** The IDs the next span must take; set only for the synchronous `startSpan` call. */
let pinned: { traceId?: string; spanId?: string } = {};
const random = (bytes: number) => randomBytes(bytes).toString('hex');
const idGenerator = {
  generateTraceId: () => pinned.traceId ?? random(16),
  generateSpanId: () => pinned.spanId ?? random(8),
};

export interface TracingOptions {
  /** `service.name` on every span. */
  serviceName: string;
  /** OTEL_EXPORTER_OTLP_ENDPOINT. Unset (and no exporter): tracing stays off. */
  endpoint?: string | undefined;
  /** Tests: spans go to this exporter as each ends, instead of OTLP in batches. */
  exporter?: SpanExporter;
}

/**
 * Starts tracing for this process; returns whether it is on. The OTLP exporter reads its endpoint
 * and headers from the standard OTEL_EXPORTER_OTLP_* variables, as the OpenTelemetry
 * specification defines them. Every span is recorded (no sampling).
 */
export async function initTracing(options: TracingOptions): Promise<boolean> {
  if (tracer) return true;
  if (!options.endpoint && !options.exporter) return false;
  const sdk = await import('@opentelemetry/sdk-trace');
  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const { ATTR_SERVICE_NAME } = await import('@opentelemetry/semantic-conventions');
  let processor;
  if (options.exporter) {
    processor = new sdk.SimpleSpanProcessor({ exporter: options.exporter });
  } else {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    processor = new sdk.BatchSpanProcessor({ exporter: new OTLPTraceExporter() });
  }
  const provider = new sdk.TracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    sampler: new sdk.AlwaysOnSampler(),
    idGenerator,
    spanProcessors: [processor],
  });
  tracer = provider.getTracer('ai-gateway');
  stop = () => provider.shutdown();
  return true;
}

/** Sends what is buffered and stops tracing. */
export async function shutdownTracing(): Promise<void> {
  const shutdown = stop;
  tracer = null;
  stop = null;
  await shutdown?.();
}

export function tracingEnabled(): boolean {
  return tracer !== null;
}

const KINDS = {
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  internal: SpanKind.INTERNAL,
  consumer: SpanKind.CONSUMER,
};

/**
 * Starts a span with exactly the IDs in `ids`: its own `spanId`, in `ids.traceId`, under
 * `ids.parentSpanId` (a span of another process when `remoteParent`). A no-op when tracing is off.
 */
export function openSpan(
  name: string,
  ids: TraceContext,
  options: {
    kind?: keyof typeof KINDS;
    attributes?: Attributes;
    remoteParent?: boolean;
  } = {},
): SpanHandle {
  if (!tracer) return NOOP;
  const parent =
    ids.parentSpanId === null
      ? ROOT_CONTEXT
      : trace.setSpanContext(ROOT_CONTEXT, {
          traceId: ids.traceId,
          spanId: ids.parentSpanId,
          traceFlags: TraceFlags.SAMPLED,
          isRemote: options.remoteParent ?? false,
        });
  pinned = { traceId: ids.traceId, spanId: ids.spanId };
  let span: Span;
  try {
    span = tracer.startSpan(
      name,
      {
        kind: KINDS[options.kind ?? 'internal'],
        ...(options.attributes ? { attributes: options.attributes } : {}),
      },
      parent,
    );
  } finally {
    pinned = {};
  }
  return {
    recording: span.isRecording(),
    set: (attributes) => span.setAttributes(attributes),
    end: (error) => {
      if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.end();
    },
  };
}

/**
 * Runs `work` in a child span of `parent` (a cache lookup, a wait, a database call). Without a
 * parent or with tracing off it just runs `work`.
 */
export async function inSpan<T>(
  name: string,
  parent: TraceContext | undefined,
  work: (span: SpanHandle) => Promise<T>,
  options: { kind?: keyof typeof KINDS; attributes?: Attributes } = {},
): Promise<T> {
  if (!tracer || !parent) return work(NOOP);
  const span = openSpan(name, childSpan(parent), options);
  try {
    const result = await work(span);
    span.end();
    return result;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    span.end(typeof code === 'string' ? code : 'error');
    throw err;
  }
}

/** Options for a span around a Postgres call (OpenTelemetry's `db.system.name`). */
export const POSTGRES_SPAN = {
  kind: 'client',
  attributes: { 'db.system.name': 'postgresql' },
} as const;

/** A finished span as tests see it. */
export interface RecordedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: 'server' | 'client' | 'internal' | 'consumer' | 'producer';
  attributes: Attributes;
  failed: boolean;
}

const KIND_NAMES = ['internal', 'server', 'client', 'producer', 'consumer'] as const;

/**
 * Tests: turns tracing on with an in-memory exporter (spans recorded as each ends). Call
 * `shutdownTracing` afterwards.
 */
export async function initInMemoryTracing(serviceName = 'test'): Promise<{
  spans: () => RecordedSpan[];
  reset: () => void;
}> {
  const { InMemorySpanExporter } = await import('@opentelemetry/sdk-trace');
  const exporter = new InMemorySpanExporter();
  await initTracing({ serviceName, exporter });
  return {
    spans: () =>
      exporter.getFinishedSpans().map((s) => ({
        name: s.name,
        traceId: s.spanContext().traceId,
        spanId: s.spanContext().spanId,
        parentSpanId: s.parentSpanContext?.spanId ?? null,
        kind: KIND_NAMES[s.kind] ?? 'internal',
        attributes: s.attributes,
        failed: s.status.code === SpanStatusCode.ERROR,
      })),
    reset: () => exporter.reset(),
  };
}
