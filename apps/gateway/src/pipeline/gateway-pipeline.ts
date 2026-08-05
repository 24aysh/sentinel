import {
  CHAT_ROLES,
  type ChatInput,
  type ChatRequest,
  type ChatResponse,
} from "../domain/chat.ts";
import { GatewayError, normalizeGatewayError } from "../domain/errors.ts";
import {
  createRequestContext,
  resolveRequestId,
  type RequestContext,
} from "../domain/request-context.ts";
import { silentLogger, type Logger } from "../observability/logger.ts";
import type { ModelProvider } from "../providers/model-provider.ts";
import {
  LifecycleTracker,
  type LifecycleEvent,
  type LifecycleListener,
} from "./lifecycle.ts";

export interface GatewayPipelineOptions {
  provider: ModelProvider;
  defaultModel: string;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}

export interface PipelineExecutionOptions {
  requestId?: string;
}

export interface GatewayPipelineResult {
  response: ChatResponse;
  context: RequestContext;
  durationMs: number;
  lifecycle: readonly LifecycleEvent[];
}

function invalidRequest(message: string): never {
  throw new GatewayError("INVALID_REQUEST", message, 400);
}

function normalizeInput(input: ChatInput, defaultModel: string): ChatRequest {
  if (input.stream === true) {
    throw new GatewayError(
      "UNSUPPORTED_FEATURE",
      "Streaming responses are not supported by this gateway version.",
      400,
    );
  }

  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    invalidRequest("messages must contain at least one item.");
  }

  if (input.model !== undefined && input.model.trim().length === 0) {
    invalidRequest("model must be a non-empty string when provided.");
  }

  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== "number" ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 2)
  ) {
    invalidRequest("temperature must be a number from 0 through 2.");
  }

  if (
    input.maxTokens !== undefined &&
    (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0)
  ) {
    invalidRequest("max_tokens must be a positive integer.");
  }

  const messages = input.messages.map((message) => {
    if (!CHAT_ROLES.includes(message.role)) {
      invalidRequest("Every message must use a supported role.");
    }
    if (
      typeof message.content !== "string" ||
      message.content.trim().length === 0
    ) {
      invalidRequest("Every message must contain non-empty text content.");
    }

    return { role: message.role, content: message.content };
  });

  const request: ChatRequest = {
    model: input.model?.trim() || defaultModel,
    messages,
  };

  if (input.temperature !== undefined) {
    request.temperature = input.temperature;
  }
  if (input.maxTokens !== undefined) {
    request.maxTokens = input.maxTokens;
  }

  return request;
}

export class GatewayPipeline {
  private readonly provider: ModelProvider;
  private readonly defaultModel: string;
  private readonly logger: Logger;
  private readonly lifecycleListener?: LifecycleListener;

  constructor(options: GatewayPipelineOptions) {
    this.provider = options.provider;
    this.defaultModel = options.defaultModel;
    this.logger = options.logger ?? silentLogger;
    this.lifecycleListener = options.lifecycleListener;
  }

  async execute(
    input: ChatInput,
    options: PipelineExecutionOptions = {},
  ): Promise<GatewayPipelineResult> {
    const requestId = resolveRequestId(options.requestId);
    const initialModel = input.model?.trim() || this.defaultModel;
    const context = createRequestContext(requestId, initialModel);
    const lifecycle = new LifecycleTracker(
      context,
      this.logger,
      this.lifecycleListener,
    );

    lifecycle.record("received");

    try {
      const request = normalizeInput(input, this.defaultModel);
      lifecycle.record("validated");
      lifecycle.record("provider_started");
      const response = await this.provider.complete(request, context);
      lifecycle.record("provider_completed");
      lifecycle.record("completed");

      return {
        response,
        context,
        durationMs: Math.max(0, Date.now() - context.startedAt),
        lifecycle: lifecycle.events,
      };
    } catch (error) {
      const gatewayError = normalizeGatewayError(error);
      lifecycle.recordFailure(gatewayError.code);
      throw gatewayError;
    }
  }
}
