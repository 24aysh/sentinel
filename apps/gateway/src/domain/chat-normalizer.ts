import type {
  AssistantChatMessage,
  ChatInput,
  ChatMessage,
  ChatRequest,
  FunctionToolCall,
  FunctionToolDefinition,
  ToolChoice,
} from "./chat.ts";
import { GatewayError } from "./errors.ts";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOLS = 128;
const MAX_DESCRIPTION_LENGTH = 1_024;
const MAX_TOOL_CALL_ID_LENGTH = 256;
const MAX_ARGUMENT_LENGTH = 1_000_000;

type UnknownRecord = Record<string, unknown>;

function invalidRequest(message: string): never {
  throw new GatewayError("INVALID_REQUEST", message, 400);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalidRequest(message);
  }
  return value;
}

function toolName(value: unknown): string {
  if (typeof value !== "string" || !TOOL_NAME_PATTERN.test(value)) {
    invalidRequest(
      "Tool names must contain 1 through 64 letters, digits, underscores, or hyphens.",
    );
  }
  return value;
}

function normalizeToolCall(value: unknown): FunctionToolCall {
  if (!isRecord(value) || value.type !== "function") {
    invalidRequest("Every tool call must use type function.");
  }
  const callable = value.function;
  if (!isRecord(callable)) {
    invalidRequest("Every tool call must contain a function object.");
  }
  const id = nonEmptyText(value.id, "Every tool call must contain an ID.");
  if (id.length > MAX_TOOL_CALL_ID_LENGTH) {
    invalidRequest("Tool call IDs must not exceed 256 characters.");
  }
  if (
    typeof callable.arguments !== "string" ||
    callable.arguments.length > MAX_ARGUMENT_LENGTH
  ) {
    invalidRequest("Tool call arguments must be a bounded JSON string.");
  }
  return {
    id,
    type: "function",
    function: {
      name: toolName(callable.name),
      arguments: callable.arguments,
    },
  };
}

function normalizeToolDefinition(value: unknown): FunctionToolDefinition {
  if (!isRecord(value) || value.type !== "function") {
    invalidRequest("Every tool definition must use type function.");
  }
  const callable = value.function;
  if (!isRecord(callable)) {
    invalidRequest("Every tool definition must contain a function object.");
  }
  if (callable.strict !== true) {
    invalidRequest("Every tool definition must enable strict mode.");
  }
  if (!isRecord(callable.parameters)) {
    invalidRequest("Every tool definition must contain an object schema.");
  }
  if (
    callable.description !== undefined &&
    (typeof callable.description !== "string" ||
      callable.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    invalidRequest("Tool descriptions must not exceed 1024 characters.");
  }
  let parameters: unknown;
  try {
    parameters = structuredClone(callable.parameters);
  } catch {
    invalidRequest("Tool schemas must contain cloneable JSON values.");
  }
  return {
    type: "function",
    function: {
      name: toolName(callable.name),
      ...(callable.description !== undefined && {
        description: callable.description,
      }),
      parameters,
      strict: true,
    },
  };
}

function normalizeTools(value: unknown): FunctionToolDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOLS) {
    invalidRequest("tools must contain 1 through 128 function definitions.");
  }
  const tools = value.map(normalizeToolDefinition);
  const names = tools.map(({ function: callable }) => callable.name);
  if (new Set(names).size !== names.length) {
    invalidRequest("Tool names must be unique.");
  }
  return tools;
}

function normalizeToolChoice(value: unknown): ToolChoice | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }
  if (
    !isRecord(value) ||
    value.type !== "function" ||
    !isRecord(value.function)
  ) {
    invalidRequest("toolChoice contains an unsupported value.");
  }
  return {
    type: "function",
    function: { name: toolName(value.function.name) },
  };
}

function normalizeAssistantMessage(value: UnknownRecord): AssistantChatMessage {
  const calls = value.toolCalls;
  const toolCalls =
    calls === undefined
      ? undefined
      : Array.isArray(calls) && calls.length > 0
        ? calls.map(normalizeToolCall)
        : invalidRequest("assistant toolCalls must contain at least one call.");
  if (value.content !== null && typeof value.content !== "string") {
    invalidRequest("Assistant content must be text or null.");
  }
  if (
    (value.content === null || value.content.trim().length === 0) &&
    !toolCalls
  ) {
    invalidRequest("Assistant messages must contain text or tool calls.");
  }
  if (toolCalls) {
    const ids = toolCalls.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      invalidRequest("Assistant tool call IDs must be unique.");
    }
  }
  return {
    role: "assistant",
    content: value.content,
    ...(toolCalls && { toolCalls }),
  };
}

function normalizeMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) invalidRequest("Every message must be an object.");
  if (value.role === "system" || value.role === "user") {
    return {
      role: value.role,
      content: nonEmptyText(
        value.content,
        "System and user messages must contain non-empty text content.",
      ),
    };
  }
  if (value.role === "assistant") return normalizeAssistantMessage(value);
  if (value.role === "tool") {
    if (typeof value.content !== "string") {
      invalidRequest("Tool messages must contain string content.");
    }
    const toolCallId = nonEmptyText(
      value.toolCallId,
      "Tool messages must contain a toolCallId.",
    );
    if (toolCallId.length > MAX_TOOL_CALL_ID_LENGTH) {
      invalidRequest("Tool call IDs must not exceed 256 characters.");
    }
    return { role: "tool", toolCallId, content: value.content };
  }
  invalidRequest("Every message must use a supported role.");
}

function validateToolHistory(
  messages: readonly ChatMessage[],
  toolNames: ReadonlySet<string>,
): void {
  const pending = new Set<string>();
  const seenCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId)) {
        invalidRequest("Tool messages must reference a pending tool call.");
      }
      continue;
    }
    if (pending.size > 0) {
      invalidRequest("Every assistant tool call must have one tool result.");
    }
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (seenCallIds.has(call.id)) {
        invalidRequest("Tool call IDs must be unique across message history.");
      }
      if (!toolNames.has(call.function.name)) {
        invalidRequest("Historical tool calls must reference a supplied tool.");
      }
      seenCallIds.add(call.id);
      pending.add(call.id);
    }
  }
  if (pending.size > 0) {
    invalidRequest("Every assistant tool call must have one tool result.");
  }
}

export function normalizeChatInput(
  input: ChatInput,
  defaultModel: string,
): ChatRequest {
  if (input.stream === true) {
    throw new GatewayError(
      "UNSUPPORTED_FEATURE",
      "Streaming responses are not supported by this gateway version.",
      400,
    );
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    invalidRequest("messages must contain at least one item.");
  }
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || input.model.trim().length === 0)
  ) {
    invalidRequest("model must be a non-empty string when provided.");
  }
  if (
    input.temperature !== undefined &&
    (typeof input.temperature !== "number" ||
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 2)
  ) {
    invalidRequest("temperature must be a number from 0 through 2.");
  }
  if (
    input.maxTokens !== undefined &&
    (!Number.isInteger(input.maxTokens) || input.maxTokens <= 0)
  ) {
    invalidRequest("max_tokens must be a positive integer.");
  }

  const tools = normalizeTools(input.tools);
  const toolChoice = normalizeToolChoice(input.toolChoice);
  if (
    toolChoice !== undefined &&
    toolChoice !== "none" &&
    (!tools || tools.length === 0)
  ) {
    invalidRequest("toolChoice requires at least one tool definition.");
  }
  if (
    typeof toolChoice === "object" &&
    !tools?.some(
      ({ function: callable }) => callable.name === toolChoice.function.name,
    )
  ) {
    invalidRequest("A forced toolChoice must reference a supplied tool.");
  }
  if (
    input.parallelToolCalls !== undefined &&
    typeof input.parallelToolCalls !== "boolean"
  ) {
    invalidRequest("parallelToolCalls must be a boolean.");
  }
  if (input.parallelToolCalls !== undefined && !tools) {
    invalidRequest("parallelToolCalls requires at least one tool definition.");
  }

  const messages = input.messages.map(normalizeMessage);
  validateToolHistory(
    messages,
    new Set(tools?.map(({ function: callable }) => callable.name) ?? []),
  );

  return {
    model: input.model?.trim() || defaultModel,
    messages,
    ...(input.temperature !== undefined && { temperature: input.temperature }),
    ...(input.maxTokens !== undefined && { maxTokens: input.maxTokens }),
    ...(tools && { tools }),
    ...(toolChoice !== undefined && { toolChoice }),
    ...(input.parallelToolCalls !== undefined && {
      parallelToolCalls: input.parallelToolCalls,
    }),
  };
}
