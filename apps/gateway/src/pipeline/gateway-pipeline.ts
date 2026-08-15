import type { ChatInput, ChatRequest, ChatResponse } from "../domain/chat.ts";
import { normalizeChatInput } from "../domain/chat-normalizer.ts";
import { GatewayError, normalizeGatewayError } from "../domain/errors.ts";
import {
  createRequestContext,
  resolveRequestId,
  type RequestContext,
} from "../domain/request-context.ts";
import { InputDetectorEvaluationError } from "../guardrails/input/input-evaluation-coordinator.ts";
import {
  classifyChatResponse,
  evaluateToolCalls,
  filterToolDefinitions,
} from "../guardrails/tools/tool-call-evaluator.ts";
import { ToolSchemaRegistry } from "../guardrails/tools/tool-schema-validator.ts";
import type {
  GuardrailHub,
  InputDetectorType,
  InputExecutionMode,
} from "../guardrails/types.ts";
import { silentLogger, type Logger } from "../observability/logger.ts";
import type { ModelProvider } from "../providers/model-provider.ts";
import {
  LifecycleTracker,
  type LifecycleEvent,
  type LifecycleListener,
  type LifecycleMetadata,
} from "./lifecycle.ts";

interface GatewayPipelineOptions {
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
  toolGuardrails?: ToolGuardrailSummary;
}

export interface ToolGuardrailSummary {
  decision: "allow" | "filter";
  allowedCallCount: number;
  blockedCallCount: number;
  ruleIds: string[];
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
      let request = normalizeChatInput(input, this.defaultModel);
      const toolSchemas = new ToolSchemaRegistry(request.tools);
      toolSchemas.validateRequestHistory(request);
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
          detectorTypes: inputResult.detectorTypes,
          failedDetectorTypes: inputResult.failedDetectorTypes,
          promptInjectionModelId: inputResult.promptInjectionModelId,
          evaluatedMessageCount: inputResult.evaluatedMessageCount,
          evaluatedWindowCount: inputResult.evaluatedWindowCount,
          inputExecutionMode: inputResult.inputExecutionMode,
        };
        lifecycle.record("input_guardrails_completed", {
          ...policyMetadata,
          ...decisionMetadata,
        });
        this.logDecision("input", decisionMetadata, context);
        if (inputResult.failedDetectorTypes?.length) {
          this.logRuntimeFailure(
            "input",
            context,
            inputResult.failedDetectorTypes,
            inputResult.decision === "block"
              ? "blocked_by_other_detector"
              : "fail_open",
            inputResult.inputExecutionMode,
          );
        }

        if (inputResult.decision === "block") {
          throw new GatewayError(
            "INPUT_GUARDRAIL_BLOCKED",
            "The request was blocked by an input guardrail.",
            400,
          );
        }
        request = inputResult.request;
      }

      if (this.guardrails?.toolPolicy && request.tools) {
        const policyMetadata = this.policyMetadata();
        lifecycle.record("tool_definitions_guardrails_started", policyMetadata);
        const toolDefinitions = filterToolDefinitions(
          request,
          this.guardrails.toolPolicy,
        );
        const decisionMetadata = {
          decision:
            toolDefinitions.blockedDefinitionCount > 0
              ? ("filter" as const)
              : ("allow" as const),
          allowedDefinitionCount: toolDefinitions.allowedDefinitionCount,
          blockedDefinitionCount: toolDefinitions.blockedDefinitionCount,
          ruleIds: toolDefinitions.ruleIds,
        };
        lifecycle.record("tool_definitions_guardrails_completed", {
          ...policyMetadata,
          ...decisionMetadata,
        });
        this.logDecision("tool_definitions", decisionMetadata, context);
        request = toolDefinitions.request;
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
        const providerOptions = this.guardrails?.outputJsonSchema
          ? { outputJsonSchema: this.guardrails.outputJsonSchema }
          : undefined;
        const response = await this.provider.complete(
          request,
          context,
          providerOptions,
        );
        responses.push(response);
        lifecycle.record("provider_completed", attemptMetadata);

        if (classifyChatResponse(response) === "tool_calls") {
          const policyMetadata = this.guardrails ? this.policyMetadata() : {};
          lifecycle.record("tool_calls_guardrails_started", {
            ...policyMetadata,
            ...attemptMetadata,
          });
          const toolResult = evaluateToolCalls(
            request,
            response,
            toolSchemas,
            this.guardrails?.toolPolicy,
          );
          const decisionMetadata = {
            ...attemptMetadata,
            decision: toolResult.decision,
            allowedCallCount: toolResult.allowedCallCount,
            blockedCallCount: toolResult.blockedCallCount,
            ruleIds: toolResult.ruleIds,
          };
          lifecycle.record("tool_calls_guardrails_completed", {
            ...policyMetadata,
            ...decisionMetadata,
          });
          this.logDecision("tool_calls", decisionMetadata, context);
          if (toolResult.decision === "block") {
            throw new GatewayError(
              "TOOL_GUARDRAIL_BLOCKED",
              "The model tool calls did not satisfy the tool policy.",
              502,
            );
          }
          const finalResponse = aggregateUsage(toolResult.response, responses);
          lifecycle.record("completed");
          return this.result(
            finalResponse,
            providerRequest,
            context,
            lifecycle,
            {
              decision: toolResult.decision,
              allowedCallCount: toolResult.allowedCallCount,
              blockedCallCount: toolResult.blockedCallCount,
              ruleIds: toolResult.ruleIds,
            },
          );
        }

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
          outputResult = {
            decision: "block",
            ruleId: outputResult.ruleId,
            violationType: outputResult.violationType,
          };
        }
        const decisionMetadata = {
          ...attemptMetadata,
          decision: outputResult.decision,
          ruleIds:
            outputResult.decision === "allow" ? [] : [outputResult.ruleId],
          violationType:
            outputResult.decision === "allow"
              ? undefined
              : outputResult.violationType,
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
        if (error instanceof InputDetectorEvaluationError) {
          this.logRuntimeFailure(
            phase,
            context,
            error.failedDetectorTypes,
            "fail_closed",
            error.inputExecutionMode,
          );
        }
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
    phase: "input" | "output" | "tool_definitions" | "tool_calls",
    metadata: Record<string, unknown>,
    context: RequestContext,
  ): void {
    this.logger.info({
      event: "gateway.guardrail_decision",
      requestId: context.requestId,
      phase,
      ...(this.guardrails && {
        policyName: this.guardrails.identity.name,
        policyVersion: this.guardrails.identity.version,
      }),
      ...metadata,
    });
  }

  private logRuntimeFailure(
    phase: "input" | "output",
    context: RequestContext,
    detectorTypes?: readonly InputDetectorType[],
    action:
      "fail_open" | "fail_closed" | "blocked_by_other_detector" = "fail_open",
    inputExecutionMode?: InputExecutionMode,
  ): void {
    this.logger.error({
      event: "gateway.guardrail_runtime_failure",
      requestId: context.requestId,
      phase,
      action,
      policyName: this.guardrails!.identity.name,
      policyVersion: this.guardrails!.identity.version,
      ...(detectorTypes && { detectorTypes }),
      ...(inputExecutionMode && { inputExecutionMode }),
    });
  }

  private result(
    response: ChatResponse,
    providerRequest: ChatRequest,
    context: RequestContext,
    lifecycle: LifecycleTracker,
    toolGuardrails?: ToolGuardrailSummary,
  ): GatewayExecutionResult {
    return {
      response,
      providerRequest,
      context,
      durationMs: Math.max(0, Date.now() - context.startedAt),
      lifecycle: lifecycle.events,
      ...(toolGuardrails && { toolGuardrails }),
    };
  }
}
