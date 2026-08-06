import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import {
  ModelGateway,
  type ChatRequest,
  type ChatResponse,
  type LifecycleEvent,
  type ModelProvider,
  type RequestContext,
} from "../src/index.ts";

const rawEmail = "pipeline.check@example.com";

class DeterministicGuardrailProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];

  async complete(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const isRetry = this.requests.length === 2;

    return {
      id: `chatcmpl-guardrail-${this.requests.length}`,
      created: Math.floor(Date.now() / 1_000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: isRetry
              ? JSON.stringify({
                  status: "ok",
                  message: "The guardrail SDK is working.",
                  contact: "<EMAIL>",
                })
              : "This response is not JSON.",
          },
          finishReason: "stop",
        },
      ],
      usage: {
        promptTokens: 5,
        completionTokens: 4,
        totalTokens: 9,
      },
    };
  }
}

const policyPath = resolve(import.meta.dir, "../policies/example-policy.yaml");
const provider = new DeterministicGuardrailProvider();
const lifecycle: LifecycleEvent[] = [];
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "guardrail-test-model",
  policyPath,
  lifecycleListener: (event) => lifecycle.push(event),
});

const result = await gateway.chat.completions.create(
  {
    messages: [
      {
        role: "user",
        content: `Return a gateway status response for ${rawEmail}.`,
      },
    ],
    temperature: 0,
  },
  { requestId: "guardrail-sdk-check" },
);

assert.equal(provider.requests.length, 2);
assert.equal(
  provider.requests[0]?.messages[0]?.content.includes(rawEmail),
  false,
);
assert.equal(
  provider.requests[0]?.messages[0]?.content.includes("<EMAIL>"),
  true,
);
assert.equal(provider.requests[1]?.messages.at(-2)?.role, "assistant");
assert.equal(provider.requests[1]?.messages.at(-1)?.role, "user");
assert.deepEqual(result.response.usage, {
  promptTokens: 10,
  completionTokens: 8,
  totalTokens: 18,
});

const parsed = JSON.parse(
  result.response.choices[0]?.message.content ?? "null",
) as { status?: string; contact?: string };
assert.deepEqual(parsed, {
  status: "ok",
  message: "The guardrail SDK is working.",
  contact: "<EMAIL>",
});

console.info(
  JSON.stringify(
    {
      status: "ok",
      requestId: result.context.requestId,
      providerCalls: provider.requests.length,
      redactedInput: provider.requests[0]?.messages[0]?.content,
      lifecycle: lifecycle.map((event) => event.stage),
      response: parsed,
    },
    null,
    2,
  ),
);
