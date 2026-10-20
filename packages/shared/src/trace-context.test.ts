import { describe, expect, it } from 'vitest';
import {
  childSpan,
  formatTraceparent,
  parseTraceparent,
  startSpan,
  traceLogFields,
} from './trace-context.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';

describe('parseTraceparent', () => {
  it('reads a version 00 header', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-01`)).toEqual({
      traceId: TRACE,
      parentSpanId: PARENT,
      flags: '01',
    });
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-00`)?.flags).toBe('00');
  });

  it('keeps only the sampled flag', () => {
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-03`)?.flags).toBe('01');
    expect(parseTraceparent(`00-${TRACE}-${PARENT}-02`)?.flags).toBe('00');
  });

  it('accepts a later version with extra fields', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01-extra`)?.traceId).toBe(TRACE);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['uppercase', `00-${TRACE.toUpperCase()}-${PARENT}-01`],
    ['short trace ID', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['zero trace ID', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['zero parent ID', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['extra fields on version 00', `00-${TRACE}-${PARENT}-01-extra`],
    ['two headers joined', `00-${TRACE}-${PARENT}-01, 00-${TRACE}-${PARENT}-01`],
    ['too long', `00-${TRACE}-${PARENT}-01-${'x'.repeat(600)}`],
  ])('ignores a %s header', (_name, value) => {
    expect(parseTraceparent(value)).toBeNull();
  });
});

describe('spans', () => {
  it('continues an incoming trace with a new span', () => {
    const span = startSpan(`00-${TRACE}-${PARENT}-01`);
    expect(span).toMatchObject({ traceId: TRACE, parentSpanId: PARENT, flags: '01' });
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.spanId).not.toBe(PARENT);
  });

  it('starts a new trace without a valid header', () => {
    const a = startSpan(undefined);
    const b = startSpan('garbage');
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a).toMatchObject({ parentSpanId: null, flags: '00' });
  });

  it('makes child spans and the header naming them', () => {
    const parent = startSpan(`00-${TRACE}-${PARENT}-01`);
    const child = childSpan(parent);
    expect(child).toMatchObject({ traceId: TRACE, parentSpanId: parent.spanId, flags: '01' });
    expect(formatTraceparent(child)).toBe(`00-${TRACE}-${child.spanId}-01`);
    expect(parseTraceparent(formatTraceparent(child))?.parentSpanId).toBe(child.spanId);
  });

  it('logs parentSpanId only when there is one', () => {
    expect(Object.keys(traceLogFields(startSpan(undefined)))).toEqual(['traceId', 'spanId']);
    expect(traceLogFields(startSpan(`00-${TRACE}-${PARENT}-01`)).parentSpanId).toBe(PARENT);
  });
});
