export const CHAT_ROLES = ["system", "user", "assistant", "tool"] as const;

export type ChatRole = (typeof CHAT_ROLES)[number];

export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
    strict: true;
  };
}

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export interface TextChatMessage {
  role: "system" | "user";
  content: string;
}

export interface AssistantChatMessage {
  role: "assistant";
  content: string | null;
  toolCalls?: FunctionToolCall[];
}

export interface ToolChatMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type ChatMessage =
  TextChatMessage | AssistantChatMessage | ToolChatMessage;

interface ChatParameters {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: FunctionToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
}

export interface ChatInput extends ChatParameters {
  model?: string;
  stream?: boolean;
}

export interface ChatRequest extends ChatParameters {
  model: string;
}

export interface ChatResponse {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: AssistantChatMessage;
    finishReason: string | null;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}
