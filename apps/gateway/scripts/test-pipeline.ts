import { strict as assert } from "node:assert";
import type { ChatRequest, ChatResponse } from "../src/domain/chat.ts";
import type { RequestContext } from "../src/domain/request-context.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import type { LifecycleEvent } from "../src/pipeline/lifecycle.ts";
import type { ModelProvider } from "../src/providers/model-provider.ts";

class DeterministicProvider implements ModelProvider {
  request?: ChatRequest;

  async complete(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<ChatResponse> {
    this.request = request;

    return {
      id: "chatcmpl-pipeline-check",
      created: Math.floor(Date.now() / 1_000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The gateway pipeline is working.",
          },
          finishReason: "stop",
        },
      ],
      usage: {
        promptTokens: 5,
        completionTokens: 6,
        totalTokens: 11,
      },
    };
  }
}

const provider = new DeterministicProvider();
const lifecycle: LifecycleEvent[] = [];
const pipeline = new GatewayPipeline({
  provider,
  defaultModel: "pipeline-test-model",
  logger: silentLogger,
  lifecycleListener: (event) => lifecycle.push(event),
});

const result = await pipeline.execute(
  {
    messages: [
      { role: "system", content: "Reply deterministically." },
      { role: "user", content: "Check the gateway pipeline." },
    ],
    temperature: 0,
    maxTokens: 32,
  },
  { requestId: "pipeline-script-check" },
);

assert.equal(provider.request?.model, "pipeline-test-model");
assert.deepEqual(provider.request?.messages, [
  { role: "system", content: "Reply deterministically." },
  { role: "user", content: "Check the gateway pipeline." },
]);
assert.equal(
  result.response.choices[0]?.message.content,
  "The gateway pipeline is working.",
);
assert.deepEqual(
  lifecycle.map((event) => event.stage),
  [
    "received",
    "validated",
    "provider_started",
    "provider_completed",
    "completed",
  ],
);

console.info(
  JSON.stringify(
    {
      status: "ok",
      requestId: result.context.requestId,
      model: provider.request.model,
      lifecycle: lifecycle.map((event) => event.stage),
      response: result.response.choices[0]?.message.content,
    },
    null,
    2,
  ),
);
