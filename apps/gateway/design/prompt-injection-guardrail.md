# Prompt-Injection Guardrail Design

## Purpose

The prompt-injection guardrail classifies selected chat messages with a local
ONNX model before the gateway calls the model provider. Policy determines
whether a detected message is observed in shadow mode or blocks the request.

This document describes the implemented runtime, artifact trust checks,
windowing algorithm, policy behavior, failure handling, and test boundaries.

## Design goals

The implementation is designed to:

- run inference locally without sending prompts to another detection service;
- load only a sealed and internally consistent model artifact;
- classify long messages with deterministic overlapping token windows;
- use the evaluation threshold approved with the model artifact;
- support shadow and enforcing rollout modes;
- combine predictably with PII redaction;
- keep model and finding details sanitized in public errors; and
- bound request size, window count, and inference batch size.

The following are not goals:

- proving that a prompt is safe;
- understanding application-specific authorization intent;
- scanning model output or tool results;
- preventing a permitted tool from causing side effects;
- downloading or updating model weights at runtime;
- supporting browser or edge runtimes; or
- replacing application-level least privilege and human approval.

## Position in the request flow

Prompt-injection evaluation is one part of the input-guardrail stage:

```text
ChatInput
  -> request normalization
  -> input evaluation coordinator
       -> PII detector
       -> prompt-injection classifier
       -> cumulative input decision
  -> tool-definition filtering
  -> model provider
```

The classifier never modifies text. It returns an allow, detected, or
limit-exceeded classification. The input coordinator combines that result with
PII behavior and decides whether the provider can be called.

## Construction and deployment contract

An enabled prompt-injection rule requires a model artifact path:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "model-name",
  policyPath: "./policies/prompt-injection-enforce-policy.yaml",
  promptInjectionModelPath: "../model",
});
```

Construction rules are:

- an enabled policy containing a `prompt_injection` rule requires
  `promptInjectionModelPath`;
- supplying a model path without an enabled prompt-injection rule is rejected,
  except when the loaded policy itself is disabled;
- a disabled policy is validated but does not load the classifier or attach a
  guardrail hub; and
- loading or initializing an invalid artifact fails startup.

The ONNX weights are not bundled in the gateway package. They must be deployed
and sealed separately.

## Policy contract

A prompt-injection rule is an item in `input` with
`detector: prompt_injection`.

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: prompt-injection-enforcement
  version: 1

defaults:
  input_action: allow
  input_execution_mode: sequential
  runtime_failure_mode: closed

input:
  - id: block-user-prompt-injection
    description: Block classifier findings in user messages.
    detector: prompt_injection
    roles:
      - user
    action:
      type: block
```

### Rule fields

- `id` is required and globally unique across the whole policy.
- `description` is optional and limited to 2,000 characters.
- `roles` is required and contains one or more unique chat roles.
- `action.type` is either `allow` or `block`.

Unlike PII rules, prompt-injection rules do not accept `redact`, `entities`, a
replacement string, or a policy-defined threshold. The classification
threshold belongs to the sealed model artifact so runtime policy cannot drift
away from the evaluated model configuration.

### Shadow mode

`action.type: allow` still runs the classifier and records sanitized finding
metadata, but it permits the request to continue. This is the intended mode for
measuring behavior before enforcement.

### Role selection and rule order

The evaluator builds the union of roles across all prompt-injection rules and
classifies every string message with one of those roles. A finding is then
resolved to the first rule in policy order that includes the message role.

If any resolved finding uses `block`, the whole request is blocked. Otherwise,
the finding is allowed in shadow mode.

Because resolution is first-match by role, put narrower or exceptional rules
before broader overlapping rules.

## Artifact trust model

The runtime does not load an arbitrary ONNX directory directly. It requires a
`guardrail-runtime-manifest.json` produced by the sealing command:

```bash
bun run seal:prompt-injection-model -- ../model
```

Sealing inspects the training outputs and writes a manifest containing:

- a schema version and artifact ID;
- fixed payload filenames;
- model labels and the positive label ID;
- the score function and threshold source;
- tokenizer, window, and batch limits;
- expected ONNX input and output names; and
- a SHA-256 digest for every required payload.

The artifact ID includes the first twelve hexadecimal characters of the ONNX
model digest. This provides a stable, non-secret identifier for logs and
lifecycle metadata.

### Startup validation

The loader validates all of the following before inference is available:

- the configured path resolves to a directory;
- required paths stay inside that directory after resolving symbolic links;
- payloads are regular files and remain under per-file size limits;
- the ONNX directory contains exactly the expected files;
- the runtime manifest has only the supported fields and exact constant values;
- every payload checksum matches the manifest;
- the artifact ID matches the model checksum;
- the training run is an approved, complete, full candidate;
- quality gates passed;
- run, metrics, and validation reports agree on the threshold;
- model labels are `BENIGN` and `PROMPT_INJECTION`;
- the architecture and tokenizer are compatible with the runtime; and
- token IDs and model tensor shapes satisfy the expected contract.

External paths, unexpected sidecars, oversized payloads, checksum changes, and
report disagreements are startup configuration failures.

## Model initialization

The runtime uses `@huggingface/tokenizers` and `onnxruntime-node`. It creates a
CPU inference session with graph optimizations enabled and expects:

```text
inputs:  input_ids, attention_mask
output:  logits
shape:   [batch, 2]
type:    float32
```

Initialization runs one empty-message warm-up window and validates the returned
logits. A model that cannot pass warm-up is not installed in the gateway.

Classifier loads are cached by resolved model path, runtime-manifest hash, and
runtime adapter. Concurrent gateway construction for the same artifact shares
one loading promise. A failed load is removed from the cache so a later attempt
can retry after the deployment is corrected.

## Message selection

The evaluator selects messages whose role appears in at least one configured
rule and whose `content` is a string. It preserves:

- original message index;
- original message role; and
- complete string content.

Assistant messages with null content are skipped. Tool-result text can be
classified when a policy explicitly includes the `tool` role.

No chat content is added to the model input besides the selected message text.
Messages remain separate through tokenization and windowing.

## Tokenization and windowing

The model accepts 256 tokens per row. Two positions are reserved for `[CLS]`
and `[SEP]`, leaving 254 content tokens.

For each selected message:

1. Tokenize content without adding special tokens.
2. Take up to 254 content tokens.
3. Add `[CLS]` at the beginning and `[SEP]` at the end.
4. Pad to 256 tokens with `[PAD]`.
5. Build a matching attention mask.
6. Advance 190 content tokens and create the next window when needed.

The 190-token advance produces a 64-token overlap. Overlap reduces the chance
that an injection spanning a window boundary is missed.

Even an empty message produces one valid window. Windows from different
messages are never combined, and every window retains its source message index
and role.

### Request limits

The following constants are part of the sealed artifact contract:

- maximum selected input: 50,000 UTF-16 code units;
- maximum windows per request: 32;
- maximum windows per inference batch: 8;
- maximum tokens per window: 256; and
- overlap: 64 content tokens.

Input over 50,000 selected code units is rejected before tokenization. A
request requiring a 33rd window returns `limit_exceeded`.

`limit_exceeded` becomes a block decision even when configured rules are in
shadow mode. This is a fail-closed resource bound, not a positive model
finding.

## Inference and scoring

Windows are processed in stable order in batches of at most eight. The backend
must return exactly one pair of finite logits for every input window.

The positive probability is calculated with numerically stable softmax:

```text
injection_probability = exp(injection - max) /
                        (exp(benign - max) + exp(injection - max))
```

A window is positive when its probability is greater than or equal to the
artifact threshold. Threshold equality is intentionally classified as a
detection.

Multiple positive windows for one message collapse into one finding. The
classifier does not return scores or raw text through the guardrail result.

Malformed token IDs, partial batches, non-finite logits, unexpected output
rows, or incompatible tensors are runtime failures rather than benign
classifications.

## Input execution modes

The policy controls scheduling with `defaults.input_execution_mode`.

### Sequential mode

Sequential mode is the default:

```text
PII on normalized request
  -> stop if PII blocks
  -> prompt-injection inference on the PII-sanitized request
  -> combine decisions
```

This mode minimizes exposure inside the process because the classifier normally
sees redacted text. It also avoids inference work when PII already blocks the
request.

### Parallel mode

Parallel mode is explicit:

```text
PII on normalized request -------------------+
                                              +-> combine decisions
prompt-injection inference on raw request ----+
```

Both started evaluations are settled. The classifier sees pre-redaction text,
but the provider still receives the PII-redacted request when the cumulative
decision allows continuation.

The policy loader rejects `parallel` mode when no prompt-injection rule exists,
because parallel scheduling would otherwise have no useful meaning.

## Cumulative decision behavior

The input coordinator applies these rules:

- a block from PII or prompt injection blocks the entire request;
- PII redaction is preserved when prompt injection allows;
- a shadow-mode prompt-injection finding does not undo PII redaction;
- finding counts are added across evaluated detectors;
- rule IDs are returned in original policy order; and
- classifier and detector metadata are sanitized before leaving the hub.

A successful classification with no positive windows returns allow with zero
prompt-injection findings and no prompt-injection rule IDs.

## Runtime failures

`defaults.runtime_failure_mode` controls unexpected inference and detector
failures.

In `closed` mode, a detector failure causes
`GUARDRAIL_EVALUATION_FAILED` with status 500 unless another detector already
produced a valid block. A valid security block remains authoritative.

In `open` mode, the gateway records sanitized failure metadata and continues
with the successful peer result. For example, PII redaction remains in place if
prompt-injection inference fails.

The gateway does not include exception text, logits, prompt content, or model
paths in public errors and guardrail decision logs.

## Public block behavior

An enforced finding becomes the shared input error:

```text
code: INPUT_GUARDRAIL_BLOCKED
status: 400
message: The request was blocked by an input guardrail.
```

The error deliberately does not reveal whether PII, prompt injection, or both
caused the block.

## Observability

On successful model loading, the logger emits
`gateway.prompt_injection_model_loaded` with the non-secret artifact ID.

The shared input completion metadata can include:

- `decision`;
- `findingCount`;
- `ruleIds`;
- `detectorTypes`;
- `failedDetectorTypes`;
- `promptInjectionModelId`;
- `evaluatedMessageCount`;
- `evaluatedWindowCount`; and
- `inputExecutionMode`.

The artifact ID is useful for connecting production behavior to one sealed
model. The runtime-manifest hash is kept in the classifier identity but is not
currently added to lifecycle metadata.

No inference score, token, prompt content, or raw finding is logged by the
guardrail implementation.

## Security properties

The important invariants are:

- classification runs before the provider call;
- enforcing findings prevent provider execution;
- model files are checksum-verified before use;
- threshold and model identity cannot be silently changed by YAML policy;
- external artifact references and unexpected ONNX files are rejected;
- inference work is bounded by input, window, and batch limits;
- result metadata cannot reconstruct the prompt; and
- a classifier allow decision is not treated as authorization for tools or
  application actions.

The model is one detection layer. A sufficiently novel, obfuscated, or
domain-specific attack may still be classified as benign.

## Testing

From `apps/gateway`:

```bash
bun test tests/prompt-injection-artifact.test.ts
bun test tests/prompt-injection-windowing.test.ts
bun test tests/prompt-injection-classifier.test.ts
bun test tests/prompt-injection-policy.test.ts
bun test tests/input-evaluation-coordinator.test.ts
bun test tests/guardrail-pipeline.test.ts
bun run smoke:layer2 -- ../model
bun run smoke:prompt-injection -- pi-only
```

The deterministic tests should cover:

- manifest sealing and checksum verification;
- changed payloads and malformed manifests;
- report and threshold disagreement;
- exact tokenizer and ONNX contracts;
- 64-token overlap, padding, and attention masks;
- the 50,000-code-unit and 32-window boundaries;
- batch sizes of eight;
- stable softmax and threshold equality;
- deduplication of positive windows by message;
- shadow and block policy actions;
- sequential and parallel composition with PII; and
- fail-open and fail-closed inference errors.

Manual smoke testing uses a real configured provider. It should not replace the
deterministic fake-provider and fake-backend coverage.

## Main implementation files

- `src/guardrails/input/prompt-injection-artifact.ts`: sealing, loading,
  integrity checks, and threshold loading.
- `src/guardrails/input/prompt-injection-windowing.ts`: token window and budget
  rules.
- `src/guardrails/input/prompt-injection-classifier.ts`: provider-neutral
  classifier contract.
- `src/guardrails/input/onnx-prompt-injection-classifier.ts`: tokenizer and ONNX
  adapter, batching, scoring, warm-up, and caching.
- `src/guardrails/input/prompt-injection-evaluator.ts`: role selection and
  policy resolution.
- `src/guardrails/input/input-evaluation-coordinator.ts`: scheduling and
  cumulative decisions.
- `src/model-gateway.ts`: construction and model-path requirements.
- `src/pipeline/gateway-pipeline.ts`: provider blocking, errors, logs, and
  lifecycle stages.

The implementation rationale is recorded in
`specs/11_layer2_local_inference_implement.md`,
`specs/13_layer_2_implement.md`, and `specs/15_parallel_implement.md`.

## Known limitations

- The classifier is only as strong as its training data and approved threshold.
- Selected messages are classified independently; cross-message attack context
  is not modeled as one sequence.
- Parallel mode exposes unredacted selected text to the local classifier.
- The runtime supports server-side platforms compatible with
  `onnxruntime-node`, not browser or edge environments.
- Artifacts and policies are loaded at gateway construction and do not hot
  reload.
- The guardrail does not inspect model output, retrieved documents, images, or
  tool results unless those results later appear as selected text in a new
  request.
- A shadow-mode finding is deliberately allowed to reach the provider.

Production rollout should begin in shadow mode, compare false positives and
false negatives on representative traffic, then move selected roles to block
only after the artifact and threshold are accepted for that deployment.
