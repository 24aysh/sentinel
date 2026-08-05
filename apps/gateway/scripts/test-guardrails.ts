import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { ChatRequest, ChatResponse } from "../src/domain/chat.ts";
import type { RequestContext } from "../src/domain/request-context.ts";
import { loadGuardrailPolicy } from "../src/guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import type { LifecycleEvent } from "../src/pipeline/lifecycle.ts";
import type { ModelProvider } from "../src/providers/model-provider.ts";

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
                  message: "The guardrail pipeline is working.",
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
const policy = await loadGuardrailPolicy(policyPath);
const provider = new DeterministicGuardrailProvider();
const lifecycle: LifecycleEvent[] = [];
const pipeline = new GatewayPipeline({
  provider,
  defaultModel: "guardrail-test-model",
  guardrails: new ConfiguredGuardrailHub(policy),
  logger: silentLogger,
  lifecycleListener: (event) => lifecycle.push(event),
});

const result = await pipeline.execute(
  {
    messages: [
      {
        role: "user",
        content: `Return a gateway status response for ${rawEmail}.`,
      },
    ],
    temperature: 0,
  },
  { requestId: "guardrail-pipeline-check" },
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
  message: "The guardrail pipeline is working.",
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
