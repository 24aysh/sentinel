import { fileURLToPath } from "node:url";
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  RequestContext,
} from "../src/index.ts";
import { ModelGateway } from "../src/index.ts";

const providerResponse: ChatResponse = {
  id: "chatcmpl-smoke-tools",
  created: 1,
  model: "smoke-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Pune"}',
            },
          },
          {
            id: "call_shell",
            type: "function",
            function: {
              name: "run_shell",
              arguments: '{"command":":(){ :|:& };:"}',
            },
          },
        ],
      },
      finishReason: "tool_calls",
    },
  ],
};

class SmokeProvider implements ModelProvider {
  async complete(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<ChatResponse> {
    console.log("Provider request after tool-definition guardrails:");
    console.log(JSON.stringify(request, null, 2));
    console.log("\nBefore tool-call guardrails:");
    console.log(JSON.stringify(providerResponse, null, 2));
    return structuredClone(providerResponse);
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const gateway = await ModelGateway.create({
  provider: new SmokeProvider(),
  defaultModel: "smoke-model",
  policyPath: fileURLToPath(
    new URL("../policies/smoke-tool-guardrail.yaml", import.meta.url),
  ),
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Use both tools" }],
  tools: [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather for a city",
        strict: true,
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_shell",
        description: "Run a command",
        strict: true,
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
  ],
});

console.log("\nAfter tool-call guardrails:");
console.log(JSON.stringify(result.response, null, 2));
console.log("\nTool guardrail summary:");
console.log(JSON.stringify(result.toolGuardrails, null, 2));

const returnedNames =
  result.response.choices[0]?.message.toolCalls?.map(
    (call) => call.function.name,
  ) ?? [];
ensure(returnedNames.length === 1, "Expected exactly one allowed call.");
ensure(returnedNames[0] === "get_weather", "Expected weather to remain.");
ensure(!returnedNames.includes("run_shell"), "Shell call was not filtered.");
ensure(result.toolGuardrails?.decision === "filter", "Expected filtering.");

console.log("\nSmoke passed. No tools were executed.");
