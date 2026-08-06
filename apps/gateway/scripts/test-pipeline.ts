import { strict as assert } from "node:assert";
import {
  ModelGateway,
  type ChatRequest,
  type ChatResponse,
  type LifecycleEvent,
  type ModelProvider,
  type RequestContext,
} from "../src/index.ts";

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
            content: "The gateway SDK is working.",
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
const gateway = new ModelGateway({
  provider,
  defaultModel: "sdk-test-model",
  lifecycleListener: (event) => lifecycle.push(event),
});

const result = await gateway.chat.completions.create(
  {
    messages: [
      { role: "system", content: "Reply deterministically." },
      { role: "user", content: "Check the gateway SDK." },
    ],
    temperature: 0,
    maxTokens: 32,
  },
  { requestId: "sdk-script-check" },
);

assert.equal(provider.request?.model, "sdk-test-model");
assert.deepEqual(provider.request?.messages, [
  { role: "system", content: "Reply deterministically." },
  { role: "user", content: "Check the gateway SDK." },
]);
assert.equal(
  result.response.choices[0]?.message.content,
  "The gateway SDK is working.",
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
