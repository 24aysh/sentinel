import { resolve } from "node:path";
import {
  ConfigurationError,
  GatewayError,
  ModelGateway,
  OpenAICompatibleProvider,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderCompletionOptions,
  type RequestContext,
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

class InspectingProvider implements ModelProvider {
  private attempt = 0;

  constructor(private readonly provider: ModelProvider) {}

  async complete(
    request: ChatRequest,
    context: RequestContext,
    options?: ProviderCompletionOptions,
  ): Promise<ChatResponse> {
    const response = await this.provider.complete(request, context, options);
    this.attempt += 1;
    console.log(
      `\nProvider output before local output guardrail (attempt ${this.attempt}):`,
    );
    console.log(response.choices[0]?.message.content ?? "<no response>");
    return response;
  }
}

try {
  const provider = new InspectingProvider(
    new OpenAICompatibleProvider({
      baseUrl: modelBaseUrl(),
      apiKey: configuredValue("MODEL_API_KEY"),
      timeoutMs: modelTimeoutMs(),
    }),
  );
  const gateway = await ModelGateway.create({
    provider,
    defaultModel: configuredValue("MODEL_DEFAULT") ?? "gpt-5.4-mini",
    policyPath: resolve(import.meta.dir, "../policies/smoke-output-only.yaml"),
  });
  const prompt =
    "Return a short greeting.";

  console.log("Prompt:");
  console.log(prompt);

  const result = await gateway.chat.completions.create(
    { messages: [{ role: "user", content: prompt }] },
    { requestId: "output-guardrail-smoke" },
  );

  console.log("\nGateway response after output guardrail:");
  console.log(result.response.choices[0]?.message.content ?? "<no response>");
  console.log(`\nRequest ID: ${result.context.requestId}`);
  console.log(`Duration: ${result.durationMs}ms`);
} catch (error) {
  const code =
    error instanceof GatewayError || error instanceof ConfigurationError
      ? `${error.name}${error instanceof GatewayError ? ` (${error.code})` : ""}`
      : "SDK_ERROR";
  console.error(
    `Output guardrail smoke failed: ${code}: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  process.exit(1);
}
