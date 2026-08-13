import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "../src/domain/errors.ts";
import {
  loadPromptInjectionArtifact,
  sealPromptInjectionArtifact,
} from "../src/guardrails/input/prompt-injection-artifact.ts";

const temporaryDirectories: string[] = [];
const threshold = 0.18499999999999997;

async function createArtifact(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gateway-pi-artifact-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "onnx-model"));
  await Promise.all([
    writeFile(
      join(root, "run-manifest.json"),
      JSON.stringify({
        profile: "full",
        testStatus: "complete",
        qualityGatePassed: true,
        threshold,
        maxLength: 256,
      }),
    ),
    writeFile(
      join(root, "metrics.json"),
      JSON.stringify({ passed: true, overall: { threshold } }),
    ),
    writeFile(
      join(root, "validation-metrics.json"),
      JSON.stringify({ selectedValidation: { threshold } }),
    ),
    writeFile(join(root, "slice-metrics.json"), "[]"),
    writeFile(
      join(root, "onnx-model/config.json"),
      JSON.stringify({
        architectures: ["DistilBertForSequenceClassification"],
        model_type: "distilbert",
        dtype: "float32",
        max_position_embeddings: 512,
        vocab_size: 30_522,
        id2label: { "0": "BENIGN", "1": "PROMPT_INJECTION" },
        label2id: { BENIGN: 0, PROMPT_INJECTION: 1 },
      }),
    ),
    writeFile(join(root, "onnx-model/model.onnx"), "test model bytes"),
    writeFile(
      join(root, "onnx-model/tokenizer.json"),
      JSON.stringify({
        added_tokens: [
          { id: 0, content: "[PAD]" },
          { id: 101, content: "[CLS]" },
          { id: 102, content: "[SEP]" },
        ],
      }),
    ),
    writeFile(
      join(root, "onnx-model/tokenizer_config.json"),
      JSON.stringify({
        pad_token: "[PAD]",
        cls_token: "[CLS]",
        sep_token: "[SEP]",
        tokenizer_class: "DistilBertTokenizer",
        model_max_length: 512,
      }),
    ),
    writeFile(
      join(root, "onnx-model/special_tokens_map.json"),
      JSON.stringify({
        pad_token: { content: "[PAD]" },
        cls_token: { content: "[CLS]" },
        sep_token: { content: "[SEP]" },
      }),
    ),
    writeFile(join(root, "onnx-model/vocab.txt"), "[PAD]\n[CLS]\n[SEP]\n"),
  ]);
  return root;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("prompt-injection artifact", () => {
  test("seals checksums and loads the approved threshold", async () => {
    const root = await createArtifact();
    const sealed = await sealPromptInjectionArtifact(root);
    const loaded = await loadPromptInjectionArtifact(root);

    expect(sealed.artifactId).toMatch(
      /^prompt-injection-distilbert-full-[a-f0-9]{12}$/,
    );
    expect(loaded).toMatchObject({
      artifactId: sealed.artifactId,
      threshold,
      vocabSize: 30_522,
    });
    expect(loaded.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects changed payload bytes after sealing", async () => {
    const root = await createArtifact();
    await sealPromptInjectionArtifact(root);
    await writeFile(join(root, "onnx-model/vocab.txt"), "changed");

    await expect(loadPromptInjectionArtifact(root)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("rejects threshold disagreement and failed quality gates", async () => {
    const mismatch = await createArtifact();
    await writeFile(
      join(mismatch, "metrics.json"),
      JSON.stringify({ passed: true, overall: { threshold: 0.5 } }),
    );
    await expect(sealPromptInjectionArtifact(mismatch)).rejects.toBeInstanceOf(
      ConfigurationError,
    );

    const failed = await createArtifact();
    await writeFile(
      join(failed, "run-manifest.json"),
      JSON.stringify({
        profile: "full",
        testStatus: "complete",
        qualityGatePassed: false,
        threshold,
        maxLength: 256,
      }),
    );
    await expect(sealPromptInjectionArtifact(failed)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("rejects unknown runtime-manifest fields before loading payloads", async () => {
    const root = await createArtifact();
    const { manifestPath } = await sealPromptInjectionArtifact(root);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.threshold = threshold;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(loadPromptInjectionArtifact(root)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("rejects extra labels and non-array slice reports", async () => {
    const labels = await createArtifact();
    const configPath = join(labels, "onnx-model/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.id2label["2"] = "EXTRA";
    await writeFile(configPath, JSON.stringify(config));
    await expect(sealPromptInjectionArtifact(labels)).rejects.toBeInstanceOf(
      ConfigurationError,
    );

    const slices = await createArtifact();
    await writeFile(join(slices, "slice-metrics.json"), "{}");
    await expect(sealPromptInjectionArtifact(slices)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("rejects an unexpected ONNX sidecar file", async () => {
    const root = await createArtifact();
    await writeFile(join(root, "onnx-model/model.onnx.data"), "external data");

    await expect(sealPromptInjectionArtifact(root)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
