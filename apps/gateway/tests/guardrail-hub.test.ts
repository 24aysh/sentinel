import { describe, expect, test } from "bun:test";
import type { ChatRequest, ChatResponse } from "../src/domain/chat.ts";
import type { RequestContext } from "../src/domain/request-context.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { createTestPolicy } from "./helpers/guardrail-policy.ts";

const context: RequestContext = {
  requestId: "guardrail-hub-test",
  model: "test-model",
  startedAt: 0,
};

function request(content: string, role: "system" | "user" = "user") {
  return {
    model: "test-model",
    messages: [{ role, content }],
  } satisfies ChatRequest;
}

function response(content: string): ChatResponse {
  return {
    id: "chatcmpl-guardrail",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finishReason: "stop",
      },
    ],
  };
}

describe("ConfiguredGuardrailHub input evaluation", () => {
  test("redacts all supported findings without mutating the request", async () => {
    const policy = createTestPolicy({
      input: [
        {
          id: "redact-pii",
          entities: ["EMAIL", "PHONE_NUMBER", "CREDIT_CARD"],
          action: { type: "redact" },
        },
      ],
    });
    const hub = new ConfiguredGuardrailHub(policy);
    const original = request(
      "Use test@example.com, +1 415-555-2671, and 4111 1111 1111 1111.",
    );
    const snapshot = structuredClone(original);

    const result = await hub.evaluateInput(original, context);

    expect(result.decision).toBe("redact");
    if (result.decision === "redact") {
      expect(result.request.messages[0]?.content).toBe(
        "Use <EMAIL>, <PHONE_NUMBER>, and <CREDIT_CARD>.",
      );
      expect(result.findingCount).toBe(3);
    }
    expect(original).toEqual(snapshot);
  });

  test("uses first-match rules for allow exceptions", async () => {
    const policy = createTestPolicy({
      input: [
        {
          id: "allow-system-email",
          entities: ["EMAIL"],
          roles: ["system"],
          action: { type: "allow" },
        },
        {
          id: "block-email",
          entities: ["EMAIL"],
          action: { type: "block" },
        },
      ],
    });
    const hub = new ConfiguredGuardrailHub(policy);

    expect(
      (await hub.evaluateInput(request("admin@example.com", "system"), context))
        .decision,
    ).toBe("allow");
    expect(
      (await hub.evaluateInput(request("admin@example.com"), context)).decision,
    ).toBe("block");
  });

  test("resolves any blocking finding before redactions", async () => {
    const policy = createTestPolicy({
      input: [
        {
          id: "redact-email",
          entities: ["EMAIL"],
          action: { type: "redact", replacement: "[redacted]" },
        },
        {
          id: "block-card",
          entities: ["CREDIT_CARD"],
          action: { type: "block" },
        },
      ],
    });
    const result = await new ConfiguredGuardrailHub(policy).evaluateInput(
      request("test@example.com 4111 1111 1111 1111"),
      context,
    );

    expect(result).toMatchObject({
      decision: "block",
      findingCount: 2,
      ruleIds: ["redact-email", "block-card"],
    });
  });
});

describe("ConfiguredGuardrailHub output evaluation", () => {
  const schema = {
    type: "object",
    properties: { status: { const: "ok" } },
    required: ["status"],
    additionalProperties: false,
  };

  test("allows strict JSON that satisfies the schema", async () => {
    const hub = new ConfiguredGuardrailHub(
      createTestPolicy({ output: { schema, onFailure: { type: "block" } } }),
    );

    expect(
      await hub.evaluateOutput(
        request("check"),
        response('{"status":"ok"}'),
        context,
        1,
      ),
    ).toEqual({ decision: "allow" });
  });

  test("rejects fenced JSON and creates one repair request", async () => {
    const hub = new ConfiguredGuardrailHub(
      createTestPolicy({
        output: {
          schema,
          onFailure: { type: "retry", maximumRetries: 1 },
        },
      }),
    );
    const original = request("check");

    const first = await hub.evaluateOutput(
      original,
      response('```json\n{"status":"ok"}\n```'),
      context,
      1,
    );

    expect(first.decision).toBe("retry");
    if (first.decision === "retry") {
      expect(first.repairRequest.messages).toHaveLength(3);
      expect(first.repairRequest.messages.at(-1)?.content).toContain(
        "JSON Schema",
      );
      expect(original.messages).toHaveLength(1);

      expect(
        await hub.evaluateOutput(
          first.repairRequest,
          response("still invalid"),
          context,
          2,
        ),
      ).toEqual({ decision: "block", ruleId: "test-output" });
    }
  });

  test("validates every returned choice", async () => {
    const hub = new ConfiguredGuardrailHub(
      createTestPolicy({ output: { schema, onFailure: { type: "block" } } }),
    );
    const multiple = response('{"status":"ok"}');
    multiple.choices.push({
      index: 1,
      message: { role: "assistant", content: '{"status":"bad"}' },
      finishReason: "stop",
    });

    expect(
      await hub.evaluateOutput(request("check"), multiple, context, 1),
    ).toEqual({ decision: "block", ruleId: "test-output" });
  });
});
