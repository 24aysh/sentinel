import { describe, expect, test } from "bun:test";
import type { ChatResponse } from "../src/domain/chat.ts";
import {
  evaluateOutputChoices,
  MAX_OUTPUT_CONTENT_LENGTH,
  OVERSIZED_OUTPUT_REPAIR_MARKER,
} from "../src/guardrails/output/output-evaluator.ts";

function response(...contents: string[]): ChatResponse {
  return {
    id: "output-evaluator",
    created: 1,
    model: "test-model",
    choices: contents.map((content, index) => ({
      index,
      message: { role: "assistant", content },
      finishReason: "stop",
    })),
  };
}

const validator = {
  validate(value: unknown) {
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { status?: unknown }).status === "ok"
    );
  },
};

describe("evaluateOutputChoices", () => {
  test("allows every conforming JSON object choice", () => {
    expect(
      evaluateOutputChoices(
        response('{"status":"ok"}', '  {"status":"ok"}\n'),
        validator,
      ),
    ).toEqual({ valid: true });
  });

  test.each([
    ["not-json", "invalid_json"],
    ["[1,2]", "non_object"],
    ["null", "non_object"],
    ['{"status":"bad"}', "schema_mismatch"],
  ] as const)("classifies %s as %s", (content, violationType) => {
    expect(evaluateOutputChoices(response(content), validator)).toEqual({
      valid: false,
      invalidContent: content,
      violationType,
    });
  });

  test("omits oversized content from the repair value", () => {
    expect(
      evaluateOutputChoices(
        response("x".repeat(MAX_OUTPUT_CONTENT_LENGTH + 1)),
        validator,
      ),
    ).toEqual({
      valid: false,
      invalidContent: OVERSIZED_OUTPUT_REPAIR_MARKER,
      violationType: "output_too_large",
    });
  });

  test("uses the first invalid choice deterministically", () => {
    expect(
      evaluateOutputChoices(
        response('{"status":"ok"}', "bad", "null"),
        validator,
      ),
    ).toMatchObject({ violationType: "invalid_json" });
  });

  test("propagates an unexpected validator failure", () => {
    expect(() =>
      evaluateOutputChoices(response('{"status":"ok"}'), {
        validate() {
          throw new Error("validator failure");
        },
      }),
    ).toThrow("validator failure");
  });
});
