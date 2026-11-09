import { z } from 'zod';
import { DETECTOR_TYPES, type DetectorType } from './detectors.js';

/** Before the model: replace with a placeholder, refuse the request (400), or only record it. */
export const INPUT_ACTIONS = ['off', 'mask', 'block', 'flag'] as const;
/** On answers: replace with a placeholder, or only record it. */
export const OUTPUT_ACTIONS = ['off', 'mask', 'flag'] as const;
/** JSON answers that fail their schema: record, or retry once on the next deployment then 502. */
export const SCHEMA_ACTIONS = ['off', 'flag', 'retry'] as const;

const input = z.enum(INPUT_ACTIONS).default('off');
const output = z.enum(OUTPUT_ACTIONS).default('off');

/**
 * A project's guardrails (M16, ADR 035), stored in `projects.guardrails`. Everything is off until
 * a project admin turns it on; an empty object is "no checks".
 */
export const guardrailPolicySchema = z
  .object({
    input: z
      .object({ email: input, phone: input, card: input, aadhaar: input, pan: input })
      .strict()
      .prefault({}),
    blockedTerms: z
      .object({
        /** Words and phrases, matched case-insensitively as whole words. */
        terms: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
        action: z.enum(['block', 'flag']).default('block'),
      })
      .strict()
      .prefault({}),
    /** Requests estimated above this many prompt tokens are refused (400); null: no cap. */
    maxPromptTokens: z.number().int().min(1).max(10_000_000).nullable().default(null),
    output: z
      .object({
        schema: z.enum(SCHEMA_ACTIONS).default('off'),
        email: output,
        phone: output,
        card: output,
        aadhaar: output,
        pan: output,
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type GuardrailPolicy = z.output<typeof guardrailPolicySchema>;
export type GuardrailPolicyInput = z.input<typeof guardrailPolicySchema>;

export const NO_GUARDRAILS: GuardrailPolicy = guardrailPolicySchema.parse({});

/** A stored policy; anything unreadable counts as no checks (the admin API only stores valid ones). */
export function parseGuardrailPolicy(raw: unknown): GuardrailPolicy {
  const parsed = guardrailPolicySchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : NO_GUARDRAILS;
}

/** The detector types with an action other than `off` in a stage. */
export function activeTypes(
  actions: Record<DetectorType, string>,
  only?: string,
): Set<DetectorType> {
  return new Set(
    DETECTOR_TYPES.filter(
      (t) => actions[t] !== 'off' && (only === undefined || actions[t] === only),
    ),
  );
}

/** Whether any check runs before the model. */
export function checksInput(policy: GuardrailPolicy): boolean {
  return (
    activeTypes(policy.input).size > 0 ||
    policy.blockedTerms.terms.length > 0 ||
    policy.maxPromptTokens !== null
  );
}

/** Whether any check runs on answers. */
export function checksOutput(policy: GuardrailPolicy): boolean {
  return policy.output.schema !== 'off' || activeTypes(policy.output).size > 0;
}
