import {
  ConfigurationError,
  GatewayError,
  ModelGateway,
  OpenAICompatibleProvider,
} from "../src/index.ts";
import { loadConfig } from "../src/server.ts";

try {
  const config = loadConfig();
  const gateway = await ModelGateway.create({
    provider: new OpenAICompatibleProvider({
      baseUrl: config.modelBaseUrl,
      apiKey: config.modelApiKey,
      timeoutMs: config.modelTimeoutMs,
    }),
    defaultModel: config.defaultModel,
    policyPath: config.guardrailPolicyPath,
  });

  const result = await gateway.chat.completions.create(
    {
      messages: [
        {
          role: "user",
          content:
            'Return only JSON with status "ok", a short message, and contact exactly as provided: smoke.sdk@gmail.com',
        },
      ],
    },
    { requestId: "sdk-e2e-smoke" },
  );

  console.log("Provider request after input guardrails:");
  console.log(JSON.stringify(result.providerRequest, null, 2));
  console.log("\nAssistant response:");
  console.log(result.response.choices[0]?.message.content ?? "<no response>");
  console.log(`\nRequest ID: ${result.context.requestId}`);
  console.log(`Duration: ${result.durationMs}ms`);
} catch (error) {
  const code =
    error instanceof GatewayError || error instanceof ConfigurationError
      ? `${error.name}${error instanceof GatewayError ? ` (${error.code})` : ""}`
      : "SDK_ERROR";
  console.error(
    `SDK gateway request failed: ${code}: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exit(1);
}
