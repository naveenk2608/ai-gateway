import { monitorEventLoopDelay } from 'node:perf_hooks';
import { z } from 'zod';
import type { EventBusStats } from '../events/bus.js';

/**
 * What this gateway process measures about itself, for the Infrastructure page (ADR 017). Only
 * values Node reports here; nothing that names the host or shows configuration.
 */
export const instanceSchema = z.object({
  uptimeSeconds: z.number(),
  residentMemoryBytes: z.number(),
  heapUsedBytes: z.number(),
  heapTotalBytes: z.number(),
  /** CPU time used since the previous reading, as a share of one core; null on the first reading. */
  cpuShare: z.number().nullable(),
  /** 99th-percentile event-loop delay since the previous reading; null on the first reading. */
  eventLoopDelayP99Ms: z.number().nullable(),
  /** This instance's usage events: waiting in memory, written, and lost to a full buffer. */
  usageEvents: z.object({ buffered: z.number(), published: z.number(), dropped: z.number() }),
});
export type InstanceState = z.output<typeof instanceSchema>;

export interface InstanceProbe {
  read(): InstanceState;
  stop(): void;
}

/**
 * Reads the process. CPU and event-loop delay cover the time since the previous reading (a
 * dashboard polls), so the first reading has neither rather than a lifetime average.
 */
export function processInstanceProbe(events: () => EventBusStats): InstanceProbe {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let previous: { at: bigint; cpu: NodeJS.CpuUsage } | undefined;
  return {
    read() {
      const at = process.hrtime.bigint();
      const cpu = process.cpuUsage();
      let cpuShare: number | null = null;
      let eventLoopDelayP99Ms: number | null = null;
      if (previous) {
        const elapsedMicros = Number(at - previous.at) / 1_000;
        const usedMicros = cpu.user - previous.cpu.user + (cpu.system - previous.cpu.system);
        if (elapsedMicros > 0) cpuShare = usedMicros / elapsedMicros;
        if (delay.count > 0) eventLoopDelayP99Ms = Math.round(delay.percentile(99) / 1e5) / 10;
      }
      delay.reset();
      previous = { at, cpu };
      const memory = process.memoryUsage();
      return {
        uptimeSeconds: Math.round(process.uptime()),
        residentMemoryBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        cpuShare,
        eventLoopDelayP99Ms,
        usageEvents: events(),
      };
    },
    stop() {
      delay.disable();
    },
  };
}
