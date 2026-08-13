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
const rawIp = "192.0.2.10";
const rawApiKey = "Q7vN2xL9mR4pT8kW6cY3zF1h";
const rawDatabase = "postgresql://user:pass@db.example.test:5432/app";

class DeterministicGuardrailProvider implements ModelProvider {
  readonly requests: ChatRequest[] = [];

  async complete(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));

    return {
      id: `chatcmpl-guardrail-${this.requests.length}`,
      created: Math.floor(Date.now() / 1_000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "The guardrail SDK is working.",
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

const policyPath = resolve(import.meta.dir, "../policies/pii-policy.yaml");
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
        content: `Check ${rawEmail}, ${rawIp}, api_key=${rawApiKey}, and ${rawDatabase}.`,
      },
    ],
    temperature: 0,
  },
  { requestId: "guardrail-sdk-check" },
);

assert.equal(provider.requests.length, 1);
const redactedInput = provider.requests[0]?.messages[0]?.content ?? "";
for (const raw of [rawEmail, rawIp, rawApiKey, rawDatabase]) {
  assert.equal(redactedInput.includes(raw), false);
}
for (const entity of [
  "EMAIL",
  "IP_ADDRESS",
  "API_KEY",
  "DATABASE_CONNECTION_STRING",
]) {
  assert.equal(redactedInput.includes(`<${entity}>`), true);
}
assert.deepEqual(result.response.usage, {
  promptTokens: 5,
  completionTokens: 4,
  totalTokens: 9,
});

console.info(
  JSON.stringify(
    {
      status: "ok",
      requestId: result.context.requestId,
      providerCalls: provider.requests.length,
      redactedInput,
      lifecycle: lifecycle.map((event) => event.stage),
      response: result.response.choices[0]?.message.content,
    },
    null,
    2,
  ),
);
