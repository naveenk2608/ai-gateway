import { describe, expect, it } from 'vitest';
import { ToolCallAssembler, ToolCallIdMap } from './tool-calls.js';
import type { StreamEvent } from './types.js';

let n = 0;
const ids = () => `gen_${++n}`;

describe('ToolCallAssembler', () => {
  it("passes OpenAI's pieces through: the ID and name first, then the arguments", () => {
    const calls = new ToolCallAssembler(ids);
    const events: StreamEvent[] = [
      ...calls.push({ index: 0, id: 'call_a', name: 'get_weather', arguments: '' }),
      ...calls.push({ index: 0, arguments: '{"ci' }),
      ...calls.push({ index: 0, arguments: 'ty":"Paris"}' }),
      ...calls.push({ index: 1, id: 'call_b', name: 'get_time', arguments: '{}' }),
    ];
    expect(events).toEqual([
      { type: 'tool_call', index: 0, id: 'call_a', name: 'get_weather' },
      { type: 'tool_arguments', index: 0, text: '{"ci' },
      { type: 'tool_arguments', index: 0, text: 'ty":"Paris"}' },
      { type: 'tool_call', index: 1, id: 'call_b', name: 'get_time' },
      { type: 'tool_arguments', index: 1, text: '{}' },
    ]);
    expect(calls.calls()).toEqual([
      { id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { id: 'call_b', name: 'get_time', arguments: '{}' },
    ]);
  });

  it('takes whole calls without an index or an ID, one per chunk', () => {
    const calls = new ToolCallAssembler(() => 'call_generated');
    const first = calls.push({ name: 'a', arguments: '{"x":1}' });
    const second = calls.push({ name: 'b', arguments: '{}' });
    expect(first).toEqual([
      { type: 'tool_call', index: 0, id: 'call_generated', name: 'a' },
      { type: 'tool_arguments', index: 0, text: '{"x":1}' },
    ]);
    expect(second[0]).toMatchObject({ type: 'tool_call', index: 1, name: 'b' });
  });

  it('holds arguments that come before the name until the call starts', () => {
    const calls = new ToolCallAssembler(ids);
    expect(calls.push({ index: 3, id: 'c', arguments: '{"a":' })).toEqual([]);
    expect(calls.push({ index: 3, name: 'f', arguments: '1}' })).toEqual([
      { type: 'tool_call', index: 0, id: 'c', name: 'f' },
      { type: 'tool_arguments', index: 0, text: '{"a":1}' },
    ]);
  });

  it('numbers calls from 0 in the order they appear, whatever the provider index', () => {
    const calls = new ToolCallAssembler(ids);
    calls.push({ index: 5, id: 'x', name: 'f' });
    calls.push({ index: 2, id: 'y', name: 'g' });
    expect(calls.push({ index: 5, arguments: '{}' })).toEqual([
      { type: 'tool_arguments', index: 0, text: '{}' },
    ]);
    expect(calls.calls().map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('continues the last call for pieces with no index, and starts one for a new ID', () => {
    const calls = new ToolCallAssembler(ids);
    calls.push({ id: 'one', name: 'f', arguments: '{' });
    calls.push({ arguments: '}' });
    calls.push({ id: 'two', name: 'g', arguments: '[]' });
    expect(calls.calls()).toEqual([
      { id: 'one', name: 'f', arguments: '{}' },
      { id: 'two', name: 'g', arguments: '[]' },
    ]);
  });

  it('rejects a call that never got a name as an invalid response', () => {
    const calls = new ToolCallAssembler(ids);
    calls.push({ index: 0, arguments: '{}' });
    expect(() => calls.calls()).toThrow(expect.objectContaining({ kind: 'invalid_response' }));
  });
});

describe('ToolCallIdMap', () => {
  const nine = { pattern: /^[A-Za-z0-9]{9}$/, length: 9 };

  it('maps IDs the provider would refuse, the same way each time, and back', () => {
    const map = new ToolCallIdMap(nine);
    const out = map.out('call_0123456789abcdef');
    expect(out).toMatch(/^[A-Za-z0-9]{9}$/);
    expect(map.out('call_0123456789abcdef')).toBe(out);
    expect(map.back(out)).toBe('call_0123456789abcdef');
    expect(map.out('call_other')).not.toBe(out);
  });

  it('leaves IDs that fit, and every ID without a rule, unchanged', () => {
    expect(new ToolCallIdMap(nine).out('D681PevKs')).toBe('D681PevKs');
    expect(new ToolCallIdMap(undefined).out('call_x')).toBe('call_x');
    expect(new ToolCallIdMap(nine).back('Unmapped1')).toBe('Unmapped1');
  });
});
