import { resolve } from "node:path";
import type { ChatRequest } from "../src/domain/chat.ts";
import { loadGuardrailPolicy } from "../src/guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { loadOnnxPromptInjectionClassifier } from "../src/guardrails/input/onnx-prompt-injection-classifier.ts";

const modelPath = resolve(
  process.argv[2] ?? resolve(import.meta.dir, "../../model"),
);
const iterations = Number(process.argv[3] ?? "10");
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000) {
  throw new Error("Iteration count must be an integer from 1 through 1000.");
}

const policy = await loadGuardrailPolicy(
  resolve(import.meta.dir, "../policies/prompt-injection-enforce-policy.yaml"),
);
const classifier = await loadOnnxPromptInjectionClassifier(modelPath);
const hubs = {
  sequential: new ConfiguredGuardrailHub(
    {
      ...policy,
      defaults: { ...policy.defaults, inputExecutionMode: "sequential" },
    },
    classifier,
  ),
  parallel: new ConfiguredGuardrailHub(policy, classifier),
};
const fixtures: { id: string; request: ChatRequest }[] = [
  {
    id: "short-benign",
    request: {
      model: "benchmark-model",
      messages: [{ role: "user", content: "Explain gardening simply." }],
    },
  },
  {
    id: "benign-with-pii",
    request: {
      model: "benchmark-model",
      messages: [
        {
          role: "user",
          content: "Explain gardening to benchmark@example.com.",
        },
      ],
    },
  },
];

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

async function evaluate(
  mode: keyof typeof hubs,
  fixture: (typeof fixtures)[number],
) {
  const startedAt = performance.now();
  const result = await hubs[mode].evaluateInput(fixture.request, {
    requestId: `benchmark-${mode}-${fixture.id}`,
    model: fixture.request.model,
    startedAt: Date.now(),
  });
  return {
    durationMs: performance.now() - startedAt,
    decision: result.decision,
  };
}

for (const fixture of fixtures) {
  await evaluate("sequential", fixture);
  await evaluate("parallel", fixture);
}

const measurements = new Map<string, number[]>();
let decisionAgreements = 0;
const rssBeforeMiB = process.memoryUsage().rss / 1024 / 1024;
for (let iteration = 0; iteration < iterations; iteration += 1) {
  for (const fixture of fixtures) {
    const order =
      iteration % 2 === 0
        ? (["sequential", "parallel"] as const)
        : (["parallel", "sequential"] as const);
    const decisions = new Map<string, string>();
    for (const mode of order) {
      const result = await evaluate(mode, fixture);
      const key = `${fixture.id}:${mode}`;
      measurements.set(key, [
        ...(measurements.get(key) ?? []),
        result.durationMs,
      ]);
      decisions.set(mode, result.decision);
    }
    if (decisions.get("sequential") === decisions.get("parallel")) {
      decisionAgreements += 1;
    }
  }
}

console.info(
  JSON.stringify(
    {
      status: "ok",
      runtime: `bun-${Bun.version}`,
      iterations,
      decisionAgreements,
      decisionComparisons: iterations * fixtures.length,
      rssBeforeMiB: Math.round(rssBeforeMiB),
      rssAfterMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      results: [...measurements].map(([key, values]) => {
        const [fixtureId, inputExecutionMode] = key.split(":");
        return {
          fixtureId,
          inputExecutionMode,
          p50Ms: Math.round(percentile(values, 0.5) * 100) / 100,
          p95Ms: Math.round(percentile(values, 0.95) * 100) / 100,
          p99Ms: Math.round(percentile(values, 0.99) * 100) / 100,
        };
      }),
    },
    null,
    2,
  ),
);
