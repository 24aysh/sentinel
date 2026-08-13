import { describe, expect, test } from "bun:test";
import type { PromptInjectionArtifact } from "../src/guardrails/input/prompt-injection-artifact.ts";
import {
  createPromptInjectionClassifierForBackend,
  positiveClassProbability,
  type PromptInjectionInferenceBackend,
} from "../src/guardrails/input/onnx-prompt-injection-classifier.ts";
import type { PromptInjectionTokenWindow } from "../src/guardrails/input/prompt-injection-windowing.ts";

function artifact(threshold = 0.5): PromptInjectionArtifact {
  return {
    artifactId: "prompt-injection-distilbert-full-000000000000",
    manifestSha256: "0".repeat(64),
    modelPath: "/unused/model.onnx",
    threshold,
    vocabSize: 30_522,
    tokenizer: {},
    tokenizerConfig: {},
  };
}

class FakeBackend implements PromptInjectionInferenceBackend {
  readonly batchSizes: number[] = [];

  constructor(
    private readonly tokens: readonly number[],
    private readonly score: (
      window: PromptInjectionTokenWindow,
      index: number,
    ) => readonly number[],
  ) {}

  encodeWithoutSpecialTokens(): readonly number[] {
    return this.tokens;
  }

  async run(
    windows: readonly PromptInjectionTokenWindow[],
  ): Promise<readonly (readonly number[])[]> {
    this.batchSizes.push(windows.length);
    return windows.map(this.score);
  }
}

const messages = [{ messageIndex: 3, role: "user" as const, content: "test" }];

describe("prompt-injection scoring and classification", () => {
  test("uses stable softmax and rejects non-finite logits", () => {
    expect(positiveClassProbability(10_000, 10_000)).toBe(0.5);
    expect(positiveClassProbability(-10_000, 10_000)).toBe(1);
    expect(() => positiveClassProbability(Number.NaN, 0)).toThrow();
    expect(() =>
      positiveClassProbability(0, Number.POSITIVE_INFINITY),
    ).toThrow();
  });

  test("treats threshold equality as detected", async () => {
    const classifier = createPromptInjectionClassifierForBackend(
      artifact(0.5),
      new FakeBackend([1], () => [0, 0]),
    );

    await expect(classifier.classify(messages)).resolves.toMatchObject({
      decision: "detected",
      findings: [{ messageIndex: 3, role: "user" }],
    });
  });

  test("batches eight windows and collapses repeated positives by message", async () => {
    const backend = new FakeBackend(
      Array.from({ length: 1_600 }, () => 1),
      () => [-1, 1],
    );
    const classifier = createPromptInjectionClassifierForBackend(
      artifact(),
      backend,
    );

    const result = await classifier.classify(messages);

    expect(backend.batchSizes).toEqual([8, 1]);
    expect(result).toMatchObject({
      decision: "detected",
      findings: [{ messageIndex: 3, role: "user" }],
      evaluatedWindowCount: 9,
    });
  });

  test("detects a positive second window after the first 256 tokens", async () => {
    const backend = new FakeBackend(
      Array.from({ length: 300 }, (_, index) => index),
      (window) => (window.inputIds.includes(299) ? [-1, 1] : [1, -1]),
    );
    const classifier = createPromptInjectionClassifierForBackend(
      artifact(),
      backend,
    );

    await expect(classifier.classify(messages)).resolves.toMatchObject({
      decision: "detected",
      evaluatedWindowCount: 2,
    });
  });

  test("rejects partial batches and malformed output rows", async () => {
    const partial: PromptInjectionInferenceBackend = {
      encodeWithoutSpecialTokens: () => [1],
      run: async () => [],
    };
    await expect(
      createPromptInjectionClassifierForBackend(artifact(), partial).classify(
        messages,
      ),
    ).rejects.toThrow("partial batch");

    const malformed = new FakeBackend([1], () => [0, 0, 0]);
    await expect(
      createPromptInjectionClassifierForBackend(artifact(), malformed).classify(
        messages,
      ),
    ).rejects.toThrow("invalid output row");
  });
});
