import { runBenchmark } from "./benchmark-pii.ts";

await runBenchmark({
  id: "input-pii-prompt-injection",
  policyFile: "example-policy.yaml",
  prompt: "Explain crop rotation to farmer@example.com in two short sentences.",
  promptInjection: true,
});
