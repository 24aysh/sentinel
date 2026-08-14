import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";

export interface JsonSchemaOutputConstraint {
  name: string;
  schema: unknown;
  strict: true;
}

export interface ProviderCompletionOptions {
  outputJsonSchema?: JsonSchemaOutputConstraint;
}

export interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
    options?: ProviderCompletionOptions,
  ): Promise<ChatResponse>;
}
