import { createApp } from "./app.ts";
import { loadConfig, type GatewayConfig } from "./config/env.ts";
import { composeModelGateway } from "./model-gateway.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
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
  const { gateway, guardrails, policy } = await composeModelGateway({
    provider,
    defaultModel: config.defaultModel,
    policyPath: config.guardrailPolicyPath,
    logger,
  });
  const app = createApp({
    gateway,
    logger,
    exposeProviderRequest: config.debugExposeProviderRequest,
  });

  return { app, config, gateway, guardrails, logger, policy };
}
