import { describe, expect, test } from "bun:test";
import {
  createPromptInjectionWindows,
  PROMPT_INJECTION_MAX_TOKENS,
} from "../src/guardrails/input/prompt-injection-windowing.ts";

function message(content = "content", messageIndex = 0) {
  return { messageIndex, role: "user" as const, content };
}

function ids(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1_000);
}

describe("prompt-injection windowing", () => {
  test.each([
    [0, 1],
    [1, 1],
    [254, 1],
    [255, 2],
    [444, 2],
  ])(
    "creates the expected windows for %i content tokens",
    (count, expected) => {
      const result = createPromptInjectionWindows([message()], () =>
        ids(count),
      );
      expect(result.decision).toBe("ready");
      if (result.decision === "ready") {
        expect(result.windows).toHaveLength(expected);
        expect(
          result.windows.every(({ inputIds }) => inputIds[0] === 101),
        ).toBe(true);
        expect(
          result.windows.every(
            ({ inputIds, attentionMask }) =>
              inputIds.length === PROMPT_INJECTION_MAX_TOKENS &&
              attentionMask.length === PROMPT_INJECTION_MAX_TOKENS,
          ),
        ).toBe(true);
      }
    },
  );

  test("uses 64-token overlap, padding, and matching attention masks", () => {
    const result = createPromptInjectionWindows([message()], () => ids(255));
    expect(result.decision).toBe("ready");
    if (result.decision !== "ready") return;

    const first = result.windows[0]!;
    const second = result.windows[1]!;
    expect(first.inputIds.slice(191, 255)).toEqual(
      second.inputIds.slice(1, 65),
    );
    expect(second.inputIds[1]).toBe(1_190);
    expect(second.inputIds[66]).toBe(102);
    expect(second.inputIds.slice(67).every((id) => id === 0)).toBe(true);
    expect(
      second.attentionMask.slice(0, 67).every((value) => value === 1),
    ).toBe(true);
    expect(second.attentionMask.slice(67).every((value) => value === 0)).toBe(
      true,
    );
  });

  test("keeps messages separate and preserves their identity", () => {
    const result = createPromptInjectionWindows(
      [message("first", 2), message("second", 7)],
      (content) => (content === "first" ? [10] : [20]),
    );
    expect(result.decision).toBe("ready");
    if (result.decision === "ready") {
      expect(result.windows.map(({ messageIndex }) => messageIndex)).toEqual([
        2, 7,
      ]);
      expect(result.windows.map(({ inputIds }) => inputIds[1])).toEqual([
        10, 20,
      ]);
    }
  });

  test("accepts 50,000 code units and rejects 50,001 before tokenization", () => {
    let encodes = 0;
    const encode = () => {
      encodes += 1;
      return [1];
    };
    expect(
      createPromptInjectionWindows([message("a".repeat(50_000))], encode)
        .decision,
    ).toBe("ready");
    expect(encodes).toBe(1);
    expect(
      createPromptInjectionWindows([message("a".repeat(50_001))], encode),
    ).toEqual({
      decision: "limit_exceeded",
      evaluatedMessageCount: 1,
      evaluatedWindowCount: 0,
    });
    expect(encodes).toBe(1);
  });

  test("accepts exactly 32 windows and blocks a required 33rd", () => {
    const thirtyTwo = 254 + 31 * 190;
    const accepted = createPromptInjectionWindows([message()], () =>
      ids(thirtyTwo),
    );
    expect(accepted.decision).toBe("ready");
    if (accepted.decision === "ready") {
      expect(accepted.windows).toHaveLength(32);
    }

    expect(
      createPromptInjectionWindows([message()], () => ids(thirtyTwo + 1)),
    ).toEqual({
      decision: "limit_exceeded",
      evaluatedMessageCount: 1,
      evaluatedWindowCount: 32,
    });
  });
});
