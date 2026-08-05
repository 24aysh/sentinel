import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { GatewayError } from "../src/domain/errors.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";

function setup(failure?: unknown) {
  const provider = new FakeProvider(undefined, failure);
  const pipeline = new GatewayPipeline({
    provider,
    defaultModel: "default-model",
    logger: silentLogger,
  });
  const app = createApp({ pipeline, logger: silentLogger });
  return { app, provider };
}

function chatRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("gateway HTTP application", () => {
  test("returns health without calling the provider", async () => {
    const { app, provider } = setup();

    const response = await app.handle(
      new Request("http://gateway.test/health"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      service: "llm-gateway",
      version: "0.1.0",
    });
    expect(provider.calls).toHaveLength(0);
  });

  test("runs a valid request through the pipeline", async () => {
    const { app, provider } = setup();

    const response = await app.handle(
      chatRequest(
        {
          messages: [{ role: "user", content: "Hello" }],
          temperature: 0.5,
          max_tokens: 64,
          stream: false,
        },
        { "x-request-id": "caller-request-1" },
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("caller-request-1");
    expect(response.headers.get("x-gateway-duration-ms")).toMatch(/^\d+$/);
    expect(body).toMatchObject({
      id: "chatcmpl-test",
      object: "chat.completion",
      model: "test-model",
      choices: [
        {
          message: { role: "assistant", content: "Test response" },
          finish_reason: "stop",
        },
      ],
    });
    expect(provider.calls[0]?.request).toMatchObject({
      model: "default-model",
      temperature: 0.5,
      maxTokens: 64,
    });
  });

  test("does not expose provider requests when server debugging is disabled", async () => {
    const { app } = setup();

    const response = await app.handle(
      chatRequest(
        { messages: [{ role: "user", content: "Hello" }] },
        { "x-gateway-debug-provider-request": "true" },
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.gateway_debug).toBeUndefined();
  });

  test.each([
    [{}, "INVALID_REQUEST"],
    [{ messages: [] }, "INVALID_REQUEST"],
    [{ messages: [{ role: "tool", content: "Hello" }] }, "INVALID_REQUEST"],
    [{ messages: [{ role: "user", content: "" }] }, "INVALID_REQUEST"],
    [
      { messages: [{ role: "user", content: "Hello" }], unknown: true },
      "INVALID_REQUEST",
    ],
  ])("rejects an invalid request body", async (body, expectedCode) => {
    const { app, provider } = setup();

    const response = await app.handle(chatRequest(body));
    const responseBody = await response.json();

    expect(response.status).toBe(400);
    expect(responseBody).toMatchObject({
      error: { code: expectedCode },
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("x-gateway-duration-ms")).toMatch(/^\d+$/);
    expect(provider.calls).toHaveLength(0);
  });

  test("rejects malformed JSON with the public error contract", async () => {
    const { app, provider } = setup();
    const response = await app.handle(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
        message: "Request body must be valid JSON.",
      },
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(provider.calls).toHaveLength(0);
  });

  test("rejects streaming explicitly", async () => {
    const { app, provider } = setup();

    const response = await app.handle(
      chatRequest({
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "UNSUPPORTED_FEATURE" },
    });
    expect(provider.calls).toHaveLength(0);
  });

  test("returns the documented timeout response", async () => {
    const { app } = setup(
      new GatewayError(
        "MODEL_TIMEOUT",
        "The model provider did not respond before the timeout.",
        504,
      ),
    );

    const response = await app.handle(
      chatRequest({ messages: [{ role: "user", content: "Hello" }] }),
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: {
        code: "MODEL_TIMEOUT",
        message: "The model provider did not respond before the timeout.",
      },
    });
  });

  test("sanitizes unexpected provider errors", async () => {
    const { app } = setup(new Error("private provider details"));

    const response = await app.handle(
      chatRequest({ messages: [{ role: "user", content: "Hello" }] }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain("private provider details");
  });
});
