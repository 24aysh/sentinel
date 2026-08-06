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
import type { GuardrailHub } from "../guardrails/types.ts";
import { silentLogger, type Logger } from "../observability/logger.ts";
import type { ModelProvider } from "../providers/model-provider.ts";
import {
  LifecycleTracker,
  type LifecycleEvent,
  type LifecycleListener,
  type LifecycleMetadata,
} from "./lifecycle.ts";

export interface GatewayPipelineOptions {
  provider: ModelProvider;
  defaultModel: string;
  guardrails?: GuardrailHub;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}

export interface ChatCompletionRequestOptions {
  requestId?: string;
}

export interface GatewayExecutionResult {
  response: ChatResponse;
  providerRequest: ChatRequest;
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

  return {
    model: input.model?.trim() || defaultModel,
    messages,
    ...(input.temperature !== undefined && {
      temperature: input.temperature,
    }),
    ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
  };
}

function aggregateUsage(
  finalResponse: ChatResponse,
  attempts: readonly ChatResponse[],
): ChatResponse {
  if (attempts.length <= 1) return finalResponse;

  const { usage: _ignored, ...responseWithoutUsage } = finalResponse;
  if (attempts.some(({ usage }) => usage === undefined))
    return responseWithoutUsage;

  return {
    ...responseWithoutUsage,
    usage: attempts.reduce(
      (total, response) => ({
        promptTokens: total.promptTokens + response.usage!.promptTokens,
        completionTokens:
          total.completionTokens + response.usage!.completionTokens,
        totalTokens: total.totalTokens + response.usage!.totalTokens,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    ),
  };
}

export class GatewayPipeline {
  private readonly provider: ModelProvider;
  private readonly defaultModel: string;
  private readonly guardrails?: GuardrailHub;
  private readonly logger: Logger;
  private readonly lifecycleListener?: LifecycleListener;

  constructor({
    provider,
    defaultModel,
    guardrails,
    logger = silentLogger,
    lifecycleListener,
  }: GatewayPipelineOptions) {
    this.provider = provider;
    this.defaultModel = defaultModel;
    this.guardrails = guardrails;
    this.logger = logger;
    this.lifecycleListener = lifecycleListener;
  }

  async execute(
    input: ChatInput,
    options: ChatCompletionRequestOptions = {},
  ): Promise<GatewayExecutionResult> {
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
      let request = normalizeInput(input, this.defaultModel);
      lifecycle.record("validated");

      if (this.guardrails) {
        const policyMetadata = this.policyMetadata();
        lifecycle.record("input_guardrails_started", policyMetadata);
        const inputResult = await this.evaluateGuardrail(
          "input",
          context,
          () => this.guardrails!.evaluateInput(request, context),
          {
            decision: "allow" as const,
            request,
            findingCount: 0,
            ruleIds: [],
            entityTypes: [],
          },
        );
        const decisionMetadata = {
          decision: inputResult.decision,
          findingCount: inputResult.findingCount,
          ruleIds: inputResult.ruleIds,
          entityTypes: inputResult.entityTypes,
        };
        lifecycle.record("input_guardrails_completed", {
          ...policyMetadata,
          ...decisionMetadata,
        });
        this.logDecision("input", decisionMetadata, context);

        if (inputResult.decision === "block") {
          throw new GatewayError(
            "INPUT_GUARDRAIL_BLOCKED",
            "The request was blocked by an input guardrail.",
            400,
          );
        }
        request = inputResult.request;
      }

      const responses: ChatResponse[] = [];
      const providerRequest = request;
      let attempt = 1;

      while (true) {
        const attemptMetadata = this.guardrails
          ? { attempt, maximumAttempts: this.guardrails.maximumAttempts }
          : {};
        if (attempt > 1) {
          lifecycle.record("retry_started", attemptMetadata);
        }

        lifecycle.record("provider_started", attemptMetadata);
        const response = await this.provider.complete(request, context);
        responses.push(response);
        lifecycle.record("provider_completed", attemptMetadata);

        if (!this.guardrails) {
          lifecycle.record("completed");
          return this.result(response, providerRequest, context, lifecycle);
        }

        const policyMetadata = this.policyMetadata();
        lifecycle.record("output_guardrails_started", {
          ...policyMetadata,
          ...attemptMetadata,
        });
        let outputResult = await this.evaluateGuardrail(
          "output",
          context,
          () =>
            this.guardrails!.evaluateOutput(
              request,
              response,
              context,
              attempt,
            ),
          { decision: "allow" as const },
        );
        if (
          outputResult.decision === "retry" &&
          attempt >= this.guardrails.maximumAttempts
        ) {
          outputResult = { decision: "block", ruleId: outputResult.ruleId };
        }
        const decisionMetadata = {
          ...attemptMetadata,
          decision: outputResult.decision,
          ruleIds:
            outputResult.decision === "allow" ? [] : [outputResult.ruleId],
        };
        lifecycle.record("output_guardrails_completed", {
          ...policyMetadata,
          ...decisionMetadata,
        });
        this.logDecision("output", decisionMetadata, context);

        if (outputResult.decision === "block") {
          throw new GatewayError(
            "OUTPUT_GUARDRAIL_FAILED",
            "The model response did not satisfy the output policy.",
            502,
          );
        }
        if (outputResult.decision === "retry") {
          request = outputResult.repairRequest;
          attempt += 1;
          continue;
        }

        const finalResponse = aggregateUsage(response, responses);
        lifecycle.record("completed");
        return this.result(finalResponse, providerRequest, context, lifecycle);
      }
    } catch (error) {
      const gatewayError = normalizeGatewayError(error);
      lifecycle.recordFailure(gatewayError.code);
      throw gatewayError;
    }
  }

  private async evaluateGuardrail<T>(
    phase: "input" | "output",
    context: RequestContext,
    evaluate: () => Promise<T>,
    failOpenResult: T,
  ): Promise<T> {
    try {
      return await evaluate();
    } catch (error) {
      if (this.guardrails!.runtimeFailureMode === "closed") {
        throw new GatewayError(
          "GUARDRAIL_EVALUATION_FAILED",
          "The gateway could not evaluate the configured guardrails.",
          500,
          { cause: error },
        );
      }
      this.logRuntimeFailure(phase, context);
      return failOpenResult;
    }
  }

  private policyMetadata(): LifecycleMetadata {
    return {
      policyName: this.guardrails!.identity.name,
      policyVersion: this.guardrails!.identity.version,
    };
  }

  private logDecision(
    phase: "input" | "output",
    metadata: Record<string, unknown>,
    context: RequestContext,
  ): void {
    this.logger.info({
      event: "gateway.guardrail_decision",
      requestId: context.requestId,
      phase,
      policyName: this.guardrails!.identity.name,
      policyVersion: this.guardrails!.identity.version,
      ...metadata,
    });
  }

  private logRuntimeFailure(
    phase: "input" | "output",
    context: RequestContext,
  ): void {
    this.logger.error({
      event: "gateway.guardrail_runtime_failure",
      requestId: context.requestId,
      phase,
      action: "fail_open",
      policyName: this.guardrails!.identity.name,
      policyVersion: this.guardrails!.identity.version,
    });
  }

  private result(
    response: ChatResponse,
    providerRequest: ChatRequest,
    context: RequestContext,
    lifecycle: LifecycleTracker,
  ): GatewayExecutionResult {
    return {
      response,
      providerRequest,
      context,
      durationMs: Math.max(0, Date.now() - context.startedAt),
      lifecycle: lifecycle.events,
    };
  }
}
