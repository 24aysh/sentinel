export type ModelProviderName = "openai-compatible";

export interface GatewayConfig {
  host: string;
  port: number;
  modelProvider: ModelProviderName;
  modelBaseUrl: string;
  modelApiKey?: string;
  defaultModel: string;
  modelTimeoutMs: number;
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
  const value =
    rawValue === undefined || rawValue === "" ? fallback : Number(rawValue);

  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ConfigurationError(
      `${name} must be an integer from ${range.min} through ${range.max}.`,
    );
  }

  return value;
}

function requiredString(
  name: string,
  rawValue: string | undefined,
  fallback?: string,
): string {
  const value = rawValue?.trim() || fallback;

  if (!value) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }

  return value;
}

function parseBaseUrl(rawValue: string | undefined): string {
  const value = requiredString(
    "MODEL_BASE_URL",
    rawValue,
    "https://api.openai.com/v1",
  );

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("MODEL_BASE_URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError("MODEL_BASE_URL must use HTTP or HTTPS.");
  }

  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: Environment = process.env): GatewayConfig {
  const modelProvider = env.MODEL_PROVIDER?.trim() || "openai-compatible";

  if (modelProvider !== "openai-compatible") {
    throw new ConfigurationError(
      `MODEL_PROVIDER must be "openai-compatible" for this gateway version.`,
    );
  }

  const apiKey = env.MODEL_API_KEY?.trim();

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
  };
}
