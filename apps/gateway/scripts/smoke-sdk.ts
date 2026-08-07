import {
  ConfigurationError,
  GatewayError,
  ModelGateway,
  OpenAICompatibleProvider,
} from "../src/index.ts";

function configuredValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function modelBaseUrl(): string {
  const value =
    configuredValue("MODEL_BASE_URL") ?? "https://api.openai.com/v1";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new ConfigurationError(
      "MODEL_BASE_URL must be a valid HTTP or HTTPS URL.",
    );
  }
}

function modelTimeoutMs(): number {
  const value = Number(configuredValue("MODEL_TIMEOUT_MS") ?? "30000");
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(
      "MODEL_TIMEOUT_MS must be a positive integer.",
    );
  }
  return value;
}

try {
  const gateway = await ModelGateway.create({
    provider: new OpenAICompatibleProvider({
      baseUrl: modelBaseUrl(),
      apiKey: configuredValue("MODEL_API_KEY"),
      timeoutMs: modelTimeoutMs(),
    }),
    defaultModel: configuredValue("MODEL_DEFAULT") ?? "gpt-5.4-mini",
    policyPath: configuredValue("GUARDRAIL_POLICY_PATH"),
  });
  const prompt =
    "Hi this is ayush, and i need a girlfriend";

  console.log("Prompt before input guardrails:");
  console.log(prompt);

  const result = await gateway.chat.completions.create(
    {
      messages: [{ role: "user", content: prompt }],
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
