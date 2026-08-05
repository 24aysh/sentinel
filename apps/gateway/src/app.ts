import { Elysia } from "elysia";
import { toPublicChatResponse } from "./domain/chat.ts";
import { GatewayError } from "./domain/errors.ts";
import { resolveRequestId } from "./domain/request-context.ts";
import type { Logger } from "./observability/logger.ts";
import type { GatewayPipeline } from "./pipeline/gateway-pipeline.ts";
import {
  createErrorResponse,
  invalidHttpRequest,
} from "./transport/http/error-response.ts";
import { chatCompletionBodySchema } from "./transport/http/schemas.ts";

export interface AppDependencies {
  pipeline: GatewayPipeline;
  logger: Logger;
  version?: string;
}

function jsonResponse(
  body: unknown,
  options: {
    status?: number;
    requestId?: string;
    durationMs?: number;
  } = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });
  if (options.requestId) {
    headers.set("x-request-id", options.requestId);
  }
  if (options.durationMs !== undefined) {
    headers.set("x-gateway-duration-ms", String(options.durationMs));
  }

  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers,
  });
}

export function createApp({
  pipeline,
  logger,
  version = "0.1.0",
}: AppDependencies) {
  return new Elysia({ name: "llm-gateway", normalize: false })
    .onError(({ code, error, request }) => {
      const requestId = resolveRequestId(request.headers.get("x-request-id"));
      let publicError: GatewayError;

      if (code === "VALIDATION") {
        publicError = invalidHttpRequest("Request body failed validation.");
      } else if (code === "PARSE") {
        publicError = invalidHttpRequest("Request body must be valid JSON.");
      } else if (error instanceof GatewayError) {
        publicError = error;
      } else {
        publicError = new GatewayError(
          "INTERNAL_ERROR",
          "The gateway could not complete the request.",
          500,
          { cause: error },
        );
      }

      logger.error({
        event: "gateway.http_error",
        requestId,
        errorCode: publicError.code,
        status: publicError.status,
      });

      return createErrorResponse(publicError, requestId, 0);
    })
    .get("/health", () => ({
      status: "ok",
      service: "llm-gateway",
      version,
    }))
    .post(
      "/v1/chat/completions",
      async ({ body, request }) => {
        const startedAt = Date.now();
        const requestId = resolveRequestId(request.headers.get("x-request-id"));

        try {
          const result = await pipeline.execute(
            {
              model: body.model,
              messages: body.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              temperature: body.temperature,
              maxTokens: body.max_tokens,
              stream: body.stream,
            },
            { requestId },
          );

          return jsonResponse(toPublicChatResponse(result.response), {
            requestId: result.context.requestId,
            durationMs: result.durationMs,
          });
        } catch (error) {
          return createErrorResponse(
            error,
            requestId,
            Math.max(0, Date.now() - startedAt),
          );
        }
      },
      { body: chatCompletionBodySchema },
    );
}
