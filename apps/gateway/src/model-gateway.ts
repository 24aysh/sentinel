import type { ChatInput } from "./domain/chat.ts";
import { ConfigurationError } from "./domain/errors.ts";
import { loadGuardrailPolicy } from "./guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "./guardrails/guardrail-hub.ts";
import type { GuardrailHub } from "./guardrails/types.ts";
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
    logger = silentLogger,
    lifecycleListener,
  }: ModelGatewayCreateOptions): Promise<ModelGateway> {
    const policy = policyPath
      ? await loadGuardrailPolicy(policyPath, policyWorkingDirectory)
      : undefined;
    const guardrails = policy?.enabled
      ? new ConfiguredGuardrailHub(policy)
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

    return new ModelGateway({
      provider,
      defaultModel,
      guardrails,
      logger,
      lifecycleListener,
    });
  }
}
