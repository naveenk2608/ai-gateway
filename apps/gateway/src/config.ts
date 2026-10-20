import { commonConfigShape } from '@ai-gateway/shared';
import { z } from 'zod';

export const gatewayConfigSchema = z.object({
  ...commonConfigShape,
  /** Loopback by default; the container image sets 0.0.0.0. */
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  READY_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
});

export type GatewayConfig = z.output<typeof gatewayConfigSchema>;
