import type { InferenceSession } from "onnxruntime-node";
import { ConfigurationError } from "../../domain/errors.ts";
import {
  loadPromptInjectionArtifact,
  type PromptInjectionArtifact,
} from "./prompt-injection-artifact.ts";
import type {
  PromptInjectionClassification,
  PromptInjectionClassifier,
  PromptInjectionMessage,
} from "./prompt-injection-classifier.ts";
import {
  createPromptInjectionWindows,
  PROMPT_INJECTION_MAX_BATCH_WINDOWS,
  PROMPT_INJECTION_MAX_TOKENS,
  type PromptInjectionTokenWindow,
} from "./prompt-injection-windowing.ts";

interface TokenizerLike {
  encode(
    content: string,
    options: { add_special_tokens: false },
  ): { ids: number[] };
}

export interface PromptInjectionInferenceBackend {
  encodeWithoutSpecialTokens(content: string): readonly number[];
  run(
    windows: readonly PromptInjectionTokenWindow[],
  ): Promise<readonly (readonly number[])[]>;
}

type OrtModule = typeof import("onnxruntime-node");

const classifierLoads = new Map<string, Promise<PromptInjectionClassifier>>();

export function positiveClassProbability(
  benignLogit: number,
  injectionLogit: number,
): number {
  if (!Number.isFinite(benignLogit) || !Number.isFinite(injectionLogit)) {
    throw new Error("Prompt-injection inference returned invalid logits.");
  }
  const maximum = Math.max(benignLogit, injectionLogit);
  const benign = Math.exp(benignLogit - maximum);
  const injection = Math.exp(injectionLogit - maximum);
  const probability = injection / (benign + injection);
  if (!Number.isFinite(probability)) {
    throw new Error("Prompt-injection inference returned an invalid score.");
  }
  return probability;
}

class OnnxPromptInjectionBackend implements PromptInjectionInferenceBackend {
  constructor(
    private readonly tokenizer: TokenizerLike,
    private readonly session: InferenceSession,
    private readonly ort: OrtModule,
    private readonly vocabSize: number,
  ) {}

  encodeWithoutSpecialTokens(content: string): readonly number[] {
    const ids = this.tokenizer.encode(content, {
      add_special_tokens: false,
    }).ids;
    if (
      !Array.isArray(ids) ||
      ids.some((id) => !Number.isInteger(id) || id < 0 || id >= this.vocabSize)
    ) {
      throw new Error("Prompt-injection tokenizer returned invalid token IDs.");
    }
    return ids;
  }

  async run(
    windows: readonly PromptInjectionTokenWindow[],
  ): Promise<readonly [number, number][]> {
    const elementCount = windows.length * PROMPT_INJECTION_MAX_TOKENS;
    const inputIds = new BigInt64Array(elementCount);
    const attentionMask = new BigInt64Array(elementCount);
    for (let batchIndex = 0; batchIndex < windows.length; batchIndex += 1) {
      const window = windows[batchIndex]!;
      for (
        let tokenIndex = 0;
        tokenIndex < PROMPT_INJECTION_MAX_TOKENS;
        tokenIndex += 1
      ) {
        const offset = batchIndex * PROMPT_INJECTION_MAX_TOKENS + tokenIndex;
        inputIds[offset] = BigInt(window.inputIds[tokenIndex]!);
        attentionMask[offset] = BigInt(window.attentionMask[tokenIndex]!);
      }
    }

    const dimensions = [windows.length, PROMPT_INJECTION_MAX_TOKENS];
    const result = await this.session.run({
      input_ids: new this.ort.Tensor("int64", inputIds, dimensions),
      attention_mask: new this.ort.Tensor("int64", attentionMask, dimensions),
    });
    const output = result.logits;
    if (
      !(output instanceof this.ort.Tensor) ||
      output.type !== "float32" ||
      output.dims.length !== 2 ||
      output.dims[0] !== windows.length ||
      output.dims[1] !== 2
    ) {
      throw new Error("Prompt-injection inference returned an invalid tensor.");
    }
    const data = output.data;
    if (!(data instanceof Float32Array) || data.length !== windows.length * 2) {
      throw new Error("Prompt-injection inference returned invalid data.");
    }

    const logits: [number, number][] = [];
    for (let index = 0; index < windows.length; index += 1) {
      logits.push([data[index * 2]!, data[index * 2 + 1]!]);
    }
    return logits;
  }
}

class LocalPromptInjectionClassifier implements PromptInjectionClassifier {
  readonly identity;

  constructor(
    artifact: PromptInjectionArtifact,
    private readonly backend: PromptInjectionInferenceBackend,
  ) {
    this.artifact = artifact;
    this.identity = {
      artifactId: artifact.artifactId,
      runtimeManifestSha256: artifact.manifestSha256,
    };
  }

  private readonly artifact: PromptInjectionArtifact;

  async classify(
    messages: readonly PromptInjectionMessage[],
  ): Promise<PromptInjectionClassification> {
    const windowing = createPromptInjectionWindows(messages, (content) =>
      this.backend.encodeWithoutSpecialTokens(content),
    );
    if (windowing.decision === "limit_exceeded") return windowing;

    const findings = new Map<
      number,
      { messageIndex: number; role: PromptInjectionMessage["role"] }
    >();
    for (
      let start = 0;
      start < windowing.windows.length;
      start += PROMPT_INJECTION_MAX_BATCH_WINDOWS
    ) {
      const batch = windowing.windows.slice(
        start,
        start + PROMPT_INJECTION_MAX_BATCH_WINDOWS,
      );
      const logits = await this.backend.run(batch);
      if (logits.length !== batch.length) {
        throw new Error("Prompt-injection inference returned a partial batch.");
      }
      for (let index = 0; index < batch.length; index += 1) {
        const row = logits[index];
        if (!Array.isArray(row) || row.length !== 2) {
          throw new Error(
            "Prompt-injection inference returned an invalid output row.",
          );
        }
        const [benignLogit, injectionLogit] = row;
        if (
          positiveClassProbability(benignLogit!, injectionLogit!) >=
          this.artifact.threshold
        ) {
          const window = batch[index]!;
          findings.set(window.messageIndex, {
            messageIndex: window.messageIndex,
            role: window.role,
          });
        }
      }
    }

    const metadata = {
      evaluatedMessageCount: windowing.evaluatedMessageCount,
      evaluatedWindowCount: windowing.windows.length,
    };
    return findings.size === 0
      ? { decision: "allow", ...metadata }
      : { decision: "detected", findings: [...findings.values()], ...metadata };
  }
}

export function createPromptInjectionClassifierForBackend(
  artifact: PromptInjectionArtifact,
  backend: PromptInjectionInferenceBackend,
): PromptInjectionClassifier {
  return new LocalPromptInjectionClassifier(artifact, backend);
}

async function createClassifier(
  artifact: PromptInjectionArtifact,
): Promise<PromptInjectionClassifier> {
  try {
    const [{ Tokenizer }, ort] = await Promise.all([
      import("@huggingface/tokenizers"),
      import("onnxruntime-node"),
    ]);
    const tokenizer = new Tokenizer(
      artifact.tokenizer,
      artifact.tokenizerConfig,
    );
    const session = await ort.InferenceSession.create(artifact.modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    if (
      session.inputNames.length !== 2 ||
      session.inputNames[0] !== "input_ids" ||
      session.inputNames[1] !== "attention_mask" ||
      session.outputNames.length !== 1 ||
      session.outputNames[0] !== "logits"
    ) {
      throw new Error("Unexpected ONNX graph inputs or outputs.");
    }

    const backend = new OnnxPromptInjectionBackend(
      tokenizer,
      session,
      ort,
      artifact.vocabSize,
    );
    const warmup = createPromptInjectionWindows(
      [{ messageIndex: 0, role: "user", content: "" }],
      (content) => backend.encodeWithoutSpecialTokens(content),
    );
    if (warmup.decision !== "ready" || warmup.windows.length !== 1) {
      throw new Error("Prompt-injection warm-up could not be prepared.");
    }
    const warmupLogits = await backend.run(warmup.windows);
    const warmupRow = warmupLogits[0];
    if (
      warmupLogits.length !== 1 ||
      !Array.isArray(warmupRow) ||
      warmupRow.length !== 2
    ) {
      throw new Error("Prompt-injection warm-up returned invalid logits.");
    }
    positiveClassProbability(warmupRow[0]!, warmupRow[1]!);
    return createPromptInjectionClassifierForBackend(artifact, backend);
  } catch {
    throw new ConfigurationError(
      "The prompt-injection model could not be initialized.",
    );
  }
}

export async function loadOnnxPromptInjectionClassifier(
  configuredPath: string,
  workingDirectory = process.cwd(),
): Promise<PromptInjectionClassifier> {
  const artifact = await loadPromptInjectionArtifact(
    configuredPath,
    workingDirectory,
  );
  const key = `${artifact.modelPath}:${artifact.manifestSha256}:onnxruntime-node`;
  const existing = classifierLoads.get(key);
  if (existing) return existing;

  const loading = createClassifier(artifact);
  classifierLoads.set(key, loading);
  try {
    return await loading;
  } catch (error) {
    classifierLoads.delete(key);
    throw error;
  }
}
