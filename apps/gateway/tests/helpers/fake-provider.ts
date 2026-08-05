import type { ChatRequest, ChatResponse } from "../../src/domain/chat.ts";
import type { RequestContext } from "../../src/domain/request-context.ts";
import type { ModelProvider } from "../../src/providers/model-provider.ts";

export const sampleChatResponse: ChatResponse = {
  id: "chatcmpl-test",
  created: 1_785_900_000,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Test response" },
      finishReason: "stop",
    },
  ],
  usage: {
    promptTokens: 4,
    completionTokens: 2,
    totalTokens: 6,
  },
};

export class FakeProvider implements ModelProvider {
  readonly calls: Array<{
    request: ChatRequest;
    context: RequestContext;
  }> = [];

  constructor(
    private readonly result: ChatResponse = sampleChatResponse,
    private readonly failure?: unknown,
  ) {}

  async complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse> {
    this.calls.push({ request, context });

    if (this.failure !== undefined) {
      throw this.failure;
    }

    return structuredClone(this.result);
  }
}
