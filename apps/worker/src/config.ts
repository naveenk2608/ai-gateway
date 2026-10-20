import { commonConfigShape } from '@ai-gateway/shared';
import { z } from 'zod';

export const workerConfigSchema = z.object({ ...commonConfigShape });

export type WorkerConfig = z.output<typeof workerConfigSchema>;
