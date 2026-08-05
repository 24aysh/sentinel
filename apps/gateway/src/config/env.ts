export interface GatewayConfig {
  host: string;
  port: number;
  modelProvider: "openai-compatible";
  modelBaseUrl: string;
  modelApiKey?: string;
  defaultModel: string;
  modelTimeoutMs: number;
  guardrailPolicyPath?: string;
  debugExposeProviderRequest: boolean;
}

type Environment = Record<string, string | undefined>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseInteger(
  name: string,
  rawValue: string | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  const value = rawValue ? Number(rawValue) : fallback;

  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ConfigurationError(
      `${name} must be an integer from ${range.min} through ${range.max}.`,
    );
  }

  return value;
}

function parseBoolean(
  name: string,
  rawValue: string | undefined,
  fallback: boolean,
): boolean {
  const value = rawValue?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be "true" or "false".`);
}

function requiredString(
  name: string,
  rawValue: string | undefined,
  fallback?: string,
): string {
  const value = rawValue?.trim() || fallback;

  if (!value)
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  return value;
}

function parseBaseUrl(rawValue: string | undefined): string {
  const value = requiredString(
    "MODEL_BASE_URL",
    rawValue,
    "https://api.openai.com/v1",
  );

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigurationError("MODEL_BASE_URL must use HTTP or HTTPS.");
    }
    return url.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("MODEL_BASE_URL must be a valid URL.");
  }
}

export function loadConfig(env: Environment = process.env): GatewayConfig {
  const modelProvider = env.MODEL_PROVIDER?.trim() || "openai-compatible";

  if (modelProvider !== "openai-compatible") {
    throw new ConfigurationError(
      `MODEL_PROVIDER must be "openai-compatible" for this gateway version.`,
    );
  }

  const apiKey = env.MODEL_API_KEY?.trim();
  const guardrailPolicyPath = env.GUARDRAIL_POLICY_PATH?.trim();

  return {
    host: requiredString("GATEWAY_HOST", env.GATEWAY_HOST, "0.0.0.0"),
    port: parseInteger("GATEWAY_PORT", env.GATEWAY_PORT, 3001, {
      min: 1,
      max: 65_535,
    }),
    modelProvider,
    modelBaseUrl: parseBaseUrl(env.MODEL_BASE_URL),
    modelApiKey: apiKey || undefined,
    defaultModel: requiredString(
      "MODEL_DEFAULT",
      env.MODEL_DEFAULT,
      "gpt-4.1-mini",
    ),
    modelTimeoutMs: parseInteger(
      "MODEL_TIMEOUT_MS",
      env.MODEL_TIMEOUT_MS,
      30_000,
      { min: 1, max: 600_000 },
    ),
    guardrailPolicyPath: guardrailPolicyPath || undefined,
    debugExposeProviderRequest: parseBoolean(
      "GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST",
      env.GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST,
      false,
    ),
  };
}
