import type { ChatInput } from "./domain/chat.ts";
import { ConfigurationError } from "./domain/errors.ts";
import {
  InvalidOutputSchemaConfigurationError,
  loadGuardrailPolicy,
} from "./guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "./guardrails/guardrail-hub.ts";
import { loadOnnxPromptInjectionClassifier } from "./guardrails/input/onnx-prompt-injection-classifier.ts";
import type {
  GuardrailHub,
  LoadedGuardrailPolicy,
} from "./guardrails/types.ts";
import { silentLogger, type Logger } from "./observability/logger.ts";
import {
  GatewayPipeline,
  type ChatCompletionRequestOptions,
  type GatewayExecutionResult,
} from "./pipeline/gateway-pipeline.ts";
import type { LifecycleListener } from "./pipeline/lifecycle.ts";
import type { ModelProvider } from "./providers/model-provider.ts";

export interface ModelGatewayOptions {
  provider: ModelProvider;
  defaultModel: string;
  guardrails?: GuardrailHub;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}

export interface ModelGatewayCreateOptions {
  provider: ModelProvider;
  defaultModel: string;
  policyPath?: string;
  policyWorkingDirectory?: string;
  promptInjectionModelPath?: string;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}

export class ChatCompletionsResource {
  constructor(private readonly pipeline: GatewayPipeline) {}

  create(
    input: ChatInput,
    options?: ChatCompletionRequestOptions,
  ): Promise<GatewayExecutionResult> {
    return this.pipeline.execute(input, options);
  }
}

export class ChatResource {
  readonly completions: ChatCompletionsResource;

  constructor(pipeline: GatewayPipeline) {
    this.completions = new ChatCompletionsResource(pipeline);
  }
}

export class ModelGateway {
  readonly chat: ChatResource;

  constructor({
    provider,
    defaultModel,
    guardrails,
    logger = silentLogger,
    lifecycleListener,
  }: ModelGatewayOptions) {
    if (typeof defaultModel !== "string" || !defaultModel.trim()) {
      throw new ConfigurationError("defaultModel must be a non-empty string.");
    }
    const normalizedModel = defaultModel.trim();

    this.chat = new ChatResource(
      new GatewayPipeline({
        provider,
        defaultModel: normalizedModel,
        guardrails,
        logger,
        lifecycleListener,
      }),
    );
  }

  static async create({
    provider,
    defaultModel,
    policyPath,
    policyWorkingDirectory,
    promptInjectionModelPath,
    logger = silentLogger,
    lifecycleListener,
  }: ModelGatewayCreateOptions): Promise<ModelGateway> {
    let policy: LoadedGuardrailPolicy | undefined;
    try {
      policy = policyPath
        ? await loadGuardrailPolicy(policyPath, policyWorkingDirectory)
        : undefined;
    } catch (error) {
      if (error instanceof InvalidOutputSchemaConfigurationError) {
        try {
          logger.error({
            event: "gateway.guardrail_policy_rejected",
            phase: "startup",
            reasonCode: "invalid_output_schema",
          });
        } catch {
          // A user logger must not mask the configuration error.
        }
      }
      throw error;
    }
    const requiresPromptInjectionModel =
      policy?.enabled === true &&
      policy.input.some((rule) => rule.detector === "prompt_injection");
    if (
      promptInjectionModelPath &&
      !requiresPromptInjectionModel &&
      policy?.enabled !== false
    ) {
      throw new ConfigurationError(
        "promptInjectionModelPath requires an enabled prompt_injection policy rule.",
      );
    }
    if (requiresPromptInjectionModel && !promptInjectionModelPath) {
      throw new ConfigurationError(
        "promptInjectionModelPath is required by the enabled prompt_injection policy rule.",
      );
    }
    const promptInjectionClassifier = requiresPromptInjectionModel
      ? await loadOnnxPromptInjectionClassifier(
          promptInjectionModelPath!,
          policyWorkingDirectory,
        )
      : undefined;
    const guardrails = policy?.enabled
      ? new ConfiguredGuardrailHub(policy, promptInjectionClassifier)
      : undefined;

    if (policy) {
      logger.info({
        event: "gateway.guardrail_policy_loaded",
        policyName: policy.identity.name,
        policyVersion: policy.identity.version,
        enabled: policy.enabled,
        inputRuleCount: policy.input.length,
        outputRuleCount: policy.output ? 1 : 0,
      });
    }
    if (promptInjectionClassifier) {
      logger.info({
        event: "gateway.prompt_injection_model_loaded",
        artifactId: promptInjectionClassifier.identity.artifactId,
      });
    }

    return new ModelGateway({
      provider,
      defaultModel,
      guardrails,
      logger,
      lifecycleListener,
    });
  }
}
