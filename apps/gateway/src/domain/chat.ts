export const CHAT_ROLES = ["system", "user", "assistant"] as const;

export type ChatRole = (typeof CHAT_ROLES)[number];

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponseMessage {
  role: "assistant";
  content: string;
}

export interface ChatResponseChoice {
  index: number;
  message: ChatResponseMessage;
  finishReason: string | null;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  id: string;
  created: number;
  model: string;
  choices: ChatResponseChoice[];
  usage?: ChatUsage;
}

export interface PublicChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatResponseMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function toPublicChatResponse(
  response: ChatResponse,
): PublicChatCompletionResponse {
  const publicResponse: PublicChatCompletionResponse = {
    id: response.id,
    object: "chat.completion",
    created: response.created,
    model: response.model,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      message: choice.message,
      finish_reason: choice.finishReason,
    })),
  };

  if (response.usage) {
    publicResponse.usage = {
      prompt_tokens: response.usage.promptTokens,
      completion_tokens: response.usage.completionTokens,
      total_tokens: response.usage.totalTokens,
    };
  }

  return publicResponse;
}
