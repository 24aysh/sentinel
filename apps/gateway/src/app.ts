import { Elysia } from "elysia";
import {
  toPublicChatRequest,
  toPublicChatResponse,
  type ChatInput,
} from "./domain/chat.ts";
import { GatewayError } from "./domain/errors.ts";
import { resolveRequestId } from "./domain/request-context.ts";
import type { Logger } from "./observability/logger.ts";
import type {
  ChatCompletionRequestOptions,
  GatewayExecutionResult,
} from "./pipeline/gateway-pipeline.ts";
import {
  createErrorResponse,
  invalidHttpRequest,
  jsonResponse,
} from "./transport/http/error-response.ts";
import { chatCompletionBodySchema } from "./transport/http/schemas.ts";

export interface GatewayExecutor {
  chat: {
    completions: {
      create(
        input: ChatInput,
        options?: ChatCompletionRequestOptions,
      ): Promise<GatewayExecutionResult>;
    };
  };
}

export interface AppDependencies {
  gateway: GatewayExecutor;
  logger: Logger;
  exposeProviderRequest?: boolean;
  version?: string;
}

export function createApp({
  gateway,
  logger,
  exposeProviderRequest = false,
  version = "0.1.0",
}: AppDependencies) {
  return new Elysia({ name: "llm-gateway", normalize: false })
    .onError(({ code, error, request }) => {
      const requestId = resolveRequestId(request.headers.get("x-request-id"));
      const publicError =
        code === "VALIDATION"
          ? invalidHttpRequest("Request body failed validation.")
          : code === "PARSE"
            ? invalidHttpRequest("Request body must be valid JSON.")
            : error instanceof GatewayError
              ? error
              : new GatewayError(
                  "INTERNAL_ERROR",
                  "The gateway could not complete the request.",
                  500,
                  { cause: error },
                );

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
          const result = await gateway.chat.completions.create(
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

          const publicResponse = toPublicChatResponse(result.response);
          const responseBody =
            exposeProviderRequest &&
            request.headers.get("x-gateway-debug-provider-request") === "true"
              ? {
                  ...publicResponse,
                  gateway_debug: {
                    provider_request: toPublicChatRequest(
                      result.providerRequest,
                    ),
                  },
                }
              : publicResponse;

          return jsonResponse(responseBody, {
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
