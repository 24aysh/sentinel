export type GatewayErrorCode =
  | "INVALID_REQUEST"
  | "UNSUPPORTED_FEATURE"
  | "MODEL_RATE_LIMITED"
  | "MODEL_TIMEOUT"
  | "MODEL_AUTHENTICATION_FAILED"
  | "INVALID_MODEL_RESPONSE"
  | "MODEL_UPSTREAM_ERROR"
  | "INPUT_GUARDRAIL_BLOCKED"
  | "OUTPUT_GUARDRAIL_FAILED"
  | "GUARDRAIL_EVALUATION_FAILED"
  | "INTERNAL_ERROR";

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly retryAfter?: string;

  constructor(
    code: GatewayErrorCode,
    message: string,
    status: number,
    options?: { cause?: unknown; retryAfter?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.retryAfter = options?.retryAfter;
  }
}

export function normalizeGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) {
    return error;
  }

  return new GatewayError(
    "INTERNAL_ERROR",
    "The gateway could not complete the request.",
    500,
    { cause: error },
  );
}
