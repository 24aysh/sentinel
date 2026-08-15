import { runBenchmark } from "./benchmark-pii.ts";

await runBenchmark({
  id: "output-json-schema",
  policyFile: "smoke-output-only.yaml",
  prompt:
    'Return a JSON object with status "ok", message "benchmark complete", latency_ms 0, and error null.',
  outputWithoutRetry: true,
});
