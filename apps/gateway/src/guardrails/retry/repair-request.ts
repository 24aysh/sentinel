import type { ChatRequest } from "../../domain/chat.ts";

const DEFAULT_REPAIR_PROMPT =
  "Correct the previous response so it satisfies the JSON Schema.";

export function createRepairRequest(
  request: ChatRequest,
  invalidContent: string,
  schema: unknown,
  configuredPrompt?: string,
): ChatRequest {
  const instruction = configuredPrompt ?? DEFAULT_REPAIR_PROMPT;
  const repairContent = `${instruction}\n\nJSON Schema:\n${JSON.stringify(schema)}\n\nReturn only the corrected JSON value without Markdown or commentary.`;

  return {
    ...request,
    messages: [
      ...request.messages.map((message) => ({ ...message })),
      { role: "assistant", content: invalidContent },
      { role: "user", content: repairContent },
    ],
  };
}
