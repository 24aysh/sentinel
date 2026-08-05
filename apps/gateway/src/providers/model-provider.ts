import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";

export interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse>;
}
