import { runBenchmark } from "./benchmark-pii.ts";

await runBenchmark({
  id: "input-prompt-injection",
  policyFile: "smoke-prompt-injection-only.yaml",
  prompt:
    "Explain why crop rotation improves soil health in two short sentences.",
  promptInjection: true,
});
