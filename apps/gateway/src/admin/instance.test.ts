import { describe, expect, it } from 'vitest';
import { processInstanceProbe } from './instance.js';

describe('processInstanceProbe', () => {
  it('measures memory at once, and CPU and event-loop delay from the second reading', async () => {
    const probe = processInstanceProbe(() => ({ buffered: 2, published: 9, dropped: 0 }));
    try {
      const first = probe.read();
      expect(first.residentMemoryBytes).toBeGreaterThan(0);
      expect(first.heapUsedBytes).toBeGreaterThan(0);
      expect(first.heapTotalBytes).toBeGreaterThanOrEqual(first.heapUsedBytes);
      expect(first.cpuShare).toBeNull();
      expect(first.eventLoopDelayP99Ms).toBeNull();
      expect(first.usageEvents).toEqual({ buffered: 2, published: 9, dropped: 0 });

      await new Promise((resolve) => setTimeout(resolve, 60));
      const second = probe.read();
      expect(second.cpuShare).toBeGreaterThanOrEqual(0);
      expect(second.eventLoopDelayP99Ms).toBeGreaterThanOrEqual(0);
    } finally {
      probe.stop();
    }
  });

  it('reports nothing that names the host', () => {
    const probe = processInstanceProbe(() => ({ buffered: 0, published: 0, dropped: 0 }));
    try {
      expect(Object.keys(probe.read()).sort()).toEqual([
        'cpuShare',
        'eventLoopDelayP99Ms',
        'heapTotalBytes',
        'heapUsedBytes',
        'residentMemoryBytes',
        'uptimeSeconds',
        'usageEvents',
      ]);
    } finally {
      probe.stop();
    }
  });
});
