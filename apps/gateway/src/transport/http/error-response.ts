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

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  if (durationMs !== undefined) {
    headers.set("x-gateway-duration-ms", String(Math.max(0, durationMs)));
  }
  if (gatewayError.retryAfter) {
    headers.set("retry-after", gatewayError.retryAfter);
  }

  return new Response(JSON.stringify(body), {
    status: gatewayError.status,
    headers,
  });
}
