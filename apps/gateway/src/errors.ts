/**
 * The OpenAI-style error `type` of every error body the gateway sends: `rate_limit_error` for 429,
 * `server_error` for 5xx and `invalid_request_error` for every other 4xx, unless an error sets
 * its own. Clients tell errors apart by `code`.
 */
export type ErrorType = 'invalid_request_error' | 'rate_limit_error' | 'server_error';

export interface ErrorBody {
  error: {
    message: string;
    type: ErrorType;
    param: string | null;
    code: string;
  };
}

export interface GatewayErrorOptions {
  httpStatus: number;
  retryable?: boolean;
  type?: ErrorType;
  param?: string | null;
  /** Sent as the Retry-After header. */
  retryAfterSeconds?: number | undefined;
}

function defaultType(httpStatus: number): ErrorType {
  if (httpStatus === 429) return 'rate_limit_error';
  return httpStatus >= 500 ? 'server_error' : 'invalid_request_error';
}

/**
 * The only error shape clients see. `message` must be safe to return: never put provider error
 * bodies, stack traces or secrets in it.
 */
export class GatewayError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly type: ErrorType;
  readonly param: string | null;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: string, message: string, options: GatewayErrorOptions) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.type = options.type ?? defaultType(options.httpStatus);
    this.param = options.param ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  toBody(): ErrorBody {
    return {
      error: { message: this.message, type: this.type, param: this.param, code: this.code },
    };
  }
}
