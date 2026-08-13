# Layer 2 Local ONNX Inference: Implementation Plan

## 1. Purpose and Status

This document is the implementation plan for connecting the already trained
prompt-injection classifier in `apps/model/` to the TypeScript gateway.

The finished request path will be:

```text
ChatInput
  -> validation and normalization
  -> Layer 1 PII evaluation
  -> Layer 2 local prompt-injection evaluation
  -> provider only when the request is allowed
```

Implementation status (August 13, 2026): the core integration described here
is implemented. The gateway now seals and verifies the local artifact, loads
and warms ONNX inference during async construction, evaluates bounded
overlapping windows after PII handling, and supports policy-controlled shadow
or blocking behavior. The checked-in enforcement policy is used only by the
manual smoke scripts; the default example remains in shadow mode.

It supersedes runtime and artifact assumptions from older Layer 2 drafts where
those assumptions conflict with the model that was actually exported. The
dataset preparation and training history in the fine-tuning implementation
spec remain useful context even if that file has since been renamed or removed.

The completed local verification includes 107 unit/integration tests, package
and type checks, source inference under Bun, and built ESM inference under
Node. The remaining production rollout gates are the synthetic Python/ONNX
parity corpus, deployment-class concurrency and percentile performance tests,
and the provenance/license review described later in this document.

The most important correction is that the threshold is already calibrated and
must not be guessed or made a YAML default. The runtime source of truth is:

```text
apps/model/run-manifest.json -> threshold = 0.18499999999999997
```

Documentation may display this as `0.185`, but runtime comparison must use the
full JSON number read from the artifact.

## 2. Audited Repository Baseline

### 2.1 Gateway behavior today

The gateway is an in-process SDK. It has no inbound HTTP listener and the
Layer 2 work must not add one. Applications call:

```ts
gateway.chat.completions.create(input, options);
```

The current implementation has:

| Area               | Current behavior                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Construction       | `ModelGateway.create()` asynchronously loads YAML; `new ModelGateway()` accepts injected dependencies synchronously |
| Policy             | Strict `guardrails/v1` YAML with unknown-field rejection                                                            |
| Input guardrail    | PII only, with `allow`, `redact`, and `block`                                                                       |
| Input sequencing   | One `ConfiguredGuardrailHub.evaluateInput()` call before the provider                                               |
| Failure policy     | `defaults.runtime_failure_mode` is `open` or `closed`; default is `closed`                                          |
| Provider safety    | An input block produces zero provider calls                                                                         |
| Public block error | `INPUT_GUARDRAIL_BLOCKED`, status `400`, generic message                                                            |
| Output guardrail   | Optional JSON Schema validation and bounded retry                                                                   |
| Runtime support    | Bun 1.3+ for repository work; built SDK supports Node.js 20+                                                        |
| Package entry      | Side-effect-free ESM entry at `src/index.ts`                                                                        |

The current policy and input types assume every input rule is a PII rule.
`InputPolicyRule` has an `entities` field, and `policy-loader.ts` accepts only
`detector: pii`. Layer 2 therefore requires a discriminated rule union rather
than adding optional fields to the current PII shape.

### 2.2 Existing code that must remain stable

The implementation must preserve:

- the public `GuardrailHub` injection point;
- the synchronous constructor for callers supplying a custom hub;
- the provider-neutral chat request and response types;
- existing PII-only YAML behavior;
- immutable PII redaction;
- current lifecycle stage names and ordering;
- generic public guardrail errors;
- output validation and repair retries; and
- a side-effect-free package import when no gateway is constructed.

No change is required in the provider interface, OpenAI-compatible provider,
chat domain types, or JSON Schema validator.

### 2.3 Tooling observation

At planning time, Node.js is available but `bun` is not installed in the local
shell. Implementation must therefore run the required Bun checks in an
environment with Bun 1.3 or newer. The native inference dependency cannot be
declared compatible with Bun merely because it compiles under Node.

## 3. Audited Model Bundle

### 3.1 Actual layout

The exported model currently has this layout:

```text
apps/model/
  metrics.json
  run-manifest.json
  slice-metrics.json
  validation-metrics.json
  onnx-model/
    config.json
    model.onnx
    special_tokens_map.json
    tokenizer.json
    tokenizer_config.json
    vocab.txt
  pytorch-model/                 # training/reference asset, not runtime input
```

The TypeScript option will point to `apps/model`, not directly to
`apps/model/onnx-model` and not to the `.onnx` file. The loader needs both the
run metadata at the root and the tokenizer/model files below it.

### 3.2 Confirmed runtime facts

| Property              | Repository evidence                        | Runtime interpretation                                            |
| --------------------- | ------------------------------------------ | ----------------------------------------------------------------- |
| Profile               | `full`                                     | Candidate full training run                                       |
| Test status           | `complete`                                 | Test metrics are present                                          |
| Quality gate          | `true`                                     | The training workflow's aggregate gate passed                     |
| Base model            | `distilbert/distilbert-base-uncased`       | DistilBERT sequence classifier                                    |
| Base revision         | `12040accade4e8a0f71eabdb258fecc2e7e948be` | Recorded training provenance                                      |
| Labels                | `0 BENIGN`, `1 PROMPT_INJECTION`           | Positive score is softmax class index 1                           |
| Threshold             | `0.18499999999999997`                      | Detect when positive score is greater than or equal to this value |
| Training maximum      | `256` tokens                               | Runtime window size, including special tokens                     |
| Tokenizer maximum     | `512` tokens                               | Architecture capacity, not the trained runtime window             |
| Model precision       | `float32`                                  | Use CPU FP32 initially                                            |
| Model size            | `267,932,172` bytes                        | Keep external to the npm package                                  |
| Special token IDs     | PAD `0`, CLS `101`, SEP `102`, UNK `100`   | Validate before building windows                                  |
| Expected graph inputs | `input_ids`, `attention_mask`              | Verify through the loaded ONNX session                            |
| Expected graph output | `logits`                                   | Verify shape `[batch, 2]` at warm-up                              |

The model config identifies `DistilBertForSequenceClassification` and does not
require `token_type_ids`. Startup must reject a graph that asks for an
unexpected third input rather than fabricating one silently.

### 3.3 Recorded quality

The current held-out test report records:

| Metric                              |   Value |
| ----------------------------------- | ------: |
| Accuracy                            | 0.98463 |
| Macro F1                            | 0.98463 |
| Prompt-injection precision          | 0.98171 |
| Prompt-injection recall             | 0.98764 |
| Overall benign false-positive rate  | 0.01838 |
| Benign `ignore` false-positive rate | 0.01481 |
| Non-`ignore` injection recall       | 0.98642 |

One source slice is materially weaker:

```text
source::rogue-security/prompt-injections-benchmark
false-positive rate = 0.111888...
```

This does not prevent integration, but it changes rollout: the model should run
in shadow mode on representative gateway traffic before hard blocking is
enabled. Aggregate metrics alone are not sufficient evidence for an immediate
production block.

### 3.4 Artifact gaps to close before enforcement

The current bundle is inferable but is not yet a sealed runtime artifact:

- `run-manifest.json` has no schema version or artifact ID;
- file checksums are not recorded inside a runtime manifest;
- the runtime model path is implicit;
- stride, window limit, expected graph names, and score semantics are absent;
- ONNX/PyTorch and Python/TypeScript parity results are not packaged;
- source revisions are not fully present in the runtime bundle;
- `slice-metrics.json` names `project-generated-v3`, while the training spec
  describes a v2 generated set; and
- no explicit licensing/deployment approval record is present.

These are provenance and release gaps, not a reason to replace the measured
threshold with a default. The local implementation can proceed after technical
sealing and parity. Public redistribution or a strong production-security claim
requires the separate provenance/license review described later.

### 3.5 Current checksums

The sealing command must recompute these values and fail if the files have
changed. The following values document the planning-time snapshot:

| File                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| `run-manifest.json`                  | `f42623c26d187731a879757100362ac7aeb562c210fd5a65a4e1aa5b479269ce` |
| `metrics.json`                       | `76a433e7a6f13e85269dd746da3881060dfc1bd8a9ba2b19acbe7ac19432581b` |
| `validation-metrics.json`            | `d593c487e1f5fe6e120525d385ea5128aea88d75c246c56e1058ff995d866be3` |
| `slice-metrics.json`                 | `5dfe4fb9ac2918f14feae48b40bea0124014021f0860bbdba87faeb4c031e4f0` |
| `onnx-model/config.json`             | `01b1440557783f86f3f119abe9e1ea14926bcaf267dcbd49d7b0242a681ba7d9` |
| `onnx-model/model.onnx`              | `31335f278603a91c1f668088ac2f3a62a26630e47014a58ef3d303429a6c467e` |
| `onnx-model/tokenizer.json`          | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| `onnx-model/tokenizer_config.json`   | `a3c9410f27554c6e26af779fd147e536c6c5f9e5cb0e6b8f38ddaa25e1b0f6af` |
| `onnx-model/special_tokens_map.json` | `5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a` |
| `onnx-model/vocab.txt`               | `07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3` |

Checksums detect accidental drift. A manifest stored beside the model is not a
signature and does not defend against an attacker who can replace both files.
Signed artifact distribution is deferred.

## 4. Scope

### 4.1 Goals

The implementation must:

1. load the supplied ONNX classifier and tokenizer from local files only;
2. read the calibrated threshold from `run-manifest.json`;
3. load and warm the model once during `ModelGateway.create()` when needed;
4. run PII before prompt-injection classification;
5. classify only roles selected by prompt-injection policy rules;
6. scan long messages with bounded overlapping token windows;
7. block before the provider when any selected message crosses the threshold
   and its resolved rule action is `block`;
8. support `allow` as shadow/audit mode without exposing scores;
9. preserve completed PII redaction if Layer 2 fails open;
10. validate artifact paths, JSON schemas, labels, hashes, graph I/O, and a
    warm-up result before accepting traffic;
11. keep prompt text, token IDs, logits, scores, and threshold out of public
    errors and operational logs;
12. preserve existing PII-only, no-policy, disabled-policy, output-guardrail,
    and custom-hub behavior;
13. work from built ESM under Node.js 20+ and source/build under Bun 1.3+;
14. keep the 256 MiB model outside the published SDK package; and
15. provide deterministic unit tests without requiring the real model plus an
    explicit real-artifact release check.

### 4.2 Non-goals

This milestone will not:

- retrain, relabel, quantize, or modify the classifier weights;
- call Python for each request;
- call Hugging Face or another hosted inference endpoint;
- add an HTTP server;
- scan model output for prompt injection;
- scan retrieved documents, tool results, files, images, or audio separately;
- perform prompt redaction or rewriting;
- expose confidence scores to SDK callers;
- claim that `BENIGN` means content-safe or authorized;
- make the model path hot-reloadable;
- add per-tenant thresholds;
- silently truncate selected messages at 256 tokens; or
- bundle the model in `@llm-gateway/sdk`.

## 5. Confirmed Runtime Decisions

1. The model root is an explicit `ModelGateway.create()` option.
2. There is no environment-variable or network fallback in production code.
3. The threshold comes only from the loaded artifact and cannot be overridden
   in YAML for this policy version.
4. Detection is `positiveClassProbability >= threshold`.
5. Positive-class probability is the stable two-class softmax of `logits[1]`.
6. PII blocks stop immediately and skip Layer 2.
7. The classifier sees the PII-redacted request when Layer 1 redacts.
8. Default example policy scans `user` messages only.
9. Long input uses 256-token windows with 64 content-token overlap.
10. At most 32 windows are evaluated across selected messages in one request.
11. Selected messages are limited to 50,000 UTF-16 code units per request
    before tokenization begins.
12. Exceeding either input bound is a deterministic input block, not a
    classifier exception and not a fail-open event.
13. Inference batches at most eight windows.
14. CPU is the first execution provider; CUDA is not required.
15. Model loading is async and eager during gateway creation, not lazy on the
    first customer request.
16. The real model is shared by canonical artifact identity; prompts and
    predictions are never cached.
17. Existing lifecycle stages are retained; sanitized detector metadata is
    added rather than creating noisy per-window stages.
18. Shadow mode is the first rollout state because one recorded source slice
    has an 11.2 percent false-positive rate.

## 6. Runtime Dependency Strategy

### 6.1 Candidate implementation

Use direct ONNX Runtime for the model and the lightweight Hugging Face
tokenizer implementation for tokenization:

```text
onnxruntime-node
@huggingface/tokenizers
```

This is preferable for the current artifact because:

- ONNX Runtime can load the existing explicit
  `onnx-model/model.onnx` path without rearranging the model bundle;
- `@huggingface/tokenizers` constructs a tokenizer directly from the local
  `tokenizer.json` and `tokenizer_config.json` objects;
- neither component needs a model ID or remote-file resolver;
- the score calculation and windowing contract stay visible in gateway code;
  and
- native ONNX Runtime is the server-side CPU path recommended for Node.js.

The initial compatibility spike should test exact candidate pins
`onnxruntime-node@1.27.0` and `@huggingface/tokenizers@0.1.3`. If the spike
passes, commit exact versions and the resulting `bun.lock`; do not leave caret
or tilde ranges for the native inference runtime.

### 6.2 Bun compatibility gate

`onnxruntime-node` publishes Node native binaries, while the gateway also
supports Bun. Before implementing the complete classifier, add a small spike
that:

1. dynamically imports both dependencies;
2. loads the real ONNX file;
3. constructs the real tokenizer from the two local JSON files;
4. runs one benign and one injection fixture;
5. exits cleanly under Bun 1.3+;
6. repeats from built ESM under Node.js 20+; and
7. performs the run with outbound network access disabled/intercepted.

If native ONNX Runtime fails under Bun, evaluate `onnxruntime-web` with the CPU
WASM backend as the explicit fallback. That fallback must repeat model-load,
latency, memory, package, and offline checks before selection. Do not keep two
production backends or silently start a Python service.

### 6.3 Import behavior

Inference dependencies must be dynamically imported only while creating an
enabled prompt-injection classifier. Therefore:

- importing `@llm-gateway/sdk` performs no model or tokenizer work;
- no-policy and PII-only gateways do not load a native library;
- a disabled policy does not load the model;
- unsupported native platforms fail only when the feature is configured; and
- `src/index.ts` remains side-effect-free.

## 7. Runtime Artifact Contract

### 7.1 Preserve the training output

Do not rewrite `run-manifest.json`, `metrics.json`, or model configuration in
place. They are training outputs. Add a separate generated file:

```text
apps/model/guardrail-runtime-manifest.json
```

The sealing command creates this file after validating the current bundle.

### 7.2 Runtime manifest shape

The manifest is strict and has no unknown fields in schema version 1:

```json
{
  "schemaVersion": 1,
  "artifactId": "prompt-injection-distilbert-full-31335f278603",
  "runManifestFile": "run-manifest.json",
  "metricsFile": "metrics.json",
  "validationMetricsFile": "validation-metrics.json",
  "sliceMetricsFile": "slice-metrics.json",
  "modelFile": "onnx-model/model.onnx",
  "configFile": "onnx-model/config.json",
  "tokenizerFile": "onnx-model/tokenizer.json",
  "tokenizerConfigFile": "onnx-model/tokenizer_config.json",
  "labels": { "0": "BENIGN", "1": "PROMPT_INJECTION" },
  "positiveLabelId": 1,
  "scoreFunction": "softmax",
  "thresholdSource": "run-manifest.json",
  "maxTokens": 256,
  "overlapTokens": 64,
  "maxSelectedUtf16CodeUnits": 50000,
  "maxWindowsPerRequest": 32,
  "maxBatchWindows": 8,
  "expectedInputs": ["input_ids", "attention_mask"],
  "expectedOutput": "logits",
  "fileSha256": {
    "run-manifest.json": "<sha256>",
    "metrics.json": "<sha256>",
    "validation-metrics.json": "<sha256>",
    "slice-metrics.json": "<sha256>",
    "onnx-model/config.json": "<sha256>",
    "onnx-model/model.onnx": "<sha256>",
    "onnx-model/tokenizer.json": "<sha256>",
    "onnx-model/tokenizer_config.json": "<sha256>",
    "onnx-model/special_tokens_map.json": "<sha256>",
    "onnx-model/vocab.txt": "<sha256>"
  }
}
```

The runtime manifest deliberately points to the threshold source instead of
becoming a competing threshold authority. Its artifact ID uses the first 12
hex characters of the ONNX SHA-256 so operational metadata identifies the
exact weights.

### 7.3 Sealing command

Add:

```text
apps/gateway/scripts/seal-prompt-injection-model.ts
```

Expected usage from `apps/gateway`:

```bash
bun run seal:prompt-injection-model -- ../model
```

The command must:

1. resolve the artifact root with `realpath`;
2. validate every required file as a regular file;
3. enforce size limits before reading;
4. strictly parse the four root JSON reports and tokenizer/model configs;
5. require `profile: full`, `testStatus: complete`, and
   `qualityGatePassed: true` in the current candidate;
6. require the threshold to be finite and in the open interval `(0, 1)`;
7. require exact threshold agreement among `run-manifest.json`,
   `metrics.json.overall`, and
   `validation-metrics.json.selectedValidation`;
8. require labels `0 BENIGN` and `1 PROMPT_INJECTION` in `config.json`;
9. require `DistilBertForSequenceClassification`, two labels, FP32, and at
   least 256 positional embeddings;
10. require tokenizer special IDs PAD `0`, CLS `101`, and SEP `102`;
11. calculate hashes with streaming reads;
12. write the runtime manifest atomically through a temporary file and rename;
13. print only artifact ID, files checked, and success/failure; and
14. never print model paths outside an explicitly invoked developer command,
    prompt data, source rows, or secrets.

The command should also use an offline ONNX inspection step to assert that the
model is self-contained and does not reference external tensor files. If this
cannot be done safely in TypeScript, add a small developer-only Python verifier
using the already established training environment. Runtime request handling
must not require Python.

### 7.4 Loader validation

At gateway startup, the TypeScript artifact loader must:

- accept an artifact directory, never a raw `.onnx` path;
- use canonical paths and reject absolute child paths, `..`, symlink escape,
  and non-regular files;
- cap the runtime manifest and ordinary JSON files at 1 MiB;
- cap `tokenizer.json` at 8 MiB;
- cap `vocab.txt` at 4 MiB;
- cap the ONNX file at 512 MiB;
- reject missing and unknown manifest fields;
- recompute every manifest checksum;
- re-read the threshold from the hashed `run-manifest.json`;
- cross-check the metrics threshold and quality/test flags;
- cross-check all label and tokenizer invariants;
- reject unsafe bounds such as a window below 8, overlap at least the window,
  a non-positive character limit, zero window/batch limits, or limits above
  the schema maxima;
- load the ONNX session from the manifest's exact model path;
- require exactly `input_ids` and `attention_mask` inputs and one `logits`
  output; and
- warm up with one `[CLS] [SEP]` window and require finite `[1, 2]` logits.

Construction errors use `ConfigurationError` with generic messages. Low-level
native error strings, file contents, and absolute model paths do not become
public SDK error messages.

### 7.5 License/provenance gate

The runtime model stays outside the npm package. The technical loader should
not pretend to make a legal determination. Before commercial deployment or
redistribution, separately resolve:

- the Rogue Security dataset's non-commercial terms;
- the absent/unclear licenses of the `jayavibhav` sources;
- the `project-generated-v3` versus v2 provenance mismatch; and
- whether the intended model-weight use and distribution are permitted.

Until then, treat this as a private local artifact and do not publish it with
the SDK.

## 8. Public Construction Contract

Extend only the async factory options:

```ts
export interface ModelGatewayCreateOptions {
  provider: ModelProvider;
  defaultModel: string;
  policyPath?: string;
  policyWorkingDirectory?: string;
  promptInjectionModelPath?: string;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}
```

Behavior is:

| Configuration                                 | Result                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| No policy and no model path                   | Preserve current behavior; no inference imports or file access   |
| No policy but a model path                    | Reject the unused model configuration                            |
| Disabled policy, with or without a model path | Validate YAML shape; do not require, validate, or load the model |
| Enabled PII-only policy and no model path     | Preserve current behavior; do not require/load model             |
| Enabled PII-only policy but a model path      | Reject the unused model configuration                            |
| Enabled PI rule, missing model path           | Reject construction with `ConfigurationError`                    |
| Enabled PI rule, invalid/unsealed model       | Reject construction before accepting requests                    |
| Enabled PI rule, valid model                  | Verify, load, warm, and inject one classifier                    |

Rejecting an unused model path is safer than silently accepting a configuration
that looks protected but has no corresponding policy rule.

Relative `promptInjectionModelPath` values resolve against
`policyWorkingDirectory` when it is supplied, or `process.cwd()` otherwise.
The path is never read from an environment variable inside the SDK.

The synchronous `new ModelGateway({...})` constructor does not gain a model
path. Advanced callers continue to inject a custom `GuardrailHub`.

## 9. Policy Contract

### 9.1 Discriminated rule types

Replace the current single `InputPolicyRule` interface with:

```ts
export interface PiiInputPolicyRule {
  id: string;
  detector: "pii";
  entities: PiiEntity[];
  roles?: ChatRole[];
  action: InputPolicyAction;
}

export interface PromptInjectionInputPolicyRule {
  id: string;
  detector: "prompt_injection";
  roles: ChatRole[];
  action: { type: "allow" | "block" };
}

export type InputPolicyRule =
  PiiInputPolicyRule | PromptInjectionInputPolicyRule;
```

Store `detector` in loaded PII rules too; do not rely on the parser having
discarded it.

### 9.2 YAML example

The checked-in example becomes:

```yaml
input:
  - id: redact-sensitive-input
    description: Redact supported PII before any later input detector.
    detector: pii
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
    action:
      type: redact

  - id: inspect-user-prompt-injection
    description: Run the local classifier after PII redaction.
    detector: prompt_injection
    roles:
      - user
    action:
      type: allow # shadow first; change to block only after rollout gates pass
```

### 9.3 Strict validation

For `prompt_injection` rules:

- `roles` is required, non-empty, unique, and limited to supported chat roles;
- `action.type` is only `allow` or `block`;
- `entities` is forbidden;
- `replacement` is forbidden;
- no threshold, model path, window size, or model ID is accepted in YAML;
- descriptions remain optional and capped at 2,000 characters;
- unknown fields and unknown detectors fail;
- IDs stay globally unique across input and output; and
- disabled policies are still fully validated.

`defaults.input_action` continues to resolve unmatched PII findings only. It
does not become a default prompt-injection action.

### 9.4 Rule resolution

Policy order is authoritative. For each positive message, the first
`prompt_injection` rule whose `roles` includes the message role determines the
action. This permits a specific role exception before a broad block rule.

The classifier receives the union of roles referenced by PI rules, so a role
is not tokenized twice even if multiple rules mention it. If any positive
message resolves to `block`, the request blocks. Positive messages that resolve
to `allow` are shadow findings and do not override a different blocked finding.

## 10. Classifier and Backend Interfaces

### 10.1 Gateway-facing classifier

Keep ML details behind an injectable interface:

```ts
export interface PromptInjectionMessage {
  messageIndex: number;
  role: ChatRole;
  content: string;
}

export interface PromptInjectionClassifierIdentity {
  artifactId: string;
  runtimeManifestSha256: string;
}

export interface PromptInjectionClassifier {
  readonly identity: PromptInjectionClassifierIdentity;

  classify(messages: readonly PromptInjectionMessage[]): Promise<
    | {
        decision: "allow";
        evaluatedMessageCount: number;
        evaluatedWindowCount: number;
      }
    | {
        decision: "detected";
        findings: readonly {
          messageIndex: number;
          role: ChatRole;
        }[];
        evaluatedMessageCount: number;
        evaluatedWindowCount: number;
      }
    | {
        decision: "limit_exceeded";
        evaluatedMessageCount: number;
        evaluatedWindowCount: number;
      }
  >;
}
```

Multiple positive windows in one message collapse to one finding. Scores and
window offsets never cross this interface.

### 10.2 Runtime adapter

Wrap native APIs behind a smaller internal backend so most tests do not load a
256 MiB model:

```ts
interface PromptInjectionInferenceBackend {
  encodeWithoutSpecialTokens(text: string): readonly number[];
  run(batch: TokenWindowBatch): Promise<readonly [number, number][]>;
}
```

The production adapter owns the local tokenizer and one ONNX
`InferenceSession`. Unit tests inject fixed token IDs and logits. The concrete
adapter validates all returned tensor types and dimensions before converting
them to ordinary numbers.

## 11. Tokenization and Windowing

### 11.1 Why windowing is required

Training used 256-token inputs. Head-only truncation would allow an attacker to
place an injection after token 256. The runtime must cover the complete bounded
selected input using overlapping windows.

### 11.2 Exact algorithm

For each selected message, in original message order:

1. add its JavaScript string length to the selected request's UTF-16 code-unit
   count and return `limit_exceeded` before tokenization when the total would
   exceed 50,000;
2. tokenize the content without special tokens;
3. reserve two positions for `[CLS]` and `[SEP]`;
4. set `contentCapacity = 256 - 2 = 254`;
5. set `advance = contentCapacity - 64 = 190`;
6. for starts `0, 190, 380, ...`, take at most 254 content token IDs;
7. build `[101, ...contentIds, 102]`;
8. pad the rest of the 256 positions with token ID `0`;
9. use attention `1` for real positions and `0` for padding;
10. count the window against the request-wide maximum of 32; and
11. stop adding windows after the final content token is covered.

An empty encoded sequence still produces `[CLS, SEP]` so startup/runtime
behavior is deterministic, although normalized chat validation ordinarily
prevents an empty message.

Across the selected request, 32 windows cover at most about 6,144 content
tokens when one long message consumes the full budget. Multiple messages each
have their own CLS/SEP pair and share the same 32-window total.

### 11.3 Tensor construction

For a batch of `B` windows:

```text
input_ids shape      [B, 256], int64
attention_mask shape [B, 256], int64
```

Use `BigInt64Array` for ONNX `int64` inputs and create arrays locally per
request. Validate token IDs before conversion:

- every ID is an integer;
- every ID is at least zero and below `vocab_size` 30,522; and
- the tokenizer does not return an unsupported type.

Do not log or cache token arrays.

### 11.4 Batching

Process at most eight windows per ONNX call. After each batch:

- calculate scores;
- collapse positive windows by message; and
- continue through all selected windows so the policy-neutral classifier
  returns every detected message needed for role-specific rule resolution.

The classifier itself may return all detected messages in the evaluated
batches. It does not resolve policy actions or return partial scores. A future
optimization may pass pre-resolved action metadata into a different interface,
but this milestone favors a simple policy-neutral classifier.

### 11.5 Window-budget behavior

If selected content exceeds 50,000 UTF-16 code units or building the selected
messages would require a 33rd window, return `limit_exceeded`. The hub converts
this to `block` even when the policy action is shadow `allow`. These are
deterministic safety bounds, not inference failures, so
`runtime_failure_mode: open` does not bypass them.

## 12. Scoring and Threshold Semantics

For each output pair `[benignLogit, injectionLogit]`, calculate a numerically
stable softmax:

```ts
const maximum = Math.max(benignLogit, injectionLogit);
const benign = Math.exp(benignLogit - maximum);
const injection = Math.exp(injectionLogit - maximum);
const positiveScore = injection / (benign + injection);
const detected = positiveScore >= artifact.threshold;
```

Requirements:

- both logits and the resulting score must be finite;
- the output must contain exactly two logits per window;
- class index 1 must map to `PROMPT_INJECTION` in the model config;
- equality with the threshold is positive;
- `0.5` is never used as a fallback;
- YAML cannot override the threshold;
- logs and lifecycle records cannot contain the score or threshold; and
- a malformed tensor is a classifier runtime failure, not an `allow` result.

The runtime reads the threshold once during artifact load and stores it in the
classifier instance. It does not read JSON for each request.

## 13. PII-First Hub Composition

### 13.1 Refactor boundary

Rename or narrow the current `evaluateInput()` function to an explicit PII
operation such as `evaluatePiiInput()`. It returns the current allow/redact/block
result unchanged. `ConfiguredGuardrailHub` then composes Layer 1 and Layer 2.

### 13.2 Ordered algorithm

`ConfiguredGuardrailHub.evaluateInput()` must:

1. evaluate PII against the normalized request;
2. return immediately if PII blocks;
3. retain the PII result and its safe request;
4. skip Layer 2 when no PI rules exist;
5. select only messages whose roles occur in a PI rule;
6. skip inference when that selected set is empty;
7. pass the PII-safe message content to the classifier;
8. block on `limit_exceeded`;
9. resolve each detected message through first matching PI rule;
10. block if any resolved action is `block`;
11. otherwise return the PII decision (`allow` or `redact`) and safe request;
    and
12. merge only sanitized counts, rule IDs, detector types, and model identity.

Expected behavior matrix:

| Layer 1      | Layer 2         | Provider behavior           |
| ------------ | --------------- | --------------------------- |
| block        | skipped         | zero calls                  |
| redact       | allow           | receives redacted request   |
| redact       | shadow detect   | receives redacted request   |
| redact       | blocking detect | zero calls                  |
| allow        | allow           | receives normalized request |
| allow        | shadow detect   | receives normalized request |
| allow        | blocking detect | zero calls                  |
| allow/redact | limit exceeded  | zero calls                  |

Neither evaluator mutates the caller's input.

### 13.3 Safe fail-open behavior

The pipeline currently wraps the whole input hub and uses the original
normalized request as its fail-open fallback. If PII redaction succeeds and
Layer 2 then throws, that fallback would restore the secret-bearing request.

The hub must catch classifier-only failures after PII completes:

- in `closed` mode, rethrow so the pipeline returns the existing sanitized
  `GUARDRAIL_EVALUATION_FAILED` error and makes zero provider calls;
- in `open` mode, return the completed PII result and PII-safe request, add
  `prompt_injection` to `failedDetectorTypes`, and continue; and
- never attach the caught native/tokenizer error to result metadata.

The pipeline notices `failedDetectorTypes` and emits the existing sanitized
runtime-failure log with detector identity. It must not rerun the entire input
fallback. PII evaluator failures keep the existing outer fail-open/fail-closed
behavior.

This distinction is mandatory and requires an integration test with an email,
PII redaction, a throwing classifier, and `runtime_failure_mode: open`.

## 14. Result Metadata and Observability

### 14.1 Type additions

Add optional fields so custom hubs remain source-compatible:

```ts
export type InputDetectorType = "pii" | "prompt_injection";

interface GuardrailResultMetadata {
  ruleIds: string[];
  entityTypes: PiiEntity[];
  detectorTypes?: InputDetectorType[];
  failedDetectorTypes?: InputDetectorType[];
  promptInjectionModelId?: string;
  evaluatedMessageCount?: number;
  evaluatedWindowCount?: number;
}
```

`findingCount` remains the combined count:

- one per PII span; plus
- one per distinct detected message, regardless of positive window count.

`entityTypes` remains PII-only. Prompt injection is a detector type, not a PII
entity.

### 14.2 Allowed logs/lifecycle metadata

Operational records may contain:

- request ID;
- policy name/version;
- decision;
- rule IDs;
- detector and failed-detector types;
- artifact ID;
- aggregate finding/message/window counts;
- lifecycle stage and duration; and
- fail-open versus fail-closed action.

Do not log or return:

- raw or normalized message content;
- PII-redacted content;
- tokens or token IDs;
- per-window positions;
- logits, probabilities, or the threshold;
- full model paths;
- source rows or training error examples; or
- low-level native exception strings.

### 14.3 Public behavior

A Layer 2 policy block uses the existing response:

```text
code: INPUT_GUARDRAIL_BLOCKED
status: 400
message: The request was blocked by an input guardrail.
```

There is no new public error that reveals whether PII, prompt injection, or the
window limit caused the block. There is also no HTTP route; `status` remains
SDK error metadata.

## 15. Model Lifecycle, Caching, and Concurrency

### 15.1 Startup

`ModelGateway.create()` performs:

```text
load and validate policy
  -> determine whether any enabled PI rule exists
  -> resolve and verify artifact
  -> obtain/create shared classifier promise
  -> load tokenizer and CPU ONNX session
  -> validate graph names
  -> warm one window and validate logits
  -> construct ConfiguredGuardrailHub
  -> resolve gateway
```

The gateway never accepts a request before warm-up succeeds.

### 15.2 Shared model cache

Use a module-private map keyed by:

```text
canonical artifact root + runtime-manifest SHA-256 + selected backend
```

Store the in-flight load promise so concurrent gateway construction shares one
load. On rejection, remove the entry so an operator can repair the artifact and
retry construction. On success, retain the loaded immutable tokenizer/session.

Do not cache prompts, tokens, tensor feeds, scores, or decisions. Do not key the
cache by an unverified caller-provided path.

### 15.3 Runtime concurrency

The compatibility phase must verify concurrent `session.run()` calls under
both runtimes. If the chosen binding/session is not safely concurrent, put a
small module-private semaphore around session calls. Either way:

- input/output buffers remain request-local;
- maximum batch size remains eight;
- one request cannot consume more than 32 windows;
- no unbounded work queue is introduced; and
- cancellation is not claimed unless the chosen runtime genuinely cancels
  native execution.

Do not implement a cosmetic `Promise.race()` timeout that leaves expensive
native inference running in the background. If hard cancellation becomes an
operational requirement, isolate inference in a worker process/thread as a
later milestone.

### 15.4 Performance gates

Record, on the intended deployment class under both Bun and Node:

- cold artifact verification time;
- ONNX session load and warm-up time;
- warm p50/p95 for one window;
- warm p50/p95 for eight windows;
- 32-window worst-case time;
- idle RSS before/after model load;
- peak RSS during a 32-window request; and
- throughput/concurrency behavior.

Set an operational budget from measured results. The current FP32 model alone
is approximately 256 MiB, so deployment memory must be measured rather than
assumed.

## 16. Planned File Changes

### 16.1 Production code

| File                                                       | Planned change                                                                                     |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/guardrails/types.ts`                                  | Add detector-discriminated input rules and optional sanitized Layer 2 metadata                     |
| `src/guardrails/config/policy-loader.ts`                   | Parse strict PII and PI rule shapes; expose a helper to detect enabled PI rules                    |
| `src/guardrails/input/input-evaluator.ts`                  | Rename/focus current behavior as PII-only evaluation                                               |
| `src/guardrails/input/prompt-injection-classifier.ts`      | Define classifier, messages, result, identity, and backend contracts                               |
| `src/guardrails/input/prompt-injection-artifact.ts`        | Strictly load paths/JSON/hashes/config/threshold and produce an immutable artifact object          |
| `src/guardrails/input/prompt-injection-windowing.ts`       | Pure 254-token content slicing, overlap, padding, masks, and request-budget logic                  |
| `src/guardrails/input/onnx-prompt-injection-classifier.ts` | Dynamically load dependencies, create CPU session, build int64 tensors, score logits, and classify |
| `src/guardrails/guardrail-hub.ts`                          | Compose PII then PI and preserve PII-safe fail-open behavior                                       |
| `src/model-gateway.ts`                                     | Add model-path option; conditionally verify/load/warm and inject classifier                        |
| `src/pipeline/gateway-pipeline.ts`                         | Record optional detector metadata and partial fail-open without changing public errors             |
| `src/pipeline/lifecycle.ts`                                | Add optional sanitized detector/model/count metadata while preserving stages                       |
| `src/index.ts`                                             | Continue exporting public create options/types only; keep ML internals private                     |

### 16.2 Package, policy, and scripts

| File                                     | Planned change                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `package.json`                           | Advance SDK to `0.5.0`; add exact runtime dependency pins and scripts                                       |
| `bun.lock`                               | Lock native/runtime dependency graph                                                                        |
| `policies/example-policy.yaml`           | Add the user-role PI shadow rule after PII                                                                  |
| `scripts/seal-prompt-injection-model.ts` | Validate current bundle and atomically create runtime manifest                                              |
| `scripts/test-prompt-injection-model.ts` | Opt-in real-artifact token/parity/decision/latency check                                                    |
| `scripts/check-package.ts`               | Preserve import checks and add built Node inference check when an explicit artifact path is supplied        |
| `README.md`                              | Document local model setup, policy, shadow/enforce rollout, bounds, and limitations                         |
| `.gitignore`                             | Keep PyTorch checkpoints/training data out; do not accidentally ignore the intended sealed runtime manifest |

The 256 MiB ONNX file remains outside the `files` list of the SDK package. A
consumer supplies its deployment path explicitly.

### 16.3 Tests

| File                                        | Planned coverage                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tests/prompt-injection-policy.test.ts`     | Valid and invalid PI YAML plus unchanged PII YAML                                          |
| `tests/prompt-injection-artifact.test.ts`   | Strict schema, paths, size, hashes, threshold, labels, config, and quality flags           |
| `tests/prompt-injection-windowing.test.ts`  | Special tokens, overlap, padding, multiple messages, and 32-window limit                   |
| `tests/prompt-injection-classifier.test.ts` | Stable softmax, threshold equality, output validation, batching, collapse, and early stop  |
| `tests/guardrail-hub.test.ts`               | Ordered PII/PI composition, role/rule resolution, limit handling, and partial failure      |
| `tests/guardrail-pipeline.test.ts`          | Zero provider calls, generic errors, safe lifecycle/log metadata, and output regression    |
| `tests/model-gateway.test.ts`               | Conditional path requirement, eager warm-up, disabled/no-rule behavior, and cache behavior |
| `tests/sdk-entry.test.ts`                   | Import remains side-effect-free and no native/model load occurs on import                  |

## 17. Detailed Test Plan

### 17.1 Policy loader

Verify:

- every existing PII-only fixture still loads;
- a user-role PI `allow` rule loads;
- a user-role PI `block` rule loads;
- multiple non-overlapping role rules load;
- omitted/empty/duplicate/unknown roles fail;
- `redact`, `replacement`, or `entities` on PI fail;
- missing PII entities still fail;
- unknown detector/field fails;
- duplicate IDs across PII, PI, and output fail; and
- disabled policies still reject malformed PI rules.

### 17.2 Artifact loader/sealer

Use temporary small fixture files and injected session metadata to verify:

- the planning-time model snapshot seals successfully;
- threshold is read from the run manifest;
- threshold mismatch across metrics fails;
- missing/non-finite/out-of-range threshold fails;
- swapped or extra labels fail;
- non-full/incomplete/failed-quality candidate fails for enforcement;
- bad manifest JSON, missing field, and unknown field fail;
- changed file bytes fail checksum validation;
- absolute child paths, traversal, symlink escape, directory-as-file, and
  oversized files fail;
- unexpected graph input/output names fail;
- wrong warm-up shape/type/non-finite logits fail;
- no-rule and disabled-policy flows never touch artifact files; and
- failures never echo file contents or absolute paths publicly.

For shadow experimentation, it may be useful to inspect a quality-gate-failed
artifact offline. Keep that capability in the explicit developer script; the
normal gateway creation path uses the sealed approved candidate.

### 17.3 Windowing

Pure tests must cover:

- zero, one, 254, 255, and 444 content-token boundaries;
- exactly 50,000 selected UTF-16 code units are accepted and 50,001 are
  rejected before tokenization;
- every window begins with `101` and ends its real content with `102`;
- padding is `0` and attention masks match real positions;
- adjacent long windows share exactly 64 content tokens;
- the second window starts at content token 190;
- attacks represented by positive fake logits after token 256 are detected;
- separate messages do not blend token content;
- message index/role survive batching;
- budget is total across selected messages;
- exactly 32 windows are accepted and a required 33rd returns
  `limit_exceeded`; and
- unselected roles are never encoded.

### 17.4 Scoring/classifier

Use an injected backend to verify:

- stable softmax with very large positive/negative logits;
- non-finite logits fail;
- output batch length mismatch fails;
- output rows other than two logits fail;
- score below threshold allows;
- score exactly equal to `0.18499999999999997` detects;
- any positive window detects its message;
- repeated positive windows collapse to one finding;
- max eight windows reach one backend call;
- every selected window is evaluated when role-specific shadow/block rules may
  coexist; and
- no score, threshold, token, or content appears in thrown/logged values.

### 17.5 Hub and pipeline

Verify all combinations:

- PII block skips classifier and provider;
- PII redaction is what the fake classifier receives;
- benign PI result forwards the PII-safe request;
- shadow PI finding forwards the PII-safe request;
- blocking PI finding makes zero provider calls;
- a later block wins over an earlier shadow finding;
- first matching role rule resolves action;
- `limit_exceeded` blocks even with shadow action;
- Layer 2 fail-open preserves PII redaction;
- Layer 2 fail-closed makes zero provider calls;
- PII fail-open retains existing behavior;
- public errors remain generic;
- logs/lifecycle contain only allowed aggregate metadata;
- output validation and retry are unchanged;
- no-policy and disabled-policy stage sequences are unchanged; and
- custom `GuardrailHub` test implementations still compile.

### 17.6 Real-artifact parity corpus

Add a small checked-in synthetic corpus with no private or training rows. It
must include:

- ordinary short benign requests;
- legitimate uses of `ignore`;
- defensive discussion and quoted attacks;
- direct override attacks;
- non-`ignore` role/hierarchy/prompt-extraction attacks;
- Unicode, punctuation, newlines, and mixed casing;
- messages at window boundaries; and
- one multi-message request.

Generate reference tokenizer IDs and positive scores using Python ONNX Runtime
against the same `model.onnx`. The TypeScript real-artifact script must prove:

- tokenizer ID equality for every fixture;
- maximum Python/TypeScript score delta no more than `1e-5` for FP32;
- 100 percent allow/detect agreement at the artifact threshold;
- 100 percent Bun/Node decision agreement; and
- no network calls during load or inference.

Because current packaged reports do not contain PyTorch/ONNX parity, also run a
one-time release check against the retained `pytorch-model` before hard
enforcement. Record label agreement and maximum score delta in an as-built
report; do not make PyTorch a runtime dependency.

### 17.7 Package/runtime matrix

Run the same artifact under:

| Path                     | Required result                                  |
| ------------------------ | ------------------------------------------------ |
| Bun source               | Load, warm, and parity pass                      |
| Bun built package        | Import and inference pass                        |
| Node.js 20 built package | Import and inference pass                        |
| No-policy import         | No artifact read, network request, or model load |
| Offline execution        | Identical decisions without DNS/HTTP             |

The normal unit suite must not require the real model, Hugging Face access,
Kaggle, Python, or network access.

## 18. Implementation Phases

### Phase 0: Artifact and runtime feasibility

1. Install Bun 1.3+ in the implementation environment.
2. Create a temporary dependency spike with the exact candidate pins.
3. Load the current tokenizer/model and inspect ONNX session I/O.
4. Run benign/injection samples under Bun and Node.js 20.
5. Verify offline behavior and collect initial load/memory/latency numbers.
6. Select native ONNX Runtime or the tested WASM fallback.

Exit condition: one exact dependency pair runs the actual model offline under
both supported runtimes with matching results.

### Phase 1: Seal the actual model bundle

1. Implement strict artifact/report schemas and safe path helpers.
2. Implement the sealing script.
3. Recompute hashes and generate `guardrail-runtime-manifest.json`.
4. Inspect the ONNX model for external data and graph contract.
5. Build the synthetic parity corpus and Python reference results.
6. Record the provenance mismatch and licensing status separately.

Exit condition: the actual artifact is immutable-by-hash, self-contained, and
has one threshold source of truth.

### Phase 2: Policy and construction

1. Convert input rules to a detector union.
2. Implement strict PI rule parsing and tests.
3. Add `promptInjectionModelPath` to async construction.
4. Implement conditional model requirement/no-op behavior.
5. Add dynamic dependency loading and shared load-promise cache.

Exit condition: valid configuration eagerly loads one classifier; all legacy
configurations behave as before.

### Phase 3: Classifier core

1. Implement pure window construction.
2. Implement local tokenizer adapter.
3. Implement ONNX tensor construction and session adapter.
4. Implement stable softmax and artifact threshold comparison.
5. Implement batching, message finding collapse, and limits.
6. Run unit and real-artifact parity tests.

Exit condition: TypeScript decisions match the Python reference and long input
cannot bypass or unboundedly consume the classifier.

### Phase 4: Guardrail composition

1. Refactor existing input evaluation into the PII-only boundary.
2. Compose PII then PI in `ConfiguredGuardrailHub`.
3. Implement first matching role-rule resolution.
4. Implement deterministic limit blocks.
5. Implement safe Layer 2 fail-open without undoing PII.
6. Add sanitized detector metadata to pipeline/lifecycle handling.

Exit condition: blocked injections make zero provider calls and every PII/PI
combination passes the behavior matrix.

### Phase 5: Documentation and complete verification

1. Update the example policy in shadow mode.
2. Document model placement and `promptInjectionModelPath`.
3. Add real-artifact and performance scripts.
4. Run all existing and new Bun tests.
5. Run type, build, package, Bun, Node, side-effect, and offline checks.
6. Record actual dependencies, graph metadata, parity, latency, and memory in an
   as-built follow-up section or spec.

Exit condition: the SDK is technically ready for shadow deployment.

### Phase 6: Shadow-to-enforcement rollout

1. Deploy `action: allow` with sanitized aggregate metrics only.
2. Collect a representative, privacy-reviewed sample of suspected false
   positives/negatives outside ordinary logs.
3. Review legitimate `ignore`, security discussion, quoted text, long input,
   and the application domains resembling the weak Rogue source slice.
4. Establish traffic-specific false-positive and false-negative acceptance
   gates before looking at enforcement results.
5. Resolve provenance/license approval for the intended deployment.
6. Change only the YAML action to `block`; do not alter the artifact threshold.
7. Monitor block rate, Layer 2 failure rate, p95 latency, and memory.
8. Roll back to `allow` if the predeclared operational/quality gates fail.

Exit condition: hard blocking is enabled only with traffic evidence and an
approved artifact, while the same calibrated threshold remains in use.

## 19. Verification Commands

Expected commands after implementation, from `apps/gateway`:

```bash
bun run seal:prompt-injection-model -- ../model
bun test
bun run check-types
bun run test:pipeline
bun run test:guardrails
bun run build
PROMPT_INJECTION_MODEL_PATH=../model bun run test:prompt-injection-model
bun run check:package
```

The built Node.js 20 real-artifact check must also be an explicit part of
`test:prompt-injection-model` or `check:package`; it must not be inferred from a
Bun-only success.

## 20. Acceptance Criteria

Layer 2 is complete only when all of the following are true:

1. `ModelGateway.create()` accepts an explicit local artifact root.
2. An enabled PI rule requires a valid sealed artifact and warms it before
   construction resolves.
3. No-policy, disabled-policy, and PII-only configurations do not import the
   inference runtime or touch model files.
4. The exact threshold comes from `apps/model/run-manifest.json`; no code or
   YAML fallback uses `0.5`.
5. Class index 1 is verified as `PROMPT_INJECTION` before inference.
6. TypeScript tokenizer output and scores meet parity with Python ONNX Runtime.
7. PII always runs before Layer 2, and Layer 2 sees PII-redacted text.
8. A PII block skips both classifier and provider.
9. A blocking PI finding makes zero provider calls.
10. Shadow PI findings allow only the PII-safe request.
11. Layer 2 fail-open cannot restore unredacted PII.
12. Layer 2 fail-closed returns the current generic evaluation error.
13. Long selected input is covered by overlapping windows, bounded at 50,000
    UTF-16 code units and 32 windows, and exceeding either limit blocks.
14. Threshold equality is classified as injection.
15. Raw prompts, redacted prompts, tokens, logits, scores, thresholds, and
    native error strings are absent from logs, lifecycle events, results, and
    public errors.
16. Existing PII, output validation/retry, provider, no-policy, and custom hub
    tests remain green.
17. The SDK entry stays side-effect-free.
18. The ONNX model remains outside the published SDK package.
19. Real artifact inference passes in Bun 1.3+ and built ESM in Node.js 20+
    with network access disabled.
20. Cold/warm latency and memory measurements are recorded.
21. Shadow rollout is completed before the example/action is promoted to
    `block` in a production policy.
22. Provenance and license review is complete before public redistribution or
    commercial production use.

## 21. Principal Risks and Mitigations

| Risk                                       | Mitigation                                                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Wrong threshold                            | Parse the hashed run manifest and cross-check both metrics files; never default to `0.5`                                                  |
| Swapped labels                             | Require config mappings `0 BENIGN`, `1 PROMPT_INJECTION` and two-logit output                                                             |
| Tokenizer mismatch                         | Use exported tokenizer JSON/config and require Python/TypeScript token-ID parity                                                          |
| Injection after token 256                  | Use complete bounded overlapping windows                                                                                                  |
| CPU/memory denial of service               | Check a 50,000-code-unit limit before tokenization, limit to 32 windows and batches of eight, measure concurrency/RSS, and block overflow |
| Layer 2 fail-open leaks original PII       | Catch classifier-only failures inside the hub and return the completed PII-safe request                                                   |
| Native runtime fails in Bun                | Make Phase 0 a gate and test the one explicit WASM fallback if needed                                                                     |
| Runtime attempts a download                | Use direct local JSON/model paths and test with outbound access disabled                                                                  |
| Corrupt or substituted artifact            | Strict paths, bounds, graph checks, hashes, warm-up; signed manifests remain a future hardening step                                      |
| Model false positives                      | Shadow rollout; pay special attention to the Rogue slice and quoted/security prompts                                                      |
| Model becomes sole defense                 | Retain authorization, least privilege, tool isolation, PII and output guardrails                                                          |
| Large package/install footprint            | Dynamically import the runtime and keep weights external; document supported native platforms                                             |
| Cold first request                         | Verify/load/warm during async gateway construction                                                                                        |
| Multiple gateway instances multiply memory | Cache one load promise per canonical, hashed artifact identity                                                                            |
| Logs help attackers tune prompts           | Emit only aggregate decisions/counts and artifact ID, never scores/threshold                                                              |
| License/provenance is incomplete           | Keep artifact private/local and gate redistribution/enforcement approval separately                                                       |

## 22. Deferred Work

- INT8 quantization and a newly calibrated/parity-checked quantized artifact;
- signed runtime manifests and central artifact distribution;
- hard-cancellable worker isolation and inference timeouts;
- per-tenant or policy-version threshold overrides;
- model hot reload;
- multilingual classifiers;
- RAG document and tool-result scanning;
- output prompt-injection classification;
- structured/tool-call and multimodal message parts;
- dedicated content-safety classification;
- active learning from manually reviewed production errors; and
- ensembles or heuristic/model voting.

## 23. Reference Notes

Technical choices should be rechecked when Phase 0 begins. Relevant primary
references are:

- [ONNX Runtime Node.js binding](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [ONNX Runtime JavaScript API](https://onnxruntime.ai/docs/api/js/index.html)
- [Hugging Face Tokenizers.js](https://github.com/huggingface/tokenizers.js)
- [Transformers.js local/offline environment controls](https://huggingface.co/docs/transformers.js/main/api/env)

The runtime plan intentionally uses direct local files, so no Hugging Face
account, token, endpoint, or internet connection is needed in the gateway.
