import { GatewayError } from '../errors.js';
import type { ProviderError, ProviderErrorKind } from '../providers/errors.js';

interface ClientError {
  status: number;
  code: string;
  message: string;
}

/**
 * What a client sees for each upstream failure. Messages are fixed text: the provider's own error
 * body never reaches the client.
 */
const CLIENT_ERRORS: Record<ProviderErrorKind, ClientError> = {
  timeout: {
    status: 504,
    code: 'upstream_timeout',
    message: 'The model provider did not respond in time.',
  },
  rate_limited: {
    status: 429,
    code: 'upstream_rate_limited',
    message: 'The model provider is rate limiting requests. Retry later.',
  },
  server_error: {
    status: 502,
    code: 'upstream_error',
    message: 'The model provider returned an error.',
  },
  connection: {
    status: 502,
    code: 'upstream_unavailable',
    message: 'The model provider could not be reached or closed the connection.',
  },
  invalid_response: {
    status: 502,
    code: 'upstream_invalid_response',
    message: 'The model provider returned a response the gateway could not read.',
  },
  bad_request: {
    status: 400,
    code: 'upstream_rejected_request',
    message: 'The model provider rejected the request.',
  },
  auth: {
    status: 502,
    code: 'upstream_auth_failed',
    message: 'The gateway could not authenticate with the model provider.',
  },
  not_found: {
    status: 502,
    code: 'upstream_model_not_found',
    message: 'The model provider does not serve the configured model.',
  },
  // nginx's convention for "client closed request"; the client is gone and never sees it.
  canceled: { status: 499, code: 'client_closed_request', message: 'Client closed the request.' },
};

export function toGatewayError(error: ProviderError): GatewayError {
  const mapped = CLIENT_ERRORS[error.kind];
  return new GatewayError(mapped.code, mapped.message, {
    httpStatus: mapped.status,
    retryable: error.retryable,
    retryAfterSeconds:
      error.retryAfterMs === undefined ? undefined : Math.ceil(error.retryAfterMs / 1000),
  });
}
