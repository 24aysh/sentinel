import { describe, expect, test } from "bun:test";
import type { ChatRequest } from "../src/domain/chat.ts";
import {
  evaluateConfiguredInput,
  InputDetectorEvaluationError,
} from "../src/guardrails/input/input-evaluation-coordinator.ts";
import type {
  PromptInjectionClassification,
  PromptInjectionClassifier,
  PromptInjectionMessage,
} from "../src/guardrails/input/prompt-injection-classifier.ts";
import type { InputGuardrailResult } from "../src/guardrails/types.ts";
import { createTestPolicy } from "./helpers/guardrail-policy.ts";

const input: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "Email private@example.com" }],
};

function classifier(
  classify: (
    messages: readonly PromptInjectionMessage[],
  ) => Promise<PromptInjectionClassification>,
): PromptInjectionClassifier {
  return {
    identity: {
      artifactId: "prompt-injection-distilbert-full-test",
      runtimeManifestSha256: "0".repeat(64),
    },
    classify,
  };
}

function parallelPolicy(runtimeFailureMode: "open" | "closed" = "closed") {
  return createTestPolicy({
    inputExecutionMode: "parallel",
    runtimeFailureMode,
    input: [
      {
        id: "redact-email",
        detector: "pii",
        entities: ["EMAIL"],
        action: { type: "redact" },
      },
      {
        id: "inspect-injection",
        detector: "prompt_injection",
        roles: ["user"],
        action: { type: "block" },
      },
    ],
  });
}

const cleanClassification: PromptInjectionClassification = {
  decision: "allow",
  evaluatedMessageCount: 1,
  evaluatedWindowCount: 1,
};

describe("parallel input evaluation", () => {
  test("starts prompt injection first, overlaps PII, and awaits both", async () => {
    const events: string[] = [];
    let releaseClassifier!: (value: PromptInjectionClassification) => void;
    const pendingClassification = new Promise<PromptInjectionClassification>(
      (resolve) => {
        releaseClassifier = resolve;
      },
    );
    const resultPromise = evaluateConfiguredInput(
      input,
      parallelPolicy(),
      classifier(async () => {
        events.push("pi-started");
        return pendingClassification;
      }),
      (request): InputGuardrailResult => {
        events.push("pii-completed");
        return {
          decision: "allow",
          request,
          findingCount: 0,
          ruleIds: [],
          entityTypes: [],
        };
      },
    );

    expect(events).toEqual(["pi-started"]);
    await Promise.resolve();
    expect(events).toEqual(["pi-started", "pii-completed"]);

    let completed = false;
    void resultPromise.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseClassifier(cleanClassification);
    expect((await resultPromise).decision).toBe("allow");
  });

  test("classifies original text but sends the PII-safe request forward", async () => {
    let classifiedContent = "";
    const original = structuredClone(input);

    const result = await evaluateConfiguredInput(
      input,
      parallelPolicy(),
      classifier(async (messages) => {
        classifiedContent = messages[0]?.content ?? "";
        return cleanClassification;
      }),
    );

    expect(classifiedContent).toBe("Email private@example.com");
    expect(result).toMatchObject({
      decision: "redact",
      inputExecutionMode: "parallel",
      detectorTypes: ["pii", "prompt_injection"],
    });
    if (result.decision === "redact") {
      expect(result.request.messages[0]?.content).toBe("Email <EMAIL>");
    }
    expect(input).toEqual(original);
  });

  test("merges blocking findings in original policy order", async () => {
    const policy = createTestPolicy({
      inputExecutionMode: "parallel",
      input: [
        {
          id: "block-injection",
          detector: "prompt_injection",
          roles: ["user"],
          action: { type: "block" },
        },
        {
          id: "block-email",
          detector: "pii",
          entities: ["EMAIL"],
          action: { type: "block" },
        },
      ],
    });

    const result = await evaluateConfiguredInput(
      input,
      policy,
      classifier(async () => ({
        decision: "detected",
        findings: [{ messageIndex: 0, role: "user" }],
        evaluatedMessageCount: 1,
        evaluatedWindowCount: 1,
      })),
    );

    expect(result).toMatchObject({
      decision: "block",
      findingCount: 2,
      ruleIds: ["block-injection", "block-email"],
      entityTypes: ["EMAIL"],
    });
  });

  test("preserves redaction when prompt injection fails open", async () => {
    const result = await evaluateConfiguredInput(
      input,
      parallelPolicy("open"),
      classifier(async () => {
        throw new Error("private native failure");
      }),
    );

    expect(result).toMatchObject({
      decision: "redact",
      failedDetectorTypes: ["prompt_injection"],
    });
    if (result.decision === "redact") {
      expect(result.request.messages[0]?.content).toBe("Email <EMAIL>");
    }
  });

  test("fails closed when no successful detector blocks", async () => {
    await expect(
      evaluateConfiguredInput(
        { ...input, messages: [{ role: "user", content: "Hello" }] },
        parallelPolicy(),
        classifier(async () => {
          throw new Error("private native failure");
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "InputDetectorEvaluationError",
        failedDetectorTypes: ["prompt_injection"],
        inputExecutionMode: "parallel",
      }),
    );
  });

  test("lets a known PII block dominate a classifier error", async () => {
    const policy = createTestPolicy({
      inputExecutionMode: "parallel",
      input: [
        {
          id: "block-email",
          detector: "pii",
          entities: ["EMAIL"],
          action: { type: "block" },
        },
        {
          id: "inspect-injection",
          detector: "prompt_injection",
          roles: ["user"],
          action: { type: "block" },
        },
      ],
    });

    expect(
      await evaluateConfiguredInput(
        input,
        policy,
        classifier(async () => {
          throw new Error("private native failure");
        }),
      ),
    ).toMatchObject({
      decision: "block",
      ruleIds: ["block-email"],
      failedDetectorTypes: ["prompt_injection"],
    });
  });

  test("lets a known PI block dominate a PII error", async () => {
    const result = await evaluateConfiguredInput(
      input,
      parallelPolicy(),
      classifier(async () => ({
        decision: "detected",
        findings: [{ messageIndex: 0, role: "user" }],
        evaluatedMessageCount: 1,
        evaluatedWindowCount: 1,
      })),
      () => {
        throw new Error("private PII failure");
      },
    );

    expect(result).toMatchObject({
      decision: "block",
      findingCount: 1,
      ruleIds: ["inspect-injection"],
      failedDetectorTypes: ["pii"],
    });
  });

  test("fails open with the original request when PII fails", async () => {
    const result = await evaluateConfiguredInput(
      input,
      parallelPolicy("open"),
      classifier(async () => cleanClassification),
      () => {
        throw new Error("private PII failure");
      },
    );

    expect(result).toMatchObject({
      decision: "allow",
      failedDetectorTypes: ["pii"],
      findingCount: 0,
    });
    if (result.decision === "allow") expect(result.request).toBe(input);
  });

  test("reports both failures in canonical order without raw errors", async () => {
    let thrown: unknown;
    try {
      await evaluateConfiguredInput(
        input,
        parallelPolicy(),
        classifier(async () => {
          throw new Error("private PI failure");
        }),
        () => {
          throw new Error("private PII failure");
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputDetectorEvaluationError);
    expect(thrown).toMatchObject({
      failedDetectorTypes: ["pii", "prompt_injection"],
    });
    expect(JSON.stringify(thrown)).not.toContain("private");
  });

  test("fails both detectors open without inventing findings", async () => {
    const result = await evaluateConfiguredInput(
      input,
      parallelPolicy("open"),
      classifier(async () => {
        throw new Error("private PI failure");
      }),
      () => {
        throw new Error("private PII failure");
      },
    );

    expect(result).toMatchObject({
      decision: "allow",
      findingCount: 0,
      ruleIds: [],
      entityTypes: [],
      detectorTypes: ["pii", "prompt_injection"],
      failedDetectorTypes: ["pii", "prompt_injection"],
    });
    if (result.decision === "allow") expect(result.request).toBe(input);
  });

  test("skips classification when no message has a selected role", async () => {
    let classifierCalls = 0;
    const result = await evaluateConfiguredInput(
      {
        model: "test-model",
        messages: [{ role: "system", content: "System message" }],
      },
      parallelPolicy(),
      classifier(async () => {
        classifierCalls += 1;
        return cleanClassification;
      }),
    );

    expect(classifierCalls).toBe(0);
    expect(result).toMatchObject({
      decision: "allow",
      detectorTypes: ["pii"],
      inputExecutionMode: "parallel",
    });
  });
});
