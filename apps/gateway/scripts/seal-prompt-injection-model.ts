import { sealPromptInjectionArtifact } from "../src/guardrails/input/prompt-injection-artifact.ts";
import { loadOnnxPromptInjectionClassifier } from "../src/guardrails/input/onnx-prompt-injection-classifier.ts";

const modelPath = process.argv[2];
if (!modelPath) {
  throw new Error(
    "Usage: bun run seal:prompt-injection-model -- <model-directory>",
  );
}

const result = await sealPromptInjectionArtifact(modelPath);
await loadOnnxPromptInjectionClassifier(modelPath);
console.info(
  JSON.stringify(
    {
      status: "ok",
      artifactId: result.artifactId,
      filesChecked: 10,
      onnxLoadAndWarmup: "ok",
    },
    null,
    2,
  ),
);
