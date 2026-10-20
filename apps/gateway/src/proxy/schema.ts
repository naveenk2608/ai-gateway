import { z } from 'zod';

/**
 * The OpenAI chat-completions subset the gateway accepts. Unknown fields are rejected rather than
 * silently dropped, so a client never believes an unsupported option (tools, response_format,
 * images, n > 1) took effect. Optional fields accept null, as OpenAI's API does.
 */
const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();

const message = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(textPart).min(1)]),
    name: z.string().min(1).max(64).optional(),
  })
  .strict();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1).max(256),
    messages: z.array(message).min(1),
    stream: z.boolean().nullish(),
    stream_options: z.object({ include_usage: z.boolean().nullish() }).strict().nullish(),
    max_tokens: z.number().int().positive().nullish(),
    max_completion_tokens: z.number().int().positive().nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    n: z.literal(1, { error: 'only n = 1 is supported' }).nullish(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),
    seed: z.number().int().nullish(),
    user: z.string().max(256).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.stream_options != null && body.stream !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['stream_options'],
        message: 'stream_options is only allowed when stream is true',
      });
    }
    if (body.max_tokens != null && body.max_completion_tokens != null) {
      ctx.addIssue({
        code: 'custom',
        path: ['max_completion_tokens'],
        message: 'set max_tokens or max_completion_tokens, not both',
      });
    }
  });

export type ChatCompletionRequest = z.output<typeof chatCompletionRequestSchema>;

const finishReason = z.enum(['stop', 'length', 'content_filter']);

const usage = z.object({
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  total_tokens: z.number().int(),
});

export const chatCompletionSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      message: z.object({
        role: z.literal('assistant'),
        content: z.string(),
        refusal: z.null(),
      }),
      finish_reason: finishReason,
      logprobs: z.null(),
    }),
  ),
  usage: usage.optional(),
});

export type ChatCompletion = z.output<typeof chatCompletionSchema>;

export const errorBodySchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string(),
  }),
});
