/**
 * Run from apps/gateway so Bun loads the local .env:
 *   bun benchmark/benchmark-pii.ts
 *
 * Each run makes one provider request and appends one local sample. The
 * provider portion of that request is the without-gateway measurement.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ConfigurationError,
  GatewayError,
  ModelGateway,
  OpenAICompatibleProvider,
  type ChatInput,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderCompletionOptions,
  type RequestContext,
} from "../src/index.ts";
import { loadGuardrailPolicy } from "../src/guardrails/config/policy-loader.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";

const MODEL = "gpt-5.4-mini";
const gatewayDirectory = resolve(import.meta.dir, "..");
const resultsDirectory = resolve(import.meta.dir, ".results");

interface BenchmarkOptions {
  id: string;
  policyFile: string;
  prompt: string;
  promptInjection?: boolean;
  outputWithoutRetry?: boolean;
}

interface Sample {
  withoutGatewayMs: number;
  withGatewayMs: number;
}

class TimedProvider implements ModelProvider {
  durationMs: number | undefined;
  callCount = 0;

  constructor(private readonly provider: ModelProvider) {}

  async complete(
    request: ChatRequest,
    context: RequestContext,
    options?: ProviderCompletionOptions,
  ): Promise<ChatResponse> {
    if (this.callCount > 0) {
      throw new Error("A benchmark run may make only one provider request.");
    }
    this.callCount += 1;
    const startedAt = performance.now();
    try {
      return await this.provider.complete(request, context, options);
    } finally {
      this.durationMs = performance.now() - startedAt;
    }
  }
}

function configuredValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function baseUrl(): string {
  const value =
    configuredValue("MODEL_BASE_URL") ?? "https://api.openai.com/v1";
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError("MODEL_BASE_URL must use HTTP or HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

function timeoutMs(): number {
  const value = Number(configuredValue("MODEL_TIMEOUT_MS") ?? "30000");
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(
      "MODEL_TIMEOUT_MS must be a positive integer.",
    );
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

function percentiles(values: readonly number[]) {
  return {
    p50Ms: Math.round(percentile(values, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(values, 0.95) * 100) / 100,
    p99Ms: Math.round(percentile(values, 0.99) * 100) / 100,
  };
}

async function loadSamples(id: string): Promise<Sample[]> {
  try {
    const content = await readFile(
      resolve(resultsDirectory, `${id}.jsonl`),
      "utf8",
    );
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Sample);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function createGateway(
  options: BenchmarkOptions,
  provider: ModelProvider,
): Promise<ModelGateway> {
  const policyPath = resolve(gatewayDirectory, "policies", options.policyFile);
  const promptInjectionModelPath = resolve(
    gatewayDirectory,
    configuredValue("PROMPT_INJECTION_MODEL_PATH") ?? "../model",
  );

  if (options.outputWithoutRetry) {
    const policy = await loadGuardrailPolicy(policyPath);
    if (!policy.output)
      throw new Error("Output benchmark policy is missing output.");
    return new ModelGateway({
      provider,
      defaultModel: MODEL,
      guardrails: new ConfiguredGuardrailHub({
        ...policy,
        defaults: { ...policy.defaults, maximumRetries: 0 },
        output: { ...policy.output, onFailure: { type: "block" } },
      }),
    });
  }

  return ModelGateway.create({
    provider,
    defaultModel: MODEL,
    policyPath,
    ...(options.promptInjection && { promptInjectionModelPath }),
  });
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const provider = new TimedProvider(
    new OpenAICompatibleProvider({
      baseUrl: baseUrl(),
      apiKey: configuredValue("MODEL_API_KEY"),
      timeoutMs: timeoutMs(),
    }),
  );
  const gateway = await createGateway(options, provider);
  const input: ChatInput = {
    messages: [{ role: "user", content: options.prompt }],
  };

  const startedAt = performance.now();
  await gateway.chat.completions.create(input);
  const withGatewayMs = performance.now() - startedAt;

  if (provider.callCount !== 1 || provider.durationMs === undefined) {
    throw new Error(
      "The benchmark did not complete exactly one provider request.",
    );
  }

  const sample: Sample = {
    withoutGatewayMs: provider.durationMs,
    withGatewayMs,
  };
  await mkdir(resultsDirectory, { recursive: true });
  await appendFile(
    resolve(resultsDirectory, `${options.id}.jsonl`),
    `${JSON.stringify(sample)}\n`,
  );
  const samples = [...(await loadSamples(options.id))];

  console.log(
    JSON.stringify(
      {
        benchmark: options.id,
        model: MODEL,
        samples: samples.length,
        withoutGateway: percentiles(
          samples.map((value) => value.withoutGatewayMs),
        ),
        withGateway: percentiles(samples.map((value) => value.withGatewayMs)),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  try {
    await runBenchmark({
      id: "input-pii",
      policyFile: "pii-policy.yaml",
      prompt: "Write a short welcome message for ava@example.com.",
    });
  } catch (error) {
    const code = error instanceof GatewayError ? ` (${error.code})` : "";
    console.error(
      `${error instanceof Error ? error.name : "BenchmarkError"}${code}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
    process.exitCode = 1;
  }
}
