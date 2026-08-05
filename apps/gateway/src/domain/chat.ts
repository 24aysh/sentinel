export const CHAT_ROLES = ["system", "user", "assistant"] as const;

export type ChatRole = (typeof CHAT_ROLES)[number];

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatParameters {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
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
    message: { role: "assistant"; content: string };
    finishReason: string | null;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export function toPublicChatRequest(request: ChatRequest) {
  return {
    model: request.model,
    messages: request.messages,
    stream: false,
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.maxTokens !== undefined && {
      max_tokens: request.maxTokens,
    }),
  };
}

export function toPublicChatResponse(response: ChatResponse) {
  const publicResponse = {
    id: response.id,
    object: "chat.completion" as const,
    created: response.created,
    model: response.model,
    choices: response.choices.map((choice) => ({
      index: choice.index,
      message: choice.message,
      finish_reason: choice.finishReason,
    })),
    ...(response.usage && {
      usage: {
        prompt_tokens: response.usage.promptTokens,
        completion_tokens: response.usage.completionTokens,
        total_tokens: response.usage.totalTokens,
      },
    }),
  };
  return publicResponse;
}
