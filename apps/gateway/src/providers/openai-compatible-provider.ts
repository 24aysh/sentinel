import type {
  ChatRequest,
  ChatResponse,
  ChatResponseChoice,
  ChatUsage,
} from "../domain/chat.ts";
import { GatewayError } from "../domain/errors.ts";
import type { RequestContext } from "../domain/request-context.ts";
import type { ModelProvider } from "./model-provider.ts";

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetch?: FetchImplementation;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function safeRetryAfter(value: string | null): string | undefined {
  if (!value || value.length > 64) {
    return undefined;
  }

  return /^[A-Za-z0-9,: -]+$/.test(value) ? value : undefined;
}

function parseChoice(value: unknown): ChatResponseChoice | undefined {
  if (!isRecord(value) || typeof value.index !== "number") {
    return undefined;
  }

  const message = value.message;
  if (
    !isRecord(message) ||
    message.role !== "assistant" ||
    typeof message.content !== "string"
  ) {
    return undefined;
  }

  const finishReason = value.finish_reason;
  if (finishReason !== null && typeof finishReason !== "string") {
    return undefined;
  }

  return {
    index: value.index,
    message: {
      role: "assistant",
      content: message.content,
    },
    finishReason,
  };
}

function parseUsage(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    typeof value.prompt_tokens !== "number" ||
    typeof value.completion_tokens !== "number" ||
    typeof value.total_tokens !== "number"
  ) {
    return undefined;
  }

  return {
    promptTokens: value.prompt_tokens,
    completionTokens: value.completion_tokens,
    totalTokens: value.total_tokens,
  };
}

function parseProviderResponse(value: unknown): ChatResponse {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.created !== "number" ||
    typeof value.model !== "string" ||
    !Array.isArray(value.choices) ||
    value.choices.length === 0
  ) {
    throw new GatewayError(
      "INVALID_MODEL_RESPONSE",
      "The model provider returned an invalid response.",
      502,
    );
  }

  const choices = value.choices.map(parseChoice);
  if (choices.some((choice) => choice === undefined)) {
    throw new GatewayError(
      "INVALID_MODEL_RESPONSE",
      "The model provider returned an invalid response.",
      502,
    );
  }

  const response: ChatResponse = {
    id: value.id,
    created: value.created,
    model: value.model,
    choices: choices as ChatResponseChoice[],
  };

  if (value.usage !== undefined) {
    const usage = parseUsage(value.usage);
    if (!usage) {
      throw new GatewayError(
        "INVALID_MODEL_RESPONSE",
        "The model provider returned invalid usage information.",
        502,
      );
    }
    response.usage = usage;
  }

  return response;
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchImplementation;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async complete(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<ChatResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.apiKey) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new GatewayError(
          "MODEL_TIMEOUT",
          "The model provider did not respond before the timeout.",
          504,
          { cause: error },
        );
      }

      throw new GatewayError(
        "MODEL_UPSTREAM_ERROR",
        "The gateway could not reach the model provider.",
        502,
        { cause: error },
      );
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new GatewayError(
          "MODEL_AUTHENTICATION_FAILED",
          "The model provider rejected the gateway credentials.",
          502,
        );
      }

      if (response.status === 429) {
        throw new GatewayError(
          "MODEL_RATE_LIMITED",
          "The model provider rate limit was reached.",
          429,
          { retryAfter: safeRetryAfter(response.headers.get("retry-after")) },
        );
      }

      throw new GatewayError(
        "MODEL_UPSTREAM_ERROR",
        "The model provider could not complete the request.",
        502,
      );
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch (error) {
      throw new GatewayError(
        "INVALID_MODEL_RESPONSE",
        "The model provider returned invalid JSON.",
        502,
        { cause: error },
      );
    }

    return parseProviderResponse(responseBody);
  }
}
