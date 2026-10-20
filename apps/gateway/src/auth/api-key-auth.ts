import type { FastifyReply, FastifyRequest } from 'fastify';
import { GatewayError } from '../errors.js';
import type { AuthenticatedKey, KeyVerifier, RejectReason } from './key-verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the API-key hook on /v1 routes. */
    apiKey: AuthenticatedKey | null;
  }
}

const REJECT_MESSAGES: Record<RejectReason, string> = {
  malformed: 'Incorrect API key provided.',
  unknown: 'Incorrect API key provided.',
  secret_mismatch: 'Incorrect API key provided.',
  // Only reachable with the right secret, so telling the holder why is safe.
  revoked: 'This API key has been revoked.',
  expired: 'This API key has expired.',
};

function unauthorized(message: string): GatewayError {
  return new GatewayError('invalid_api_key', message, { httpStatus: 401 });
}

const authUnavailable = new GatewayError(
  'auth_unavailable',
  'API keys cannot be checked right now. Retry shortly.',
  { httpStatus: 503, retryable: true },
);

/** Reads `Authorization: Bearer <key>`, as the OpenAI SDKs send it. */
function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** onRequest hook: rejects the request unless it carries a valid API key (ADR 006). */
export function apiKeyAuth(verifier: KeyVerifier) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const token = bearerToken(request);
    if (token === undefined) {
      throw unauthorized('Missing API key. Send it in the Authorization header as `Bearer <key>`.');
    }
    let result;
    try {
      result = await verifier.verify(token);
    } catch (err) {
      request.log.error({ err }, 'API key lookup failed');
      throw authUnavailable;
    }
    if (!result.ok) {
      request.log.info({ reason: result.reason, keyId: result.keyId }, 'API key rejected');
      throw unauthorized(REJECT_MESSAGES[result.reason]);
    }
    request.apiKey = result.key;
    request.log = request.log.child({ projectId: result.key.projectId, keyId: result.key.keyId });
  };
}
