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
