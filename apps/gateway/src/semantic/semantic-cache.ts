import { createHash } from 'node:crypto';
import {
  estimateTextTokens,
  uuidv7,
  type Clock,
  type SemanticCacheRecord,
  type TraceContext,
} from '@ai-gateway/shared';
import type { Db, Logger } from '@ai-gateway/shared/node';
import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'kysely';
import { cacheKey, cachedAnswerSchema } from '../cache/response-cache.js';
import type { Route } from '../providers/registry.js';
import type { ChatResult } from '../providers/types.js';
import { runEmbed } from '../proxy/attempt.js';
import type { ChatCompletionRequest } from '../proxy/schema.js';
import { RequestTrace } from '../proxy/trace.js';
import { runRouted, type RoutingDeps } from '../routing/routed.js';
import { DEFAULT_SEMANTIC_THRESHOLD, type SemanticPolicy } from './policy.js';

type EmbeddingRecord = NonNullable<SemanticCacheRecord['embedding']>;
export type AnsweredBy = NonNullable<SemanticCacheRecord['answeredBy']>;

/** The embedding call's context: the request it serves and when that request must have answered. */
export interface EmbedCall {
  requestId: string;
  projectId: string;
  apiKeyId: string | null;
  traceContext?: TraceContext | undefined;
  clientSignal: AbortSignal;
  log: FastifyBaseLogger;
  /** The request's deadline (clock time); the embedding call may not run past it. */
  deadlineAt?: number | undefined;
}

/** One text's vector and the call that made it (deployment, tokens), for the usage event. */
export interface EmbeddedText {
  vector: number[];
  record: EmbeddingRecord;
}

/** Makes the embedding call for one text; throws when it fails. */
export type Embedder = (text: string, call: EmbedCall) => Promise<EmbeddedText>;

/**
 * Embeds through an embeddings model's route (ADR 029): its breakers, quotas and deadline apply,
 * with one try, since a failed lookup only makes the request a normal miss. The call is recorded
 * on a trace of its own, so it never counts as an attempt of the chat request.
 */
export function routedEmbedder(route: Route, routing: RoutingDeps, clock: Clock): Embedder {
  return async (text, call) => {
    const trace = new RequestTrace(
      {
        requestId: call.requestId,
        projectId: call.projectId,
        apiKeyId: call.apiKeyId,
        model: route.model,
        stream: false,
        estimatedPromptTokens: estimateTextTokens(text),
        endpoint: 'embeddings',
        traceContext: call.traceContext,
      },
      clock,
    );
    const left =
      call.deadlineAt === undefined ? undefined : Math.max(0, call.deadlineAt - clock.now());
    const result = await runRouted(
      { ...routing, deadlineMs: left, retry: { ...routing.retry, maxAttempts: 1 } },
      { route, trace, clock, clientSignal: call.clientSignal, log: call.log, maxTokens: 0 },
      (ctx) => runEmbed(ctx, { model: ctx.deployment.providerModel, input: [text] }),
    );
    const attempt = trace.attempts.at(-1);
    const vector = result.vectors[0];
    if (!attempt || !vector) throw new Error('the embedding call returned no vector');
    return {
      vector,
      record: {
        deployment: attempt.deployment,
        provider: attempt.provider,
        providerModel: attempt.providerModel,
        billing: attempt.billing ?? 'paid',
        promptTokens: result.usage?.promptTokens ?? trace.estimatedPromptTokens,
        usageSource: result.usage ? 'reported' : 'estimated',
      },
    };
  };
}

/**
 * The text a request is matched on (ADR 040): its last message, when that is a user message of
 * text only. Requests with tools, images or another last message make no lookup: tool calls carry
 * arguments taken from the text, and images are not text.
 */
export function semanticText(body: ChatCompletionRequest): string | null {
  if ((body.tools?.length ?? 0) > 0) return null;
  const last = body.messages.at(-1);
  if (!last || last.role !== 'user') return null;
  const content = last.content;
  const text =
    typeof content === 'string'
      ? content
      : content.some((part) => part.type !== 'text')
        ? null
        : content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  return text === null || text.trim() === '' ? null : text;
}

/**
 * Everything but the matched text, which must be identical for a hit: the exact cache's key (the
 * project, the logical model, every earlier message and every parameter, ADR 013) over the
 * request with its last message's text left empty, and the embedding model, so vectors from two
 * embedding models are never compared.
 */
export function semanticContextKey(
  projectId: string,
  body: ChatCompletionRequest,
  embeddingModel: string,
): string {
  const last = body.messages.at(-1);
  const messages = last ? [...body.messages.slice(0, -1), { ...last, content: '' }] : [];
  const rest: ChatCompletionRequest = { ...body, messages };
  const canonical = JSON.stringify(['sem-v1', embeddingModel, cacheKey(projectId, rest)]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** pgvector's text form: `[0.1,0.2,...]`. */
export function vectorText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/** What a lookup found: the record for the usage event, a hit's answer, or a way to store one. */
export interface SemanticLookup {
  record: SemanticCacheRecord;
  hit: ChatResult | null;
  /** On a miss with a vector: stores the request's complete answer under it (never throws). */
  store: ((answer: ChatResult, answeredBy: AnsweredBy | null) => Promise<void>) | null;
}

export interface SemanticCacheOptions {
  db: Db;
  logger: Logger;
  clock: Clock;
  /** The logical embeddings model (SEMANTIC_CACHE_EMBEDDING_MODEL), part of the context key. */
  embeddingModel: string;
  embed: Embedder;
}

/**
 * The semantic cache (M18, ADR 040): the nearest earlier request of the same project, logical
 * model and context by cosine similarity, in Postgres with pgvector. Like the exact cache it is an
 * optimisation: an embedding or database failure makes the request a normal miss.
 */
export class SemanticCache {
  readonly #o: SemanticCacheOptions;
  #available: Promise<boolean> | undefined;

  constructor(options: SemanticCacheOptions) {
    this.#o = options;
  }

  get embeddingModel(): string {
    return this.#o.embeddingModel;
  }

  /**
   * Whether migration 0018 could create the entries table (pgvector available). Checked once; a
   * failed check is tried again on the next lookup.
   */
  available(): Promise<boolean> {
    this.#available ??= sql<{ ok: boolean }>`
        SELECT to_regclass('semantic_cache_entries') IS NOT NULL AS ok`
      .execute(this.#o.db)
      .then(({ rows }) => {
        const ok = rows[0]?.ok === true;
        if (!ok) {
          this.#o.logger.warn(
            'semantic cache unavailable: no semantic_cache_entries table (pgvector missing)',
          );
        }
        return ok;
      })
      .catch((err: unknown) => {
        this.#available = undefined;
        this.#o.logger.warn({ err }, 'semantic cache check failed');
        return false;
      });
    return this.#available;
  }

  /** Embeds the request's text and looks for the nearest stored request; null when ineligible. */
  async lookup(input: {
    body: ChatCompletionRequest;
    policy: SemanticPolicy;
    call: EmbedCall;
  }): Promise<SemanticLookup | null> {
    const { body, policy, call } = input;
    const text = semanticText(body);
    if (text === null || !(await this.available())) return null;
    const contextKey = semanticContextKey(call.projectId, body, this.#o.embeddingModel);

    let embedded: EmbeddedText;
    try {
      embedded = await this.#o.embed(text, call);
    } catch (err) {
      // Sizes and kinds only: never the text (ADR 040).
      call.log.warn({ err }, 'semantic cache embedding failed; continuing as a miss');
      return {
        record: { outcome: 'error', similarity: null, embedding: null },
        hit: null,
        store: null,
      };
    }
    const { vector, record: embedding } = embedded;
    const now = this.#o.clock.now();
    let nearest: Awaited<ReturnType<SemanticCache['nearest']>>;
    try {
      nearest = await this.nearest(call.projectId, body.model, contextKey, vector, now);
    } catch (err) {
      call.log.warn({ err }, 'semantic cache lookup failed; continuing as a miss');
      return { record: { outcome: 'error', similarity: null, embedding }, hit: null, store: null };
    }
    const threshold = policy.threshold ?? DEFAULT_SEMANTIC_THRESHOLD;
    if (nearest && nearest.similarity !== null && nearest.similarity >= threshold) {
      return {
        record: {
          outcome: 'hit',
          similarity: nearest.similarity,
          embedding,
          answeredBy: nearest.answeredBy,
        },
        hit: nearest.answer,
        store: null,
      };
    }
    return {
      record: { outcome: 'miss', similarity: nearest?.similarity ?? null, embedding },
      hit: null,
      store: (answer, answeredBy) =>
        this.#store(call.projectId, body.model, contextKey, vector, answer, answeredBy, policy),
    };
  }

  /** The nearest unexpired entry with this project, model and context key, and its similarity. */
  async nearest(
    projectId: string,
    model: string,
    contextKey: string,
    vector: readonly number[],
    now: number,
  ): Promise<{
    answer: ChatResult;
    similarity: number | null;
    answeredBy: AnsweredBy | null;
  } | null> {
    const literal = vectorText(vector);
    const { rows } = await sql<{
      answer: unknown;
      provider: string | null;
      provider_model: string | null;
      billing: 'free_tier' | 'paid' | null;
      similarity: number | null;
    }>`
      SELECT answer, provider, provider_model, billing,
             1 - (embedding <=> ${literal}::vector) AS similarity
        FROM semantic_cache_entries
       WHERE project_id = ${projectId} AND model = ${model} AND context_key = ${contextKey}
         AND expires_at > ${new Date(now)}
       ORDER BY embedding <=> ${literal}::vector, created_at DESC
       LIMIT 1`.execute(this.#o.db);
    const row = rows[0];
    if (!row) return null;
    const answer = cachedAnswerSchema.safeParse(row.answer);
    if (!answer.success) return null;
    const similarity = Number(row.similarity);
    return {
      answer: answer.data,
      // A zero vector has no direction: no similarity, so never a hit.
      similarity: Number.isFinite(similarity) ? Math.max(-1, Math.min(1, similarity)) : null,
      answeredBy:
        row.provider && row.provider_model && row.billing
          ? { provider: row.provider, providerModel: row.provider_model, billing: row.billing }
          : null,
    };
  }

  /** Stores an answer, then deletes the project's expired rows and its oldest beyond the cap. */
  async #store(
    projectId: string,
    model: string,
    contextKey: string,
    vector: readonly number[],
    answer: ChatResult,
    answeredBy: AnsweredBy | null,
    policy: SemanticPolicy,
  ): Promise<void> {
    const now = this.#o.clock.now();
    try {
      await this.#o.db.transaction().execute(async (trx) => {
        await trx
          .insertInto('semantic_cache_entries')
          .values({
            id: uuidv7(now),
            project_id: projectId,
            model,
            context_key: contextKey,
            embedding: vectorText(vector),
            answer: JSON.stringify(cachedAnswerSchema.parse(answer)),
            provider: answeredBy?.provider ?? null,
            provider_model: answeredBy?.providerModel ?? null,
            billing: answeredBy?.billing ?? null,
            created_at: new Date(now),
            expires_at: new Date(now + policy.ttlSeconds * 1000),
          })
          .execute();
        await sql`
          DELETE FROM semantic_cache_entries
           WHERE project_id = ${projectId}
             AND (expires_at <= ${new Date(now)}
                  OR id IN (SELECT id FROM semantic_cache_entries
                             WHERE project_id = ${projectId}
                             ORDER BY created_at DESC, id DESC
                            OFFSET ${policy.maxEntries}))`.execute(trx);
      });
    } catch (err) {
      this.#o.logger.warn({ err }, 'semantic cache store failed');
    }
  }
}
