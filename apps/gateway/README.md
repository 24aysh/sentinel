# LLM Gateway SDK

A TypeScript-first, in-process model gateway. Applications instantiate
`ModelGateway`, optionally load YAML guardrails, and call a provider-neutral
chat-completion API directly. The package does not start or expose an HTTP
server.

Layer 1 detects and redacts or blocks supported PII. Layer 2 can run the
fine-tuned prompt-injection classifier locally from a sealed ONNX artifact
before a request reaches the provider. Output guardrails provide strict JSON
Schema validation and bounded repair retries.

## Requirements

- Bun 1.3+ or Node.js 20+ for the built SDK.
- Bun 1.3+ for repository scripts and tests.
- An OpenAI-compatible model endpoint for real-provider requests.
- An API key when the configured endpoint requires one.

## Setup

Install workspace dependencies from the repository root:

```bash
bun install
```

The package is currently private and unpublished. Build and validate it before
linking it into another project:

```bash
cd apps/gateway
bun run build
bun run check:package
```

The supported package entry is `@llm-gateway/sdk`.

## Quick start

```ts
import { ModelGateway, OpenAICompatibleProvider } from "@llm-gateway/sdk";

const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.MODEL_API_KEY,
    timeoutMs: 30_000,
  }),
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
  promptInjectionModelPath: "../model",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.response.choices[0]?.message.content);
```

The canonical operation is:

```ts
gateway.chat.completions.create(input, options);
```

SDK inputs use camel case, including `maxTokens`.

## Construction modes

Use `ModelGateway.create()` to load an optional YAML policy once:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "model-name",
  policyPath: "policies/example-policy.yaml",
  policyWorkingDirectory: process.cwd(),
  promptInjectionModelPath: "../model",
});
```

Omit `policyPath` to run without guardrails. A policy with `enabled: false` is
loaded and validated but is not attached to the gateway.

`promptInjectionModelPath` is required only when an enabled policy has a
`prompt_injection` rule. It points to the local artifact directory, not directly
to `model.onnx`. The path resolves against `policyWorkingDirectory` when that
option is supplied. No environment or network fallback exists inside the SDK.

Use the synchronous constructor when dependencies are already created:

```ts
const gateway = new ModelGateway({
  provider: customProvider,
  defaultModel: "custom-model",
  guardrails: customGuardrailHub,
  logger: applicationLogger,
  lifecycleListener: applicationListener,
});
```

The constructor performs no file or network I/O.

## Result and errors

Each successful call returns:

```ts
interface GatewayExecutionResult {
  response: ChatResponse;
  providerRequest: ChatRequest;
  context: RequestContext;
  durationMs: number;
  lifecycle: readonly LifecycleEvent[];
}
```

`providerRequest` is the request sent to the first provider call after input
guardrails. It may contain prompt data, so do not log or persist it in production
without an explicit privacy decision.

Direct failures reject with `GatewayError`:

```ts
try {
  await gateway.chat.completions.create(input);
} catch (error) {
  if (error instanceof GatewayError) {
    console.error(error.code, error.message);
  }
}
```

Configuration and policy-loading failures use `ConfigurationError`. SDK logging
is silent by default; inject `ConsoleLogger` or a custom `Logger` to opt in.

## Guardrail policy switch

The example policy has one top-level switch:

```yaml
enabled: true
```

- Omitted or `true`: configured guardrails are enforced.
- `false`: the policy is validated but prompts and responses bypass guardrails.
- No `policyPath`: no policy file is loaded.

The checked-in example policy redacts all supported input entities, then runs
the local classifier on user messages in shadow mode (`action.type: allow`).
Use `policies/pii-policy.yaml` when only Layer 1 is wanted. The optional output
schema rule remains a commented example.

Input rules use these entity names:

```yaml
entities:
  - EMAIL
  - PHONE_NUMBER
  - IP_ADDRESS
  - API_KEY
  - JWT
  - PRIVATE_KEY
  - CLOUD_CREDENTIAL
  - CREDIT_CARD
  - DATABASE_CONNECTION_STRING
```

Detection is local and structural; it does not verify whether a credential is
active, validate JWT signatures, or classify output. Credential formats are
intentionally bounded to distinctive API-key prefixes, contextual generic
secrets, AWS access keys, Google API keys/service-account key IDs, Azure Storage
keys/SAS tokens, supported PEM keys, and common database URI/SQL Server DSNs.

## Local prompt-injection model

Seal the exported model once after training or whenever any artifact file
changes:

```bash
cd apps/gateway
bun run seal:prompt-injection-model -- ../model
```

This validates the approved full training run, labels, tokenizer IDs, FP32
DistilBERT contract, and agreement between the recorded thresholds. It hashes
the required files and writes
`apps/model/guardrail-runtime-manifest.json`. Gateway startup recomputes those
hashes, reads the threshold from the hashed `run-manifest.json`, creates the CPU
ONNX session, and warms it before `ModelGateway.create()` resolves. There is no
hard-coded `0.5` fallback and policy YAML cannot override the threshold.

Prompt-injection rules have a deliberately small shape:

```yaml
- id: inspect-user-prompt-injection
  detector: prompt_injection
  roles: [user]
  action:
    type: allow # shadow; use block for enforcement
```

Input detectors run sequentially unless the policy explicitly enables
parallel evaluation:

```yaml
defaults:
  input_execution_mode: parallel
```

In sequential mode, PII is handled first and Layer 2 classifies the redacted
request. In parallel mode, Layer 2 starts on the original normalized messages
while PII is evaluated independently; the provider still receives only the
PII-safe request. Parallel mode therefore allows raw PII to enter local
tokenizer and ONNX process memory. Use sequential mode when that local-memory
boundary is unacceptable.

The cumulative decision uses `block > redact > allow`. Either detector can
block, prompt-injection shadow findings cannot undo PII handling, and every
started detector is awaited before provider dispatch.

In sequential mode, PII blocks skip inference. In parallel mode, every started
detector is allowed to finish even when its peer has already found a block. A
Layer 2 block returns the existing generic `INPUT_GUARDRAIL_BLOCKED` error and
the provider is not called. Selected input is bounded to 50,000 UTF-16 code
units and 32 overlapping 256-token windows; exceeding either safety limit
blocks the request.

## Lifecycle

A successful call without guardrails records:

```text
received
validated
provider_started
provider_completed
completed
```

Policy-backed calls add input and output guardrail stages. An invalid output can
add a bounded repair attempt. Lifecycle records contain operational metadata,
not complete prompt or response content.

## Tests and verification

Run the automated suite and type checker:

```bash
bun test
bun run check-types
```

Build the package and run external TypeScript, Bun, Node, clean-artifact, and
side-effect checks:

```bash
bun run check:package
```

No deterministic test requires a listener, API key, or network connection.

After sealing the local model, run the deterministic Layer 2 smoke checks:

```bash
bun run smoke:layer2 -- ../model
```

The command exercises both Bun source and the built Node package with a
recording provider. It asserts that benign requests reach the provider, PII is
redacted, and prompt-injection requests do not reach it. It does not call an
external LLM.

To compare warmed sequential and parallel input-guardrail latency using only
synthetic fixtures:

```bash
bun run benchmark:input-guardrails -- ../model 10
```

The benchmark prints aggregate latency, memory, and decision agreement only.

## Manual prompt-injection smoke

Copy and configure the example environment:

```bash
cp .env.example .env
```

Run the same editable prompt with the prompt-injection-only policy:

```bash
bun run smoke:prompt-injection -- pi-only
```

Or run it with prompt-injection and email redaction enabled together:

```bash
bun run smoke:prompt-injection -- pi-pii
```

Set `PROMPT_INJECTION_MODEL_PATH` if the ONNX model is not in `apps/model`.
The script reports `ALLOWED` and prints the LLM response, or reports `DECLINED`
with the gateway error code and reason. It uses `MODEL_BASE_URL`,
`MODEL_API_KEY`, `MODEL_DEFAULT`, and `MODEL_TIMEOUT_MS` for the provider.

## Current limitations

- The package is private and not published to a registry.
- Chat completions are text-only and non-streaming.
- Only an OpenAI-compatible provider adapter is included.
- The prompt-injection model is a classifier, not a substitute for
  authorization, least privilege, or tool isolation.
- The ONNX weights stay outside the SDK package and must be deployed separately.
- Native inference supports server-side Bun/Node platforms supported by
  `onnxruntime-node`; browser and edge runtimes are not supported.
- Policies are loaded during construction and do not hot reload.
- There is no provider routing or fallback.
- Prompts, responses, and lifecycle events are not persisted.
- The package does not include an HTTP server or remote HTTP client.
