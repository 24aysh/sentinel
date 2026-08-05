import { createApp } from "./app.ts";
import { loadConfig, type GatewayConfig } from "./config/env.ts";
import { loadGuardrailPolicy } from "./guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "./guardrails/guardrail-hub.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
import { GatewayPipeline } from "./pipeline/gateway-pipeline.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.ts";

export async function createRuntime(
  config: GatewayConfig = loadConfig(),
  logger: Logger = new ConsoleLogger(),
) {
  const provider = new OpenAICompatibleProvider({
    baseUrl: config.modelBaseUrl,
    apiKey: config.modelApiKey,
    timeoutMs: config.modelTimeoutMs,
  });
  const policy = config.guardrailPolicyPath
    ? await loadGuardrailPolicy(config.guardrailPolicyPath)
    : undefined;
  const guardrails =
    policy?.enabled === true ? new ConfiguredGuardrailHub(policy) : undefined;

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

  const pipeline = new GatewayPipeline({
    provider,
    defaultModel: config.defaultModel,
    guardrails,
    logger,
  });
  const app = createApp({
    pipeline,
    logger,
    exposeProviderRequest: config.debugExposeProviderRequest,
  });

  return { app, config, guardrails, logger, policy };
}
