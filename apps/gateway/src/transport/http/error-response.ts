import {
  GatewayError,
  normalizeGatewayError,
  type GatewayErrorCode,
} from "../../domain/errors.ts";

interface PublicErrorBody {
  error: {
    code: GatewayErrorCode;
    message: string;
    request_id: string;
  };
}

interface JsonResponseOptions {
  status?: number;
  requestId?: string;
  durationMs?: number;
  headers?: Record<string, string>;
}

export function jsonResponse(
  body: unknown,
  { status = 200, requestId, durationMs, headers }: JsonResponseOptions = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  if (requestId) responseHeaders.set("x-request-id", requestId);
  if (durationMs !== undefined) {
    responseHeaders.set(
      "x-gateway-duration-ms",
      String(Math.max(0, durationMs)),
    );
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

export function invalidHttpRequest(message: string): GatewayError {
  return new GatewayError("INVALID_REQUEST", message, 400);
}

export function createErrorResponse(
  error: unknown,
  requestId: string,
  durationMs?: number,
): Response {
  const gatewayError = normalizeGatewayError(error);
  const body: PublicErrorBody = {
    error: {
      code: gatewayError.code,
      message: gatewayError.message,
      request_id: requestId,
    },
  };

  return jsonResponse(body, {
    status: gatewayError.status,
    requestId,
    durationMs,
    headers: gatewayError.retryAfter
      ? { "retry-after": gatewayError.retryAfter }
      : undefined,
  });
}
