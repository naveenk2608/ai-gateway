import { z } from 'zod';

/**
 * The OpenAI chat-completions subset the gateway accepts. Unknown fields are rejected rather than
 * silently dropped, so a client never believes an unsupported option (`logprobs`, `n > 1`, audio)
 * took effect. Optional fields accept null, as OpenAI's API does.
 */

/** At most this many images per request (Groq documents 3 for its vision model, the fewest). */
export const MAX_IMAGES_PER_REQUEST = 3;
/** At most this many bytes per `data:` image URL; the whole body stays under 1 MiB. */
export const MAX_IMAGE_DATA_URL_BYTES = 512 * 1024;
/** Longest `https:` image URL accepted. */
const MAX_IMAGE_URL_LENGTH = 2_048;
/** At most this many tools per request (OpenAI's and Groq's documented maximum). */
export const MAX_TOOLS = 128;

const DATA_URL = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

const textPart = z.object({ type: z.literal('text'), text: z.string() }).strict();
const textContent = z.union([z.string(), z.array(textPart).min(1)]);

/** An image by `https:` URL or as a base64 `data:` URL; the gateway itself never fetches it. */
const imageUrl = z.string().superRefine((url, ctx) => {
  if (url.startsWith('data:')) {
    if (url.length > MAX_IMAGE_DATA_URL_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `a data: image URL may be at most ${MAX_IMAGE_DATA_URL_BYTES} bytes`,
      });
    } else if (!DATA_URL.test(url)) {
      ctx.addIssue({
        code: 'custom',
        message: 'use a data:image/(png|jpeg|gif|webp);base64,... URL',
      });
    }
    return;
  }
  let https = false;
  try {
    https = new URL(url).protocol === 'https:';
  } catch {
    // Reported below.
  }
  if (!https || url.length > MAX_IMAGE_URL_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      message: `use an https: URL of at most ${MAX_IMAGE_URL_LENGTH} characters, or a data: URL`,
    });
  }
});

const imagePart = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({ url: imageUrl, detail: z.enum(['auto', 'low', 'high']).nullish() })
      .strict(),
  })
  .strict();

const functionName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'use 1 to 64 letters, digits, "_" or "-"');

const toolCall = z
  .object({
    id: z.string().min(1).max(256),
    type: z.literal('function'),
    function: z.object({ name: functionName, arguments: z.string() }).strict(),
  })
  .strict();

const name = z.string().min(1).max(64).optional();

const message = z.discriminatedUnion(
  'role',
  [
    z.object({ role: z.enum(['system', 'developer']), content: textContent, name }).strict(),
    z
      .object({
        role: z.literal('user'),
        content: z.union([
          z.string(),
          z.array(z.discriminatedUnion('type', [textPart, imagePart])).min(1),
        ]),
        name,
      })
      .strict(),
    z
      .object({
        role: z.literal('assistant'),
        content: textContent.nullish(),
        name,
        tool_calls: z.array(toolCall).min(1).max(MAX_TOOLS).nullish(),
        // Accepted so a reply can be sent back as the SDK returned it; never forwarded.
        refusal: z.string().nullish(),
      })
      .strict()
      .refine((m) => m.content != null || m.tool_calls != null, {
        message: 'an assistant message needs content or tool_calls',
        path: ['content'],
      }),
    z
      .object({
        role: z.literal('tool'),
        content: textContent,
        tool_call_id: z.string().min(1).max(256),
      })
      .strict(),
  ],
  {
    error:
      'role must be system, developer, user, assistant or tool (for the old function role, ' +
      'use tools and tool messages)',
  },
);

const tool = z
  .object({
    type: z.literal('function', { error: 'only function tools are supported' }),
    function: z
      .object({
        name: functionName,
        description: z.string().nullish(),
        /** A JSON Schema object; passed to the provider as given and never logged. */
        parameters: z.record(z.string(), z.unknown()).nullish(),
        strict: z.boolean().nullish(),
      })
      .strict(),
  })
  .strict();

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z
    .object({
      type: z.literal('function'),
      function: z.object({ name: functionName }).strict(),
    })
    .strict(),
]);

const responseFormat = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('json_object') }).strict(),
  z
    .object({
      type: z.literal('json_schema'),
      json_schema: z
        .object({
          name: functionName,
          description: z.string().nullish(),
          schema: z.record(z.string(), z.unknown()).nullish(),
          strict: z.boolean().nullish(),
        })
        .strict(),
    })
    .strict(),
]);

/** Deprecated OpenAI fields: answered with a 400 that names their replacement. */
const replacedByTools = (field: string) =>
  z.unknown().refine(() => false, `${field} is not supported: use tools and tool_choice`);

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
    tools: z.array(tool).min(1).max(MAX_TOOLS).nullish(),
    tool_choice: toolChoice.nullish(),
    parallel_tool_calls: z.boolean().nullish(),
    response_format: responseFormat.nullish(),
    functions: replacedByTools('functions').optional(),
    function_call: replacedByTools('function_call').optional(),
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
    const tools = body.tools ?? [];
    for (const field of ['tool_choice', 'parallel_tool_calls'] as const) {
      if (body[field] != null && tools.length === 0) {
        ctx.addIssue({ code: 'custom', path: [field], message: `${field} needs tools` });
      }
    }
    const names = tools.map((t) => t.function.name);
    const repeated = names.find((n, i) => names.indexOf(n) !== i);
    if (repeated !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools'],
        message: `the tool name "${repeated}" is used twice`,
      });
    }
    const choice = body.tool_choice;
    if (typeof choice === 'object' && choice !== null && !names.includes(choice.function.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tool_choice', 'function', 'name'],
        message: 'tool_choice names a function that is not in tools',
      });
    }
    const images = body.messages.reduce(
      (count, m) =>
        count +
        (m.role === 'user' && Array.isArray(m.content)
          ? m.content.filter((part) => part.type === 'image_url').length
          : 0),
      0,
    );
    if (images > MAX_IMAGES_PER_REQUEST) {
      ctx.addIssue({
        code: 'custom',
        path: ['messages'],
        message: `at most ${MAX_IMAGES_PER_REQUEST} images per request`,
      });
    }
  });

export type ChatCompletionRequest = z.output<typeof chatCompletionRequestSchema>;
export type ChatCompletionMessage = ChatCompletionRequest['messages'][number];

const finishReason = z.enum(['stop', 'length', 'content_filter', 'tool_calls']);

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
        /** Null when the model only called tools. */
        content: z.string().nullable(),
        refusal: z.null(),
        tool_calls: z
          .array(
            z.object({
              id: z.string(),
              type: z.literal('function'),
              function: z.object({ name: z.string(), arguments: z.string() }),
            }),
          )
          .optional(),
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
