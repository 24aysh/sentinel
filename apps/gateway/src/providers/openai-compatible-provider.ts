import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  FunctionToolCall,
} from "../domain/chat.ts";
import { ConfigurationError, GatewayError } from "../domain/errors.ts";
import type { RequestContext } from "../domain/request-context.ts";
import type {
  ModelProvider,
  ProviderCompletionOptions,
} from "./model-provider.ts";

export type FetchImplementation = (
  ...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetch?: FetchImplementation;
  structuredOutputMode?: "json_schema" | "disabled";
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
  return value && value.length <= 64 && /^[A-Za-z0-9,: -]+$/.test(value)
    ? value
    : undefined;
}

function invalidResponse(
  message = "The model provider returned an invalid response.",
): never {
  throw new GatewayError("INVALID_MODEL_RESPONSE", message, 502);
}

function toProviderMessage(message: ChatMessage) {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCalls && { tool_calls: message.toolCalls }),
    };
  }
  if (message.role === "tool") {
    return {
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  return message;
}

function toProviderRequest(
  request: ChatRequest,
  options: ProviderCompletionOptions | undefined,
  structuredOutputMode: "json_schema" | "disabled",
) {
  return {
    model: request.model,
    messages: request.messages.map(toProviderMessage),
    stream: false,
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.maxTokens !== undefined && {
      max_tokens: request.maxTokens,
    }),
    ...(request.tools && { tools: request.tools }),
    ...(request.toolChoice !== undefined && {
      tool_choice: request.toolChoice,
    }),
    ...(request.parallelToolCalls !== undefined && {
      parallel_tool_calls: request.parallelToolCalls,
    }),
    ...(structuredOutputMode === "json_schema" &&
      options?.outputJsonSchema && {
        response_format: {
          type: "json_schema",
          json_schema: options.outputJsonSchema,
        },
      }),
  };
}

function parseToolCall(value: unknown): FunctionToolCall {
  const callable = isRecord(value) ? value.function : undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    value.type !== "function" ||
    !isRecord(callable) ||
    typeof callable.name !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(callable.name) ||
    typeof callable.arguments !== "string" ||
    callable.arguments.length > 1_000_000
  ) {
    invalidResponse();
  }
  return {
    id: value.id,
    type: "function",
    function: {
      name: callable.name,
      arguments: callable.arguments,
    },
  };
}

function parseChoice(value: unknown): ChatResponse["choices"][number] {
  const message = isRecord(value) ? value.message : undefined;
  if (
    !isRecord(value) ||
    typeof value.index !== "number" ||
    !isRecord(message) ||
    message.role !== "assistant"
  ) {
    invalidResponse();
  }

  const toolCalls =
    message.tool_calls === undefined
      ? undefined
      : Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls.map(parseToolCall)
        : invalidResponse();
  if (message.content !== null && typeof message.content !== "string") {
    invalidResponse();
  }
  if (message.content === null && !toolCalls) invalidResponse();

  const finishReason = value.finish_reason;
  if (finishReason !== null && typeof finishReason !== "string") {
    invalidResponse();
  }

  return {
    index: value.index,
    message: {
      role: "assistant",
      content: message.content,
      ...(toolCalls && { toolCalls }),
    },
    finishReason,
  };
}

function parseUsage(value: unknown): NonNullable<ChatResponse["usage"]> {
  if (
    !isRecord(value) ||
    typeof value.prompt_tokens !== "number" ||
    typeof value.completion_tokens !== "number" ||
    typeof value.total_tokens !== "number"
  ) {
    invalidResponse("The model provider returned invalid usage information.");
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
    invalidResponse();
  }

  const choices = value.choices.map(parseChoice);
  const response: ChatResponse = {
    id: value.id,
    created: value.created,
    model: value.model,
    choices,
  };

  if (value.usage !== undefined) {
    response.usage = parseUsage(value.usage);
  }

  return response;
}

export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImplementation: FetchImplementation;
  private readonly structuredOutputMode: "json_schema" | "disabled";

  constructor({
    baseUrl,
    apiKey,
    timeoutMs,
    fetch: fetchImplementation,
    structuredOutputMode = "json_schema",
  }: OpenAICompatibleProviderOptions) {
    if (
      structuredOutputMode !== "json_schema" &&
      structuredOutputMode !== "disabled"
    ) {
      throw new ConfigurationError(
        "structuredOutputMode must be json_schema or disabled.",
      );
    }
    this.endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImplementation = fetchImplementation ?? globalThis.fetch;
    this.structuredOutputMode = structuredOutputMode;
  }

  async complete(
    request: ChatRequest,
    _context: RequestContext,
    options?: ProviderCompletionOptions,
  ): Promise<ChatResponse> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.apiKey) {
      headers.set("authorization", `Bearer ${this.apiKey}`);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(
          toProviderRequest(request, options, this.structuredOutputMode),
        ),
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
