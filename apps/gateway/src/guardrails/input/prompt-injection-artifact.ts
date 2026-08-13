import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ConfigurationError } from "../../domain/errors.ts";
import {
  PROMPT_INJECTION_MAX_BATCH_WINDOWS,
  PROMPT_INJECTION_MAX_SELECTED_CODE_UNITS,
  PROMPT_INJECTION_MAX_TOKENS,
  PROMPT_INJECTION_MAX_WINDOWS,
  PROMPT_INJECTION_OVERLAP_TOKENS,
} from "./prompt-injection-windowing.ts";

const RUNTIME_MANIFEST_FILE = "guardrail-runtime-manifest.json";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const JSON_LIMIT = 1024 * 1024;

const PAYLOAD_LIMITS = {
  "run-manifest.json": JSON_LIMIT,
  "metrics.json": JSON_LIMIT,
  "validation-metrics.json": JSON_LIMIT,
  "slice-metrics.json": JSON_LIMIT,
  "onnx-model/config.json": JSON_LIMIT,
  "onnx-model/model.onnx": 512 * 1024 * 1024,
  "onnx-model/tokenizer.json": 8 * 1024 * 1024,
  "onnx-model/tokenizer_config.json": JSON_LIMIT,
  "onnx-model/special_tokens_map.json": JSON_LIMIT,
  "onnx-model/vocab.txt": 4 * 1024 * 1024,
} as const;

type PayloadFile = keyof typeof PAYLOAD_LIMITS;
type UnknownRecord = Record<string, unknown>;

interface RuntimeManifest {
  schemaVersion: 1;
  artifactId: string;
  runManifestFile: "run-manifest.json";
  metricsFile: "metrics.json";
  validationMetricsFile: "validation-metrics.json";
  sliceMetricsFile: "slice-metrics.json";
  modelFile: "onnx-model/model.onnx";
  configFile: "onnx-model/config.json";
  tokenizerFile: "onnx-model/tokenizer.json";
  tokenizerConfigFile: "onnx-model/tokenizer_config.json";
  labels: { "0": "BENIGN"; "1": "PROMPT_INJECTION" };
  positiveLabelId: 1;
  scoreFunction: "softmax";
  thresholdSource: "run-manifest.json";
  maxTokens: 256;
  overlapTokens: 64;
  maxSelectedUtf16CodeUnits: 50_000;
  maxWindowsPerRequest: 32;
  maxBatchWindows: 8;
  expectedInputs: ["input_ids", "attention_mask"];
  expectedOutput: "logits";
  fileSha256: Record<PayloadFile, string>;
}

export interface PromptInjectionArtifact {
  artifactId: string;
  manifestSha256: string;
  modelPath: string;
  threshold: number;
  vocabSize: number;
  tokenizer: UnknownRecord;
  tokenizerConfig: UnknownRecord;
}

function fail(message: string): never {
  throw new ConfigurationError(`Prompt-injection model ${message}`);
}

function object(value: unknown, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`contains an invalid ${location}.`);
  }
  return value as UnknownRecord;
}

function exactObject(
  value: unknown,
  location: string,
  allowed: readonly string[],
): UnknownRecord {
  const result = object(value, location);
  const keys = Object.keys(result);
  const unknown = keys.find((key) => !allowed.includes(key));
  const missing = allowed.find((key) => !(key in result));
  if (unknown || missing) fail(`contains an invalid ${location}.`);
  return result;
}

function finiteNumber(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`contains an invalid ${location}.`);
  }
  return value;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`contains an invalid ${location}.`);
  }
  return value;
}

async function artifactRoot(
  configuredPath: string,
  workingDirectory: string,
): Promise<string> {
  if (
    typeof configuredPath !== "string" ||
    configuredPath.trim().length === 0
  ) {
    fail("path must be a non-empty string.");
  }
  const root = await realpath(resolve(workingDirectory, configuredPath)).catch(
    () => fail("directory could not be read."),
  );
  const details = await stat(root).catch(() =>
    fail("directory could not be read."),
  );
  if (!details.isDirectory()) fail("path must reference a directory.");
  return root;
}

async function payloadPath(
  root: string,
  file: string,
  maximumSize: number,
): Promise<string> {
  if (isAbsolute(file) || file.includes("\0")) {
    fail("manifest contains an unsafe file path.");
  }
  const path = await realpath(resolve(root, file)).catch(() =>
    fail("is missing a required file."),
  );
  const fromRoot = relative(root, path);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    fail("manifest contains an unsafe file path.");
  }
  const details = await stat(path).catch(() =>
    fail("is missing a required file."),
  );
  if (!details.isFile()) fail("contains a non-file payload.");
  if (details.size > maximumSize) fail("contains an oversized payload.");
  return path;
}

async function readJson(
  root: string,
  file: string,
  maximumSize = JSON_LIMIT,
): Promise<unknown> {
  const path = await payloadPath(root, file, maximumSize);
  const source = await readFile(path, "utf8").catch(() =>
    fail("contains an unreadable JSON file."),
  );
  try {
    return JSON.parse(source);
  } catch {
    fail("contains an invalid JSON file.");
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolveHash);
    stream.on("error", rejectHash);
  }).catch(() => fail("contains an unreadable payload."));
  return hash.digest("hex");
}

async function payloadHashes(
  root: string,
): Promise<Record<PayloadFile, string>> {
  const entries = await Promise.all(
    (Object.keys(PAYLOAD_LIMITS) as PayloadFile[]).map(async (file) => {
      const path = await payloadPath(root, file, PAYLOAD_LIMITS[file]);
      return [file, await sha256(path)] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<PayloadFile, string>;
}

function thresholdFromReports(
  runManifestValue: unknown,
  metricsValue: unknown,
  validationValue: unknown,
): number {
  const runManifest = object(runManifestValue, "run manifest");
  if (
    runManifest.profile !== "full" ||
    runManifest.testStatus !== "complete" ||
    runManifest.qualityGatePassed !== true
  ) {
    fail("run is not an approved full candidate.");
  }
  const threshold = finiteNumber(runManifest.threshold, "run threshold");
  if (threshold <= 0 || threshold >= 1) {
    fail("threshold must be between zero and one.");
  }
  if (runManifest.maxLength !== PROMPT_INJECTION_MAX_TOKENS) {
    fail("run uses an unsupported token length.");
  }

  const metrics = object(metricsValue, "metrics");
  const metricsOverall = object(metrics.overall, "overall metrics");
  const validation = object(validationValue, "validation metrics");
  const selectedValidation = object(
    validation.selectedValidation,
    "selected validation metrics",
  );
  if (
    metrics.passed !== true ||
    finiteNumber(metricsOverall.threshold, "metrics threshold") !== threshold ||
    finiteNumber(selectedValidation.threshold, "validation threshold") !==
      threshold
  ) {
    fail("reports disagree about the approved threshold.");
  }
  return threshold;
}

function validateModelConfig(value: unknown): number {
  const config = object(value, "model config");
  const architectures = config.architectures;
  const id2label = exactObject(config.id2label, "id-to-label mapping", [
    "0",
    "1",
  ]);
  const label2id = exactObject(config.label2id, "label-to-id mapping", [
    "BENIGN",
    "PROMPT_INJECTION",
  ]);
  if (
    !Array.isArray(architectures) ||
    !architectures.includes("DistilBertForSequenceClassification") ||
    config.model_type !== "distilbert" ||
    config.dtype !== "float32" ||
    id2label["0"] !== "BENIGN" ||
    id2label["1"] !== "PROMPT_INJECTION" ||
    label2id.BENIGN !== 0 ||
    label2id.PROMPT_INJECTION !== 1 ||
    finiteNumber(config.max_position_embeddings, "position limit") <
      PROMPT_INJECTION_MAX_TOKENS
  ) {
    fail("model config is incompatible.");
  }
  const vocabSize = finiteNumber(config.vocab_size, "vocabulary size");
  if (!Number.isInteger(vocabSize) || vocabSize <= 0) {
    fail("contains an invalid vocabulary size.");
  }
  return vocabSize;
}

function validateTokenizer(value: unknown): UnknownRecord {
  const tokenizer = object(value, "tokenizer");
  const tokens = tokenizer.added_tokens;
  if (!Array.isArray(tokens)) fail("tokenizer is missing special tokens.");
  const expected = new Map<string, number>([
    ["[PAD]", 0],
    ["[CLS]", 101],
    ["[SEP]", 102],
  ]);
  const seen = new Set<string>();
  for (const token of tokens) {
    const candidate = object(token, "special token");
    const content = String(candidate.content);
    const expectedId = expected.get(content);
    if (expectedId !== undefined) {
      if (candidate.id !== expectedId || seen.has(content)) {
        fail("tokenizer has incompatible special tokens.");
      }
      seen.add(content);
    }
  }
  if (seen.size !== expected.size) {
    fail("tokenizer has incompatible special tokens.");
  }
  return tokenizer;
}

function validateTokenizerConfig(value: unknown): UnknownRecord {
  const config = object(value, "tokenizer config");
  if (
    config.pad_token !== "[PAD]" ||
    config.cls_token !== "[CLS]" ||
    config.sep_token !== "[SEP]" ||
    config.tokenizer_class !== "DistilBertTokenizer" ||
    finiteNumber(config.model_max_length, "tokenizer length") <
      PROMPT_INJECTION_MAX_TOKENS
  ) {
    fail("tokenizer config is incompatible.");
  }
  return config;
}

function validateSpecialTokensMap(value: unknown): void {
  const specialTokens = object(value, "special-token map");
  for (const [field, expected] of [
    ["pad_token", "[PAD]"],
    ["cls_token", "[CLS]"],
    ["sep_token", "[SEP]"],
  ] as const) {
    if (object(specialTokens[field], `${field} mapping`).content !== expected) {
      fail("special-token map is incompatible.");
    }
  }
}

async function validateOnnxDirectory(root: string): Promise<void> {
  const expected = new Set(
    (Object.keys(PAYLOAD_LIMITS) as PayloadFile[])
      .filter((file) => file.startsWith("onnx-model/"))
      .map((file) => file.slice("onnx-model/".length)),
  );
  const entries = await readdir(resolve(root, "onnx-model"), {
    withFileTypes: true,
  }).catch(() => fail("ONNX directory could not be read."));
  if (
    entries.length !== expected.size ||
    entries.some((entry) => !entry.isFile() || !expected.has(entry.name))
  ) {
    fail("ONNX directory contains unexpected files.");
  }
}

async function inspectSource(root: string) {
  await validateOnnxDirectory(root);
  const [
    runManifest,
    metrics,
    validation,
    slices,
    config,
    tokenizer,
    tokenizerConfig,
    specialTokens,
  ] = await Promise.all([
    readJson(root, "run-manifest.json"),
    readJson(root, "metrics.json"),
    readJson(root, "validation-metrics.json"),
    readJson(root, "slice-metrics.json"),
    readJson(root, "onnx-model/config.json"),
    readJson(root, "onnx-model/tokenizer.json", 8 * 1024 * 1024),
    readJson(root, "onnx-model/tokenizer_config.json"),
    readJson(root, "onnx-model/special_tokens_map.json"),
  ]);
  if (!Array.isArray(slices)) fail("contains invalid slice metrics.");
  validateSpecialTokensMap(specialTokens);
  return {
    threshold: thresholdFromReports(runManifest, metrics, validation),
    vocabSize: validateModelConfig(config),
    tokenizer: validateTokenizer(tokenizer),
    tokenizerConfig: validateTokenizerConfig(tokenizerConfig),
  };
}

function parseManifest(value: unknown): RuntimeManifest {
  const allowed = [
    "schemaVersion",
    "artifactId",
    "runManifestFile",
    "metricsFile",
    "validationMetricsFile",
    "sliceMetricsFile",
    "modelFile",
    "configFile",
    "tokenizerFile",
    "tokenizerConfigFile",
    "labels",
    "positiveLabelId",
    "scoreFunction",
    "thresholdSource",
    "maxTokens",
    "overlapTokens",
    "maxSelectedUtf16CodeUnits",
    "maxWindowsPerRequest",
    "maxBatchWindows",
    "expectedInputs",
    "expectedOutput",
    "fileSha256",
  ] as const;
  const manifest = exactObject(value, "runtime manifest", allowed);
  const labels = exactObject(manifest.labels, "label mapping", ["0", "1"]);
  const hashes = exactObject(
    manifest.fileSha256,
    "payload hashes",
    Object.keys(PAYLOAD_LIMITS),
  );
  const expectedInputs = manifest.expectedInputs;
  if (
    manifest.schemaVersion !== 1 ||
    !/^prompt-injection-distilbert-full-[a-f0-9]{12}$/.test(
      text(manifest.artifactId, "artifact ID"),
    ) ||
    manifest.runManifestFile !== "run-manifest.json" ||
    manifest.metricsFile !== "metrics.json" ||
    manifest.validationMetricsFile !== "validation-metrics.json" ||
    manifest.sliceMetricsFile !== "slice-metrics.json" ||
    manifest.modelFile !== "onnx-model/model.onnx" ||
    manifest.configFile !== "onnx-model/config.json" ||
    manifest.tokenizerFile !== "onnx-model/tokenizer.json" ||
    manifest.tokenizerConfigFile !== "onnx-model/tokenizer_config.json" ||
    labels["0"] !== "BENIGN" ||
    labels["1"] !== "PROMPT_INJECTION" ||
    manifest.positiveLabelId !== 1 ||
    manifest.scoreFunction !== "softmax" ||
    manifest.thresholdSource !== "run-manifest.json" ||
    manifest.maxTokens !== PROMPT_INJECTION_MAX_TOKENS ||
    manifest.overlapTokens !== PROMPT_INJECTION_OVERLAP_TOKENS ||
    manifest.maxSelectedUtf16CodeUnits !==
      PROMPT_INJECTION_MAX_SELECTED_CODE_UNITS ||
    manifest.maxWindowsPerRequest !== PROMPT_INJECTION_MAX_WINDOWS ||
    manifest.maxBatchWindows !== PROMPT_INJECTION_MAX_BATCH_WINDOWS ||
    !Array.isArray(expectedInputs) ||
    expectedInputs.length !== 2 ||
    expectedInputs[0] !== "input_ids" ||
    expectedInputs[1] !== "attention_mask" ||
    manifest.expectedOutput !== "logits" ||
    Object.values(hashes).some(
      (hash) => typeof hash !== "string" || !SHA256_PATTERN.test(hash),
    )
  ) {
    fail("runtime manifest is incompatible.");
  }
  return manifest as unknown as RuntimeManifest;
}

export async function sealPromptInjectionArtifact(
  configuredPath: string,
  workingDirectory = process.cwd(),
): Promise<{ artifactId: string; manifestPath: string }> {
  const root = await artifactRoot(configuredPath, workingDirectory);
  await inspectSource(root);
  const fileSha256 = await payloadHashes(root);
  const artifactId = `prompt-injection-distilbert-full-${fileSha256["onnx-model/model.onnx"].slice(0, 12)}`;
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    artifactId,
    runManifestFile: "run-manifest.json",
    metricsFile: "metrics.json",
    validationMetricsFile: "validation-metrics.json",
    sliceMetricsFile: "slice-metrics.json",
    modelFile: "onnx-model/model.onnx",
    configFile: "onnx-model/config.json",
    tokenizerFile: "onnx-model/tokenizer.json",
    tokenizerConfigFile: "onnx-model/tokenizer_config.json",
    labels: { "0": "BENIGN", "1": "PROMPT_INJECTION" },
    positiveLabelId: 1,
    scoreFunction: "softmax",
    thresholdSource: "run-manifest.json",
    maxTokens: PROMPT_INJECTION_MAX_TOKENS,
    overlapTokens: PROMPT_INJECTION_OVERLAP_TOKENS,
    maxSelectedUtf16CodeUnits: PROMPT_INJECTION_MAX_SELECTED_CODE_UNITS,
    maxWindowsPerRequest: PROMPT_INJECTION_MAX_WINDOWS,
    maxBatchWindows: PROMPT_INJECTION_MAX_BATCH_WINDOWS,
    expectedInputs: ["input_ids", "attention_mask"],
    expectedOutput: "logits",
    fileSha256,
  };
  const manifestPath = resolve(root, RUNTIME_MANIFEST_FILE);
  const temporaryPath = resolve(
    root,
    `.${RUNTIME_MANIFEST_FILE}.${randomUUID()}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  }).catch(() => fail("runtime manifest could not be written."));
  await rename(temporaryPath, manifestPath).catch(() =>
    fail("runtime manifest could not be installed."),
  );
  return { artifactId, manifestPath };
}

export async function loadPromptInjectionArtifact(
  configuredPath: string,
  workingDirectory = process.cwd(),
): Promise<PromptInjectionArtifact> {
  const root = await artifactRoot(configuredPath, workingDirectory);
  const manifestPath = await payloadPath(
    root,
    RUNTIME_MANIFEST_FILE,
    JSON_LIMIT,
  );
  const manifestSource = await readFile(manifestPath, "utf8").catch(() =>
    fail("runtime manifest could not be read."),
  );
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifestSource);
  } catch {
    fail("contains an invalid runtime manifest.");
  }
  const manifest = parseManifest(manifestValue);
  const actualHashes = await payloadHashes(root);
  for (const file of Object.keys(PAYLOAD_LIMITS) as PayloadFile[]) {
    if (actualHashes[file] !== manifest.fileSha256[file]) {
      fail("payload checksum verification failed.");
    }
  }
  if (
    !manifest.artifactId.endsWith(
      actualHashes["onnx-model/model.onnx"].slice(0, 12),
    )
  ) {
    fail("artifact identity does not match its model.");
  }
  const source = await inspectSource(root);
  return {
    artifactId: manifest.artifactId,
    manifestSha256: createHash("sha256").update(manifestSource).digest("hex"),
    modelPath: await payloadPath(
      root,
      manifest.modelFile,
      PAYLOAD_LIMITS["onnx-model/model.onnx"],
    ),
    ...source,
  };
}
