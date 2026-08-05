import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";
import { createTestPolicy } from "./helpers/guardrail-policy.ts";

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://gateway.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Contact test@example.com" }],
    }),
  });
}

describe("guardrail HTTP errors", () => {
  test("returns the sanitized input block contract", async () => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          input: [
            {
              id: "private-rule-id",
              entities: ["EMAIL"],
              action: { type: "block" },
            },
          ],
        }),
      ),
      logger: silentLogger,
    });
    const app = createApp({ pipeline, logger: silentLogger });

    const response = await app.handle(request());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "INPUT_GUARDRAIL_BLOCKED",
        message: "The request was blocked by an input guardrail.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("test@example.com");
    expect(JSON.stringify(body)).not.toContain("private-rule-id");
    expect(provider.calls).toHaveLength(0);
  });

  test("returns the sanitized invalid-output contract", async () => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          output: {
            schema: { type: "object" },
            onFailure: { type: "block" },
          },
        }),
      ),
      logger: silentLogger,
    });
    const app = createApp({ pipeline, logger: silentLogger });

    const response = await app.handle(request());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: {
        code: "OUTPUT_GUARDRAIL_FAILED",
        message: "The model response did not satisfy the output policy.",
      },
    });
    expect(provider.calls).toHaveLength(1);
  });

  test("exposes the redacted provider request only for explicit debug requests", async () => {
    const provider = new FakeProvider();
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          input: [
            {
              id: "redact-email",
              entities: ["EMAIL"],
              action: { type: "redact" },
            },
          ],
        }),
      ),
      logger: silentLogger,
    });
    const app = createApp({
      pipeline,
      logger: silentLogger,
      exposeProviderRequest: true,
    });

    const normalResponse = await app.handle(request());
    const normalBody = (await normalResponse.json()) as Record<string, unknown>;
    expect(normalBody.gateway_debug).toBeUndefined();

    const debugResponse = await app.handle(
      request({ "x-gateway-debug-provider-request": "true" }),
    );
    const debugBody = (await debugResponse.json()) as {
      gateway_debug?: {
        provider_request?: {
          messages?: Array<{ content?: string }>;
          stream?: boolean;
        };
      };
    };

    expect(
      debugBody.gateway_debug?.provider_request?.messages?.[0]?.content,
    ).toBe("Contact <EMAIL>");
    expect(debugBody.gateway_debug?.provider_request?.stream).toBe(false);
  });
});
