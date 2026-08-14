import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "../src/domain/chat.ts";
import { GatewayError } from "../src/domain/errors.ts";
import type { RequestContext } from "../src/domain/request-context.ts";
import {
  OpenAICompatibleProvider,
  type FetchImplementation,
} from "../src/providers/openai-compatible-provider.ts";

const request: ChatRequest = {
  model: "provider-model",
  messages: [{ role: "user", content: "Hello" }],
  temperature: 0.25,
  maxTokens: 80,
};

const context: RequestContext = {
  requestId: "provider-test",
  startedAt: 0,
  model: request.model,
};

const validProviderBody = {
  id: "chatcmpl-provider",
  created: 1_785_900_000,
  model: "provider-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hi" },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
  },
};

function createProvider(
  fetchImplementation: FetchImplementation,
  apiKey?: string,
  structuredOutputMode?: "json_schema" | "disabled",
) {
  return new OpenAICompatibleProvider({
    baseUrl: "https://models.example.test/v1/",
    apiKey,
    timeoutMs: 5_000,
    fetch: fetchImplementation,
    structuredOutputMode,
  });
}

describe("OpenAICompatibleProvider", () => {
  test("rejects an unsupported structured output mode", () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: "https://models.example.test/v1",
          timeoutMs: 5_000,
          structuredOutputMode: "automatic" as "json_schema",
        }),
    ).toThrow("structuredOutputMode must be json_schema or disabled.");
  });

  test("maps the request, authorization, and successful response", async () => {
    let capturedInput: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const provider = createProvider(async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return Response.json(validProviderBody);
    }, "test-key");

    const response = await provider.complete(request, context);

    expect(capturedInput).toBe(
      "https://models.example.test/v1/chat/completions",
    );
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      model: "provider-model",
      messages: request.messages,
      stream: false,
      temperature: 0.25,
      max_tokens: 80,
    });
    expect(response).toEqual({
      id: validProviderBody.id,
      created: validProviderBody.created,
      model: validProviderBody.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hi" },
          finishReason: "stop",
        },
      ],
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    });
  });

  test("omits authorization when no API key is configured", async () => {
    let capturedHeaders: RequestInit["headers"];
    const provider = createProvider(async (_input, init) => {
      capturedHeaders = init?.headers;
      return Response.json(validProviderBody);
    });

    await provider.complete(request, context);

    expect(new Headers(capturedHeaders).has("authorization")).toBe(false);
  });

  test("maps a native JSON Schema output constraint", async () => {
    let capturedBody: unknown;
    const provider = createProvider(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Response.json(validProviderBody);
    });
    const schema = {
      type: "object",
      properties: { status: { type: "string" } },
      required: ["status"],
      additionalProperties: false,
    };

    await provider.complete(request, context, {
      outputJsonSchema: { name: "guardrail_output", schema, strict: true },
    });

    expect(capturedBody).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "guardrail_output", schema, strict: true },
      },
    });
  });

  test("can disable native structured output while retaining local guardrails", async () => {
    let capturedBody: Record<string, unknown> = {};
    const provider = createProvider(
      async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return Response.json(validProviderBody);
      },
      undefined,
      "disabled",
    );

    await provider.complete(request, context, {
      outputJsonSchema: {
        name: "guardrail_output",
        schema: { type: "object" },
        strict: true,
      },
    });

    expect(capturedBody.response_format).toBeUndefined();
  });

  test.each([
    [401, "MODEL_AUTHENTICATION_FAILED", 502],
    [403, "MODEL_AUTHENTICATION_FAILED", 502],
    [500, "MODEL_UPSTREAM_ERROR", 502],
    [503, "MODEL_UPSTREAM_ERROR", 502],
  ])("maps upstream status %i", async (status, code, gatewayStatus) => {
    const provider = createProvider(
      async () => new Response("failure", { status }),
    );

    try {
      await provider.complete(request, context);
      throw new Error("Expected provider call to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(code as GatewayError["code"]);
      expect((error as GatewayError).status).toBe(gatewayStatus);
    }
  });

  test("maps rate limits and preserves a safe Retry-After value", async () => {
    const provider = createProvider(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "15" },
        }),
    );

    try {
      await provider.complete(request, context);
      throw new Error("Expected provider call to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "MODEL_RATE_LIMITED",
        status: 429,
        retryAfter: "15",
      });
    }
  });

  test("rejects invalid JSON from a successful upstream response", async () => {
    const provider = createProvider(
      async () => new Response("not-json", { status: 200 }),
    );

    expect(provider.complete(request, context)).rejects.toMatchObject({
      code: "INVALID_MODEL_RESPONSE",
      status: 502,
    });
  });

  test("rejects a malformed successful response", async () => {
    const provider = createProvider(async () =>
      Response.json({ id: "missing-fields" }),
    );

    expect(provider.complete(request, context)).rejects.toMatchObject({
      code: "INVALID_MODEL_RESPONSE",
      status: 502,
    });
  });

  test("maps network errors without exposing their message", async () => {
    const provider = createProvider(async () => {
      throw new Error("private DNS information");
    });

    try {
      await provider.complete(request, context);
      throw new Error("Expected provider call to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "MODEL_UPSTREAM_ERROR",
        status: 502,
      });
      expect((error as Error).message).not.toContain("private DNS information");
    }
  });

  test("maps timeout errors", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    const provider = createProvider(async () => {
      throw timeout;
    });

    expect(provider.complete(request, context)).rejects.toMatchObject({
      code: "MODEL_TIMEOUT",
      status: 504,
    });
  });
});
