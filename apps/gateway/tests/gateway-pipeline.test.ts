import { describe, expect, test } from "bun:test";
import type { ChatInput } from "../src/domain/chat.ts";
import { GatewayError } from "../src/domain/errors.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import type { LifecycleEvent } from "../src/pipeline/lifecycle.ts";
import { FakeProvider, sampleChatResponse } from "./helpers/fake-provider.ts";

const invalidInputs: Array<[name: string, input: ChatInput]> = [
  ["missing messages", {} as ChatInput],
  ["empty messages", { messages: [] }],
  [
    "an unsupported role",
    {
      messages: [{ role: "tool", content: "Hello" }],
    } as unknown as ChatInput,
  ],
  ["empty content", { messages: [{ role: "user", content: "   " }] }],
  [
    "an empty explicit model",
    { model: "   ", messages: [{ role: "user", content: "Hello" }] },
  ],
  [
    "a negative temperature",
    { messages: [{ role: "user", content: "Hello" }], temperature: -1 },
  ],
  [
    "an excessive temperature",
    { messages: [{ role: "user", content: "Hello" }], temperature: 3 },
  ],
  [
    "a non-finite temperature",
    { messages: [{ role: "user", content: "Hello" }], temperature: Infinity },
  ],
  [
    "zero max tokens",
    { messages: [{ role: "user", content: "Hello" }], maxTokens: 0 },
  ],
  [
    "fractional max tokens",
    { messages: [{ role: "user", content: "Hello" }], maxTokens: 1.5 },
  ],
];

describe("GatewayPipeline", () => {
  test("forwards a normalized request once and records the successful lifecycle", async () => {
    const provider = new FakeProvider();
    const events: LifecycleEvent[] = [];
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
      logger: silentLogger,
      lifecycleListener: (event) => events.push(event),
    });
    const input: ChatInput = {
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      temperature: 0.4,
      maxTokens: 100,
    };

    const result = await pipeline.execute(input, {
      requestId: "request-test-1",
    });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.request).toEqual({
      model: "default-model",
      messages: input.messages,
      temperature: 0.4,
      maxTokens: 100,
    });
    expect(provider.calls[0]?.context.requestId).toBe("request-test-1");
    expect(result.response).toEqual(sampleChatResponse);
    expect(events.map((event) => event.stage)).toEqual([
      "received",
      "validated",
      "provider_started",
      "provider_completed",
      "completed",
    ]);
  });

  test("uses an explicitly requested model and does not mutate the input", async () => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
    });
    const input: ChatInput = {
      model: "requested-model",
      messages: [{ role: "user", content: "Do not change me" }],
    };
    const original = structuredClone(input);

    await pipeline.execute(input);

    expect(provider.calls[0]?.request.model).toBe("requested-model");
    expect(input).toEqual(original);
    expect(provider.calls[0]?.request).not.toBe(input);
    expect(provider.calls[0]?.request.messages).not.toBe(input.messages);
  });

  test("generates a valid request ID when one is not supplied", async () => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
    });

    const result = await pipeline.execute({
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.context.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test("rejects streaming without calling the provider", async () => {
    const provider = new FakeProvider();
    const events: LifecycleEvent[] = [];
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
      lifecycleListener: (event) => events.push(event),
    });

    try {
      await pipeline.execute({
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      });
      throw new Error("Expected pipeline execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("UNSUPPORTED_FEATURE");
    }

    expect(provider.calls).toHaveLength(0);
    expect(events.map((event) => event.stage)).toEqual(["received", "failed"]);
    expect(events[1]?.failedAt).toBe("received");
  });

  test("normalizes unexpected provider failures and records failure once", async () => {
    const provider = new FakeProvider(sampleChatResponse, new Error("secret"));
    const events: LifecycleEvent[] = [];
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
      lifecycleListener: (event) => events.push(event),
    });

    try {
      await pipeline.execute({
        messages: [{ role: "user", content: "Hello" }],
      });
      throw new Error("Expected pipeline execution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe("INTERNAL_ERROR");
      expect((error as Error).message).not.toContain("secret");
    }

    expect(events.map((event) => event.stage)).toEqual([
      "received",
      "validated",
      "provider_started",
      "failed",
    ]);
    expect(events[3]?.failedAt).toBe("provider_started");
  });

  test.each(invalidInputs)("rejects %s", async (_name, input) => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "default-model",
    });

    await expect(pipeline.execute(input)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
    expect(provider.calls).toHaveLength(0);
  });
});
