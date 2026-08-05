import { createApp } from "./app.ts";
import { loadConfig, type GatewayConfig } from "./config/env.ts";
import { ConsoleLogger, type Logger } from "./observability/logger.ts";
import { GatewayPipeline } from "./pipeline/gateway-pipeline.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.ts";

export function createRuntime(
  config: GatewayConfig = loadConfig(),
  logger: Logger = new ConsoleLogger(),
) {
  const provider = new OpenAICompatibleProvider({
    baseUrl: config.modelBaseUrl,
    apiKey: config.modelApiKey,
    timeoutMs: config.modelTimeoutMs,
  });
  const pipeline = new GatewayPipeline({
    provider,
    defaultModel: config.defaultModel,
    logger,
  });
  const app = createApp({ pipeline, logger });

  return { app, config, logger, pipeline, provider };
}
