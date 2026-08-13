# Parallel Input Guardrail Evaluation: Implementation Plan

## 1. Purpose and Status

This document is the implementation plan for the request in
`apps/gateway/specs/14_parallel.md`: allow Layer 1 PII evaluation and Layer 2
prompt-injection evaluation to overlap, then decide the request from their
cumulative results.

Implementation status (August 13, 2026): the opt-in parallel coordinator,
strict policy mode, cumulative result handling, updated smoke paths, and an
initial local benchmark command are implemented. Sequential remains the
default. Final deployment-class performance measurements and rollout approval
remain operational work rather than SDK code changes.

The intended parallel request path is:

```text
normalized ChatRequest
  |-- start local prompt-injection evaluation on selected original messages
  |-- evaluate PII on the same immutable normalized request
  `-- wait for every started detector
          -> combine successful findings and detector failures
          -> block, redact, or allow
          -> call the provider only for allow/redact
```

This plan deliberately keeps the existing sequential PII-first behavior as the
default. Parallel evaluation is an explicit policy choice because it changes
what text the local classifier sees: sequential mode classifies PII-redacted
text, while parallel mode must classify the original normalized text to remove
the data dependency between the two detectors.

The plan supersedes the PII-first ordering requirements in Sections 5, 13, 17,
18, and 20 of `13_layer_2_implement.md` only when a policy explicitly selects
parallel input execution. Sequential mode continues to follow the existing
Layer 2 specification exactly.

## 2. Audited Repository Baseline

### 2.1 Current input flow

`ConfiguredGuardrailHub.evaluateInput()` currently performs these operations:

1. call synchronous `evaluatePiiInput(request, policy)`;
2. return immediately when PII blocks;
3. retain the original or PII-redacted safe request;
4. select roles covered by prompt-injection rules;
5. classify selected messages from the PII-safe request;
6. resolve positive messages through the first matching PI rule; and
7. return the PII-safe request unless either layer blocks.

This provides two intentional guarantees:

- a PII block avoids all ONNX work; and
- raw detected PII does not enter Layer 2 tokenizer or inference tensors.

Both guarantees change in parallel mode. They must not be lost silently.

### 2.2 Current execution characteristics

The two detector implementations do not have identical concurrency behavior:

- PII matching, structural validation, rule resolution, and redaction are
  synchronous TypeScript work on the JavaScript thread.
- Prompt tokenization, window construction, and tensor construction are also
  synchronous TypeScript/native-binding work until the first
  `InferenceSession.run()` call.
- ONNX execution returns a promise and performs the expensive inference work in
  the native runtime.
- A request may perform up to four sequential ONNX calls because 32 windows are
  processed in batches of eight.

The PII branch runs for every configured hub, even when there is no explicit
PII rule, because `defaults.input_action` resolves unmatched PII findings.

Consequently, changing the code to a visually symmetric `Promise.all()` does
not make all detector work CPU-parallel. The useful overlap available without
workers is:

```text
Layer 2 tokenization/tensor setup
  -> start native ONNX batch
       |-- native inference continues
       `-- JavaScript performs PII detection and redaction
```

The implementation must start the prompt-injection task first, allow it to
reach the first native `session.run()`, and schedule PII work immediately after
that. Starting synchronous PII first would preserve the current critical path
and provide no latency reduction.

### 2.3 Current policy contract

The loaded policy defaults currently contain:

```ts
interface PolicyDefaults {
  inputAction: "allow" | "redact" | "block";
  runtimeFailureMode: "open" | "closed";
  maximumRetries: number;
}
```

There is no input execution-mode setting. Unknown default fields are rejected.
Prompt-injection rules already contain all information required for cumulative
resolution: roles and an `allow` or `block` action.

### 2.4 Current failure handling

Layer 2 catches classifier failures inside the hub after PII succeeds:

- closed mode rethrows and the pipeline returns the generic
  `GUARDRAIL_EVALUATION_FAILED` error;
- open mode returns the completed PII result, preserving redaction; and
- `failedDetectorTypes` records the sanitized detector identity.

The outer pipeline still owns generic fail-open/fail-closed behavior for a
whole-hub failure. Parallel execution requires detector-specific settlement so
one rejection does not discard a successful result from the other detector.

### 2.5 Contracts that remain stable

The following behavior must not change:

- `gateway.chat.completions.create()` remains the only operation;
- the SDK remains in-process and starts no HTTP server;
- model loading remains eager during `ModelGateway.create()`;
- no-policy, disabled-policy, and PII-only construction avoid inference work;
- input validation occurs before guardrails;
- output validation and retry remain sequential and unchanged;
- caller input is never mutated;
- provider calls occur only after the cumulative input decision allows them;
- public block and evaluation errors stay generic;
- prompts, PII, tokens, logits, scores, and thresholds are not logged;
- the ONNX threshold and model contract are unchanged; and
- Bun source and Node.js 20+ built-package support remain required.

## 3. Key Design Decision

### 3.1 Parallel mode is explicit and opt-in

Add one default-policy setting:

```yaml
defaults:
  input_execution_mode: parallel
```

Supported values are:

```text
sequential
parallel
```

The omitted-field default is `sequential`.

This preserves all existing policies and callers. It also makes the privacy
tradeoff visible in the configuration review instead of changing the meaning
of every existing PII-redaction policy.

### 3.2 Classifier input by mode

| Mode         | PII input          | PI classifier input                   |
| ------------ | ------------------ | ------------------------------------- |
| `sequential` | normalized request | PII-safe request after redaction      |
| `parallel`   | normalized request | original normalized selected messages |

The provider still receives the PII-safe request in both modes when the final
decision allows dispatch.

Parallel mode therefore permits raw PII to exist temporarily in local
tokenizer output and ONNX input tensors. It does not send that PII to a remote
service, write it to disk, cache it, or expose it through logs. This is still a
material privacy difference: JavaScript and native process memory are not
guaranteed to be securely zeroed after garbage collection.

An environment that requires raw PII never to enter model memory must use
`sequential` mode. There is no honest way to preserve the dependency “redact
before classification” while also evaluating both independent results in
parallel.

### 3.3 Why no speculative dual classification

Do not classify raw text in parallel and then classify redacted text again when
PII is found. That approach:

- doubles ONNX work on PII-bearing requests;
- creates inconsistent latency and capacity behavior;
- complicates which result is authoritative;
- does not remove raw PII from the first inference; and
- increases denial-of-service exposure.

Each selected message is classified once per request.

### 3.4 Performance gate before rollout

PII evaluation is expected to be much cheaper than ONNX inference, so the
actual latency saving may be small. Phase 0 must measure the existing
sequential critical path and a controlled prototype before the parallel mode
is enabled in any default or production policy.

The feature may be implemented as an opt-in capability even when savings are
modest, but it must not become the default unless all of these hold on intended
deployment hardware:

- parallel p95 input-guardrail latency is no worse than sequential p95;
- the improvement is larger than benchmark noise in repeated runs;
- CPU and RSS do not regress beyond the agreed deployment budget;
- no-PII decisions have 100 percent sequential/parallel agreement; and
- PII-bearing decision differences are reviewed and accepted explicitly.

## 4. Scope

### 4.1 Goals

1. Add an opt-in parallel execution mode to strict policy loading.
2. Preserve sequential mode as the compatibility and privacy default.
3. Start Layer 2 before synchronous PII work so native inference can overlap it.
4. Wait for every detector that was started; leave no unobserved promise or
   background inference from an early return.
5. Combine PII and prompt-injection outcomes deterministically.
6. Block when either successful detector resolves to block.
7. Keep PII redaction authoritative for the provider request.
8. Preserve first-matching-rule behavior within each detector type.
9. Preserve shadow-mode prompt-injection findings without letting them undo a
   PII block or redaction.
10. Handle each detector failure independently under the existing global
    runtime failure mode.
11. Make a known deterministic block dominate a peer detector failure.
12. Keep result ordering independent of task completion order.
13. Add sanitized execution-mode and detector-failure observability.
14. Add deterministic concurrency, aggregation, failure, smoke, and benchmark
    coverage.
15. Avoid new runtime dependencies and avoid worker-thread complexity in the
    first implementation.

### 4.2 Non-goals

- running output guardrails in parallel with the provider;
- parallelizing multiple windows from one request beyond existing ONNX batch
  behavior;
- starting multiple ONNX sessions per artifact;
- adding a remote classifier or Python runtime service;
- adding hard cancellation that ONNX Runtime does not currently expose through
  this gateway abstraction;
- implementing per-detector failure modes;
- combining PII and PI into one numeric risk score;
- changing the calibrated PI threshold;
- changing PII patterns or entity validation;
- changing prompt-injection window limits or batching;
- adding an HTTP endpoint;
- caching prompt, token, tensor, score, or decision data; or
- making parallel mode the default without the rollout gates in this plan.

## 5. Policy Contract

### 5.1 Type addition

Add:

```ts
export type InputExecutionMode = "sequential" | "parallel";

export interface PolicyDefaults {
  inputAction: InputActionType;
  inputExecutionMode: InputExecutionMode;
  runtimeFailureMode: RuntimeFailureMode;
  maximumRetries: number;
}
```

Export `InputExecutionMode` from `src/index.ts` because policy configuration is
part of the SDK-facing contract.

### 5.2 YAML shape

Sequential compatibility mode:

```yaml
defaults:
  input_action: allow
  input_execution_mode: sequential
  runtime_failure_mode: closed
  maximum_retries: 1
```

Parallel mode:

```yaml
defaults:
  input_action: allow
  input_execution_mode: parallel
  runtime_failure_mode: closed
  maximum_retries: 1
```

No rule-level concurrency field is added. Rules continue to describe policy
actions, while the defaults block describes orchestration behavior.

### 5.3 Strict parsing

`parseDefaults()` must:

- add `input_execution_mode` to its allowed fields;
- accept exactly `sequential` or `parallel`;
- normalize omission to `sequential`;
- reject booleans, capitalization variants, and unknown values;
- validate the field even when `enabled: false`; and
- retain all existing default validation.

The loader should reject `input_execution_mode: parallel` when the policy has
no `prompt_injection` rule. That configuration cannot perform parallel detector
work and would otherwise create a misleading operational state.

The loader must not add:

- a model path;
- a threshold;
- a worker count;
- a timeout;
- a per-rule mode; or
- a promise/concurrency limit.

### 5.4 API version

Keep `apiVersion: guardrails/v1`. This is an optional additive field whose
omitted behavior is exactly the existing execution order. A future policy
version is unnecessary for this backward-compatible addition.

### 5.5 Checked-in policies

Planned policy behavior is:

| Policy file                                     | Planned mode | Reason                                       |
| ----------------------------------------------- | ------------ | -------------------------------------------- |
| `policies/pii-policy.yaml`                      | omitted      | PII-only; no parallel work exists            |
| `policies/example-policy.yaml`                  | sequential   | Preserve safe default and documented rollout |
| `policies/prompt-injection-enforce-policy.yaml` | parallel     | Exercise cumulative enforcement in smoke     |

The example can be promoted to parallel only after benchmark and shadow gates.

## 6. Detector Boundaries

### 6.1 Keep PII evaluation focused

`evaluatePiiInput()` remains the Layer 1 implementation and continues to
return:

- `allow` with the normalized request;
- `redact` with a newly constructed safe request; or
- `block` without a request.

It remains synchronous and must not mutate its input.

### 6.2 Extract prompt-injection policy evaluation

The current hub contains message selection, classifier validation, rule
resolution, limit handling, and metadata construction. Extract that behavior
into a focused internal module:

```text
src/guardrails/input/prompt-injection-evaluator.ts
```

Suggested internal result:

```ts
export type PromptInjectionInputResult =
  | { status: "skipped" }
  | {
      status: "evaluated";
      decision: "allow" | "block";
      findingCount: number;
      ruleIds: string[];
      promptInjectionModelId: string;
      evaluatedMessageCount: number;
      evaluatedWindowCount: number;
    };
```

The evaluator must:

1. receive the request selected by the coordinator;
2. derive the union of PI rule roles;
3. preserve original message indexes;
4. return `skipped` when no message has a selected role;
5. call the injected classifier once;
6. validate findings against selected message index/role pairs;
7. reject duplicate or unknown findings;
8. resolve each finding through the first matching PI rule;
9. treat any matching `block` action as block;
10. treat all matching `allow` actions as shadow findings;
11. convert `limit_exceeded` to a deterministic block; and
12. return no content, score, token, window offset, or threshold.

The evaluator does not catch runtime failures and does not know whether it is
running sequentially or in parallel. The coordinator owns those concerns.

### 6.3 Pure cumulative combiner

Add a small pure combiner, either in the new evaluator module or an internal
`input-evaluation-coordinator.ts`. It receives settled detector outcomes and
returns one `InputGuardrailResult`.

The combiner must not depend on promise completion order. It must derive:

- overall decision;
- provider-safe request;
- total finding count from successful detectors;
- rule IDs in original policy order;
- PII entity types;
- canonical detector ordering;
- failed detector types;
- PI artifact identity and aggregate evaluated counts; and
- execution mode.

Keeping combination pure allows the complete truth table to be tested without
loading the real model or depending on timing.

## 7. Execution Algorithms

### 7.1 Sequential mode

Preserve current behavior exactly:

```text
PII evaluate original request
  |-- PII block -> return block; PI is skipped
  `-- PII allow/redact
        -> PI evaluates PII-safe selected messages
        -> combine
```

Sequential mode retains these important semantics:

- PII block short-circuit;
- PI never sees detected raw PII after successful redaction;
- PI failure-open returns the completed PII-safe result; and
- existing tests remain valid.

The extraction of the PI evaluator must not alter sequential output metadata,
rule order, role resolution, limits, or public errors.

### 7.2 Parallel mode

Parallel mode uses the original normalized request for both detectors:

```text
select PI messages from original request
  -> start PI evaluation immediately
       -> tokenize, window, build first batch, start native session.run()
  -> schedule PII evaluation on next microtask
  -> await both settled outcomes
  -> combine
```

Illustrative implementation shape:

```ts
type SettledDetector<T> =
  { status: "fulfilled"; value: T } | { status: "rejected" };

async function settle<T>(promise: Promise<T>): Promise<SettledDetector<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch {
    return { status: "rejected" };
  }
}

function settlePii(
  evaluate: () => InputGuardrailResult,
): Promise<SettledDetector<InputGuardrailResult>> {
  return Promise.resolve().then(() => {
    try {
      return { status: "fulfilled", value: evaluate() } as const;
    } catch {
      return { status: "rejected" } as const;
    }
  });
}

const promptInjectionTask = settle(
  evaluatePromptInjectionInput(request, rules, classifier),
);
const piiTask = settlePii(() => evaluatePiiInput(request, policy));

const [piOutcome, piiOutcome] = await Promise.all([
  promptInjectionTask,
  piiTask,
]);

return combineInputOutcomes(request, policy, piiOutcome, piOutcome);
```

The creation order is intentional. Calling the synchronous PII evaluator
before constructing `promptInjectionTask` would reproduce the current latency
dependency.

The exact implementation may use `Promise.allSettled()`, but it must normalize
results into a small detector-outcome type before aggregation. It must not use
a bare `Promise.all()` that rejects early and loses the peer detector result.

### 7.3 Always settle started work

Once PI inference starts, the hub must await its settlement even if PII has
already blocked. The initial implementation must not:

- return early while native inference continues;
- discard a rejecting promise;
- claim cancellation that did not occur;
- use `Promise.race()` as a cosmetic timeout; or
- start a replacement ONNX request.

This means a PII-blocked request is intentionally slower and more expensive in
parallel mode than in sequential mode. That cost is part of obtaining complete
cumulative results and must be included in benchmarks and capacity planning.

### 7.4 Detector applicability

Do not start PI when:

- the policy has no PI rules;
- no request message role appears in a PI rule; or
- the policy is disabled and no hub is attached.

When PI is not applicable, evaluate PII normally. Parallel mode does not create
dummy promises or native work.

## 8. Cumulative Decision Semantics

### 8.1 Successful detector matrix

| PII result | PI result      | Overall result | Provider request            |
| ---------- | -------------- | -------------- | --------------------------- |
| allow      | clean          | allow          | original normalized request |
| allow      | shadow detect  | allow          | original normalized request |
| allow      | block detect   | block          | no call                     |
| allow      | limit exceeded | block          | no call                     |
| redact     | clean          | redact         | PII-redacted request        |
| redact     | shadow detect  | redact         | PII-redacted request        |
| redact     | block detect   | block          | no call                     |
| redact     | limit exceeded | block          | no call                     |
| block      | clean          | block          | no call                     |
| block      | shadow detect  | block          | no call                     |
| block      | block detect   | block          | no call                     |
| block      | limit exceeded | block          | no call                     |

There is no score combination. Each detector resolves its own findings through
its own policy rules. The cumulative combiner applies decision precedence:

```text
block > redact > allow
```

Prompt-injection shadow detection contributes findings and rule IDs but has an
effective detector decision of `allow`.

### 8.2 Policy order

Policy order remains authoritative within each detector:

- a PII finding uses the first matching PII rule;
- a positive PI message uses the first matching PI role rule; and
- an `allow` rule for one finding cannot override a block from another finding.

Cross-detector list construction must also be deterministic. `ruleIds` must be
deduplicated and sorted by original `policy.input` order, not by detector task
completion or by a hard-coded “PII then PI” append operation.

`detectorTypes` and `failedDetectorTypes` use canonical order:

```text
pii, prompt_injection
```

### 8.3 Finding counts

`findingCount` remains:

- one per successfully detected PII span; plus
- one per distinct PI-positive message.

A failed detector contributes zero findings. A PI window-limit block
contributes zero PI findings because no positive classification was produced.
It still contributes all configured PI rule IDs and the block decision,
preserving current limit behavior.

### 8.4 Request ownership

Only PII may transform the provider request.

- Successful PII allow returns the original normalized request object.
- Successful PII redact returns the immutable redacted copy.
- PII block and any cumulative block return no request.
- PI clean, shadow, block, or limit results never provide a replacement request.

The parallel PI evaluator reads the original request but cannot mutate it.

## 9. Detector Failure Semantics

### 9.1 General rule

Parallel execution settles detectors independently. A deterministic block from
one successful detector dominates a runtime failure from the other because the
provider must not be called in either failure mode.

If no successful detector blocks, the existing `runtime_failure_mode` decides
whether a failed detector prevents dispatch.

### 9.2 Failure matrix

| Runtime mode | PII outcome  | PI outcome   | Final behavior                                       |
| ------------ | ------------ | ------------ | ---------------------------------------------------- |
| closed       | block        | error        | input block; zero provider calls                     |
| closed       | error        | block/limit  | input block; zero provider calls                     |
| closed       | allow/redact | error        | generic guardrail evaluation failure                 |
| closed       | error        | clean/shadow | generic guardrail evaluation failure                 |
| closed       | error        | error        | generic guardrail evaluation failure                 |
| open         | block        | error        | input block; record failed PI                        |
| open         | error        | block/limit  | input block; record failed PII                       |
| open         | allow/redact | error        | use successful PII result; preserve redaction        |
| open         | error        | clean/shadow | allow original request; record failed PII            |
| open         | error        | error        | allow original request; record both failed detectors |

The PII fail-open rows carry the same exposure as current whole-input
fail-open: a provider may receive original PII when Layer 1 itself fails. That
is why closed remains the default and recommended production mode.

### 9.3 Sanitized failure representation

Do not carry raw native or detector error strings into cumulative results.
Use a private generic error when closed mode must fail:

```ts
class InputDetectorEvaluationError extends Error {
  constructor(readonly failedDetectorTypes: readonly InputDetectorType[]) {
    super("One or more input detectors failed.");
  }
}
```

The public pipeline still returns:

```text
code: GUARDRAIL_EVALUATION_FAILED
status: 500
message: The gateway could not evaluate the configured guardrails.
```

Do not expose the original error as public metadata or log it. If low-level
diagnostics are required later, add a separately controlled secure telemetry
sink rather than placing native errors in SDK results.

### 9.4 Sequential compatibility

Sequential mode keeps its existing failure behavior:

- PI failure-open returns completed PII redaction;
- PI failure-closed produces the generic evaluation error;
- PII failure is handled by the current outer pipeline policy; and
- PII block skips PI entirely.

Do not force sequential mode through the new parallel settlement matrix if that
would change these outcomes.

## 10. Privacy and Security Requirements

### 10.1 Raw-input boundary

Parallel mode may pass raw normalized selected message content to:

- the local Hugging Face tokenizer;
- request-local token ID arrays;
- request-local `BigInt64Array` tensor buffers; and
- the local ONNX session.

It must never pass raw or redacted content to:

- logger records;
- lifecycle events;
- error messages;
- artifact or classifier cache keys;
- benchmark output;
- provider requests after a successful PII redaction;
- disk files; or
- network model resolvers.

### 10.2 Immutability

Both detector branches receive the same normalized request as read-only input.
PII creates a new request only when redaction is needed. The classifier already
creates request-local token and tensor arrays. No branch may change message
content or array membership in place.

Tests must snapshot the caller input and the normalized request around both
branches.

### 10.3 Denial-of-service bounds

Parallel mode retains all Layer 2 bounds:

- 50,000 selected UTF-16 code units;
- 32 windows per request;
- 256 tokens per window;
- eight windows per ONNX call; and
- one shared warmed classifier per verified artifact.

PII limits remain its existing bounded patterns and validators. No new
unbounded queue, worker pool, or session pool is introduced.

The fact that PII blocks no longer short-circuit PI in parallel mode must be
included in abusive-input load tests.

### 10.4 Model and threshold behavior

Parallelization does not change:

- artifact sealing or checksum validation;
- model labels;
- tokenizer configuration;
- stable softmax;
- threshold equality semantics;
- window overlap;
- model/session caching; or
- offline-only inference.

No ONNX or artifact module should require a production change for this feature.

## 11. Observability

### 11.1 Metadata addition

Add optional execution mode metadata:

```ts
interface GuardrailResultMetadata {
  inputExecutionMode?: InputExecutionMode;
  // existing fields remain
}

interface LifecycleMetadata {
  inputExecutionMode?: InputExecutionMode;
  // existing fields remain
}
```

Keeping the result field optional preserves source compatibility with custom
`GuardrailHub` implementations.

Configured input results should always include their actual mode. The pipeline
forwards it to `input_guardrails_completed` and the sanitized decision log.
No new lifecycle stages are required.

### 11.2 Stable lifecycle stages

Retain:

```text
input_guardrails_started
input_guardrails_completed
```

Do not add per-detector start/completion events. Their order would be
nondeterministic and would expose implementation detail to listeners. The
existing elapsed time already measures the cumulative input-guardrail wall
time.

### 11.3 Runtime-failure logs

The current runtime-failure logger always labels a returned detector failure as
`fail_open`. Update it so a block-dominating failure is distinguishable without
revealing content:

```text
action: fail_open
action: blocked_by_other_detector
action: fail_closed
```

For `fail_closed`, the pipeline recognizes the private sanitized
`InputDetectorEvaluationError`, records only its detector identities, and then
returns the existing generic public evaluation error.

Allowed fields remain:

- request ID;
- policy identity;
- input execution mode;
- failed detector types;
- safe failure action; and
- aggregate decision/count metadata already allowed.

Do not log promises, exceptions, stack traces, model paths, content, tokens,
scores, or thresholds.

### 11.4 Deterministic metadata

Concurrency must not make tests or operations nondeterministic. The following
must be stable across runs:

- detector ordering;
- failed detector ordering;
- rule ID ordering;
- entity type ordering;
- finding counts;
- PI message/window counts; and
- artifact identity.

Only elapsed times may vary.

## 12. Public Construction and Compatibility

`ModelGatewayCreateOptions` does not change. Existing model-path validation
still applies:

| Configuration                | Behavior                                   |
| ---------------------------- | ------------------------------------------ |
| no policy                    | no detector or model work                  |
| disabled policy              | validate YAML; attach no hub               |
| PII-only policy              | no model required or loaded                |
| PI policy without model path | construction error                         |
| PI policy with model path    | verify, load, cache, and warm once         |
| sequential PI policy         | current PII-first request behavior         |
| parallel PI policy           | cumulative original-input detector overlap |

The synchronous constructor and injectable `GuardrailHub` contract remain
unchanged. Custom hubs are not forced to implement parallel behavior.

Adding `inputExecutionMode` to result/lifecycle metadata must remain optional so
existing custom hubs compile without changes.

The package version should advance from `0.5.0` to `0.6.0` because the policy
schema gains a new SDK-visible capability, even though existing behavior is
backward compatible.

## 13. Planned File Changes

### 13.1 Production code

| File                                                   | Planned change                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `src/guardrails/types.ts`                              | Add `InputExecutionMode`, policy default, and optional result metadata          |
| `src/guardrails/config/policy-loader.ts`               | Parse strict `input_execution_mode`, default sequential, validate applicability |
| `src/guardrails/input/prompt-injection-evaluator.ts`   | Extract message selection, classifier validation, rule resolution, and limits   |
| `src/guardrails/input/input-evaluation-coordinator.ts` | Settle detector tasks and combine results deterministically                     |
| `src/guardrails/guardrail-hub.ts`                      | Dispatch to sequential or parallel coordinator; retain output behavior          |
| `src/pipeline/gateway-pipeline.ts`                     | Forward execution mode and correct detector-failure action metadata             |
| `src/pipeline/lifecycle.ts`                            | Add optional execution-mode metadata                                            |
| `src/index.ts`                                         | Export `InputExecutionMode` type only                                           |

No changes are planned for:

- `prompt-injection-artifact.ts`;
- `prompt-injection-windowing.ts`;
- `onnx-prompt-injection-classifier.ts`;
- provider adapters;
- output validators; or
- domain chat types.

### 13.2 Policies, scripts, and docs

| File                                            | Planned change                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `policies/example-policy.yaml`                  | Set/document sequential mode explicitly during initial rollout         |
| `policies/prompt-injection-enforce-policy.yaml` | Select parallel mode for deterministic enforcement smoke               |
| `scripts/smoke-layer2.ts`                       | Assert cumulative parallel allow/redact/block behavior under Bun       |
| `scripts/smoke-layer2-built.mjs`                | Repeat cumulative behavior with built ESM under Node                   |
| `scripts/benchmark-input-guardrails.ts`         | Compare warmed sequential and parallel paths with aggregate output     |
| `README.md`                                     | Document mode, raw-input tradeoff, cumulative decisions, and benchmark |
| `package.json`                                  | Add benchmark script and advance version                               |
| `bun.lock`                                      | Record workspace package version                                       |

### 13.3 Tests

| File                                         | Planned coverage                                                 |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `tests/policy-loader.test.ts`                | Default, valid modes, invalid mode, and parallel applicability   |
| `tests/helpers/guardrail-policy.ts`          | Sequential default and explicit mode option                      |
| `tests/input-evaluation-coordinator.test.ts` | Scheduling, settlement, truth table, ordering, and failures      |
| `tests/guardrail-hub.test.ts`                | Sequential compatibility and raw-input parallel behavior         |
| `tests/guardrail-pipeline.test.ts`           | Provider calls, safe request, public errors, lifecycle, and logs |
| `tests/model-gateway.test.ts`                | Construction remains conditional and mode is propagated          |
| `tests/sdk-entry.test.ts`                    | Type/export and side-effect behavior remain stable               |

## 14. Detailed Test Plan

### 14.1 Policy loading

Verify:

- omission produces `inputExecutionMode: "sequential"`;
- explicit `sequential` loads;
- explicit `parallel` loads with a PI rule;
- unknown, uppercase, boolean, null, and numeric values fail;
- parallel without a PI rule fails;
- malformed mode fails even when the policy is disabled;
- existing PII-only policy fixtures load unchanged;
- rule parsing and global rule-ID uniqueness remain unchanged; and
- no threshold/model/worker settings are accepted in defaults.

### 14.2 Pure combination

Cover every successful row in Section 8.1 and assert:

- block precedence;
- redaction precedence over allow;
- safe request selection;
- zero provider-capable request on block;
- summed finding counts;
- no PI finding for a limit block;
- policy-ordered rule IDs with interleaved PII/PI rules;
- stable entity and detector ordering;
- PI model/message/window metadata preservation; and
- no input mutation.

### 14.3 Scheduling and settlement

Use deferred fake detector functions to prove:

- the PI task starts before PII execution;
- PII completes while PI is still pending;
- the coordinator does not resolve until both tasks settle;
- PII block does not skip an already applicable PI task in parallel mode;
- PI rejection is observed when PII blocks;
- PII rejection is observed when PI blocks;
- simultaneous rejection produces no unhandled rejection;
- a skipped PI role causes no classifier call; and
- task completion order does not change result ordering.

The test must use latches/deferred promises, not timing sleeps.

### 14.4 Sequential regression

Retain and strengthen existing assertions:

- PII block makes zero classifier calls;
- PII redaction is the exact classifier input;
- PI clean returns the PII-safe request;
- PI shadow returns the PII-safe request;
- PI block returns no request;
- PI fail-open preserves redaction;
- PI fail-closed returns the generic evaluation error; and
- result metadata reports `sequential`.

### 14.5 Parallel input behavior

Verify:

- the classifier sees the original normalized email, not `<EMAIL>`;
- the provider sees `<EMAIL>` when cumulative decision allows;
- caller input remains unchanged;
- PII block plus PI clean blocks after both finish;
- PII allow plus PI block blocks;
- both detectors blocking merge findings and policy-ordered rule IDs;
- PI shadow cannot undo PII block;
- PII redaction cannot undo PI block;
- PI limit blocks even when PII allows or redacts;
- unselected roles are not tokenized; and
- result metadata reports `parallel`.

### 14.6 Failure matrix

Implement every row in Section 9.2 with fake failures. Assert:

- provider call count;
- public error code and generic message;
- provider request redaction when PII succeeded;
- original request fallback only when PII failed open;
- canonical `failedDetectorTypes`;
- block-dominating failures use `blocked_by_other_detector`;
- open non-blocking failures use `fail_open`;
- closed non-blocking failures use `fail_closed`;
- raw exception messages do not appear in logs, lifecycle, or public errors;
- findings from successful detectors remain present; and
- failed detectors contribute no fabricated finding count.

### 14.7 Pipeline and lifecycle

Verify:

- only one input start and one input completion event are emitted;
- no per-detector stage appears;
- completion metadata contains the execution mode;
- detector and rule arrays are stable across reversed completion orders;
- any cumulative block makes zero provider calls;
- allowed/redacted results make exactly one provider call;
- output guardrail stages and retries remain unchanged; and
- no-policy and disabled-policy lifecycle sequences remain unchanged.

### 14.8 Real-model smoke

Use synthetic prompts only. Test under Bun source and built Node ESM:

1. benign text without PII is allowed;
2. benign text with a synthetic email reaches the provider redacted;
3. direct injection without PII is blocked;
4. direct injection with a synthetic email is blocked;
5. provider call count remains zero for both blocking cases;
6. lifecycle reports parallel execution;
7. no external model endpoint or network request is used; and
8. process exits without pending inference.

Do not assert exact latency in smoke tests. Benchmark separately.

## 15. Benchmark Plan

### 15.1 Purpose

The benchmark must determine whether parallel scheduling produces meaningful
wall-time savings instead of assuming that two logical layers imply two equal
latency costs.

### 15.2 Method

Run on the intended deployment class under Bun and built Node:

1. verify and load the model once;
2. warm both execution paths;
3. use the same shared classifier/session;
4. alternate or randomize sequential and parallel sample order;
5. run enough iterations for stable p50, p95, and p99 estimates;
6. run with concurrency 1, 4, and 8;
7. record total input-guardrail wall time;
8. record PII branch time and PI branch time for benchmark diagnostics only;
9. record process CPU and RSS before/after each scenario; and
10. output only aggregate numbers and fixture IDs, never prompt content.

Avoid benchmarking cold model load as part of per-request latency. Record cold
load separately because startup remains eager and unchanged.

### 15.3 Synthetic scenarios

Measure at least:

- short benign, no PII, one PI window;
- short benign with each supported synthetic PII type;
- short direct injection, no PII;
- direct injection with synthetic PII;
- PII-blocked benign text;
- PII-blocked injection text;
- eight PI windows;
- 32 PI windows;
- mixed user/system messages with one selected role; and
- PI role selection that skips inference.

### 15.4 Reported metrics

For every runtime/scenario/concurrency tuple, report:

- sample count;
- sequential p50/p95/p99;
- parallel p50/p95/p99;
- absolute and percentage deltas;
- throughput;
- CPU time;
- RSS delta;
- decision agreement count; and
- provider-call agreement count.

Do not publish thresholds, scores, token IDs, or content.

### 15.5 Promotion gates

Parallel mode may move from experimental to production opt-in when:

- all correctness and smoke tests pass;
- no-PII sequential/parallel decision agreement is 100 percent;
- all PII-bearing decision differences are reviewed;
- no scenario has a statistically meaningful p95 regression;
- at least one representative production scenario improves beyond measured
  noise;
- concurrency does not cause unbounded queueing or material RSS growth; and
- operators accept the raw-local-inference privacy boundary.

Changing the example/default policy to parallel requires a stronger gate: a
repeatable latency improvement of at least the greater of 2 ms or 3 percent at
p95 for the representative production mix, with no security decision
regression.

If these gates are not met, keep sequential as the recommended mode and retain
parallel only for explicitly accepted deployments, or remove the feature before
release if it adds maintenance cost without measurable value.

## 16. Implementation Phases

### Phase 0: Feasibility and baseline

1. Add a temporary controlled prototype that starts PI before PII.
2. Measure PII-only time, PI preprocessing time, native inference time, and
   cumulative wall time.
3. Compare sequential and prototype parallel paths on one- and eight-window
   fixtures.
4. Confirm that the ONNX promise allows observable overlap under Bun and Node.
5. Record decision differences caused by raw versus redacted classifier input.
6. Confirm the raw-local-inference privacy choice with the deployment owner.

Exit condition: overlap is real, its benefit is measured, and the classifier
input change is explicitly accepted. If not, stop before modifying the policy
contract.

### Phase 1: Policy and types

1. Add `InputExecutionMode`.
2. Add `inputExecutionMode` to loaded defaults.
3. Parse `input_execution_mode` strictly with sequential default.
4. Reject parallel mode without a PI rule.
5. Add policy tests and update test helpers.
6. Export the public mode type.

Exit condition: old policies normalize to sequential and all invalid mode
configurations fail before gateway construction.

### Phase 2: Detector extraction and pure combination

1. Extract prompt-injection policy evaluation from the hub.
2. Preserve all existing PI validation, role, shadow, block, and limit behavior.
3. Define small settled detector outcome types.
4. Implement the pure cumulative combiner.
5. Enforce policy/canonical metadata ordering.
6. Add complete truth-table tests.

Exit condition: detector results can be combined without timing or model
dependencies, and sequential behavior remains equivalent.

### Phase 3: Parallel orchestration

1. Implement explicit sequential and parallel coordinator paths.
2. Start applicable PI evaluation before scheduling PII in parallel mode.
3. Settle both branches without leaking raw errors.
4. Await all started work.
5. Apply block-dominant failure behavior.
6. Add deferred-promise concurrency tests.

Exit condition: tests prove real overlap ordering, complete settlement, and
deterministic cumulative decisions.

### Phase 4: Pipeline metadata and policies

1. Add optional execution-mode lifecycle/result metadata.
2. Correct runtime-failure action logging for fail-open, fail-closed, and
   block-dominant outcomes.
3. Keep lifecycle stage count stable.
4. Mark the enforcement smoke policy parallel.
5. Keep the example sequential during rollout.
6. Update documentation and package version.

Exit condition: operators can identify mode and safe failure action without
receiving sensitive detector data.

### Phase 5: Complete verification

1. Run all existing unit and integration tests.
2. Run deterministic Layer 1 and Layer 2 scripts.
3. Run Bun source and built Node parallel smokes.
4. Run clean package and side-effect checks.
5. Run the benchmark matrix.
6. Record the as-built result and rollout recommendation.

Exit condition: correctness, compatibility, privacy, package, and performance
gates are documented and green.

### Phase 6: Rollout

1. Deploy parallel mode to a non-production environment.
2. Run in PI shadow mode first while PII actions remain enforced.
3. Compare decisions and latency with sequential control traffic or replayed
   synthetic fixtures.
4. Monitor input latency, block rate, detector failures, CPU, and RSS.
5. Enable PI blocking only after shadow review.
6. Promote the example/recommended mode only if Section 15.5 passes.

Rollback is a policy-only change:

```yaml
defaults:
  input_execution_mode: sequential
```

No model or package rollback should be required.

## 17. Verification Commands

Expected commands from `apps/gateway` after implementation:

```bash
bun test
bun run check-types
bun run test:pipeline
bun run test:guardrails
bun run check:package
bun run seal:prompt-injection-model -- ../model
bun run test:prompt-injection-model -- ../model
bun run benchmark:input-guardrails -- ../model
```

The real-model command must continue to exercise both Bun source and built Node
ESM. The benchmark must be opt-in because it loads the 256 MiB model and runs
many local inferences.

## 18. Acceptance Criteria

Parallel input evaluation is complete only when all of these are true:

1. Existing policies without the new field run sequentially.
2. Parallel mode requires an enabled PI-capable policy and a valid local model.
3. Sequential mode retains PII block short-circuiting.
4. Sequential mode gives the classifier PII-redacted text.
5. Parallel mode gives both detectors the original normalized request.
6. Parallel mode starts PI before synchronous PII work.
7. Tests prove PII runs while the PI promise is pending.
8. Every started detector is awaited to settlement.
9. A block from either successful detector prevents provider access.
10. A block from one detector dominates a peer runtime failure.
11. PII redaction remains the provider request whenever PII succeeds and the
    cumulative result allows dispatch.
12. PI shadow detection cannot override PII redaction or block.
13. PI limit overflow remains a deterministic block.
14. Open PI failure preserves successful PII redaction.
15. Open PII failure may use the original request only when no successful
    detector blocks, and records failed PII.
16. Closed failure without a successful block returns the existing generic
    guardrail evaluation error.
17. Rule, entity, detector, and failure metadata ordering is deterministic.
18. Finding counts include only successful detector findings.
19. No raw exception, prompt, PII, token, tensor, score, threshold, or model
    path appears in logs, lifecycle events, or public errors.
20. Lifecycle stage ordering remains stable.
21. No-policy, disabled-policy, PII-only, output retry, and custom-hub behavior
    remain unchanged.
22. Source imports remain side-effect-free.
23. The package builds and passes external Bun and Node consumer checks.
24. Real parallel allow/redact/block smokes pass under Bun and built Node.
25. Benchmark results demonstrate actual overlap and record latency/CPU/RSS
    tradeoffs.
26. Raw local inference of PII is explicitly documented and accepted before
    deployment.
27. Parallel does not become the default unless the stronger performance gate
    passes.

## 19. Principal Risks and Mitigations

| Risk                                      | Mitigation                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| Raw PII enters local model memory         | Opt-in mode, explicit documentation, local-only inference, sequential default |
| No meaningful latency improvement         | Phase 0 measurement and promotion gate before policy/default rollout          |
| `Promise.all` rejects before peer settles | Detector settlement wrapper and complete aggregation                          |
| Completion order changes metadata         | Pure combiner with policy and canonical ordering                              |
| PII block still consumes ONNX capacity    | Document cost, preserve window bounds, benchmark blocked scenarios            |
| Raw/redacted text changes PI decisions    | Parity corpus split by PII presence and explicit review                       |
| Failure-open loses successful redaction   | Detector-specific outcomes; successful PII result remains authoritative       |
| Peer error hides a known block            | Deterministic block-dominant failure semantics                                |
| Native inference continues after return   | Await every started branch; no cosmetic cancellation                          |
| Concurrent requests overload shared model | Benchmark concurrency and retain one verified shared session                  |
| Logs reveal sensitive concurrency inputs  | Aggregate mode/count/failure metadata only                                    |
| Policy silently claims unused parallelism | Reject parallel mode without a PI rule                                        |
| Refactor regresses sequential behavior    | Explicit compatibility path and retained regression suite                     |

## 20. Deferred Work

The following remain separate milestones:

- worker-thread or worker-process isolation for true JavaScript CPU parallelism;
- secure buffer-zeroing guarantees;
- hard inference cancellation;
- per-detector timeouts or failure modes;
- dynamic execution mode based on request size;
- adaptive batching across requests;
- multiple ONNX sessions or execution providers;
- parallel output validators;
- policy hot reload;
- signed runtime manifests; and
- distributed benchmark/telemetry infrastructure.

These should not be added merely to make the first parallel implementation
appear more concurrent. The first release should remain small, explicit, and
measurable.

## 21. Recommended Final Shape

The recommended implementation is an opt-in cumulative coordinator, not a
wholesale replacement of the current PII-first pipeline:

```text
policy omitted/sequential
  -> existing PII-safe behavior

policy parallel
  -> PI begins on original selected messages
  -> PII overlaps native inference
  -> both settle
  -> block > redact > allow
  -> provider receives only the PII-safe request
```

This design meets the request in `14_parallel.md` while preserving a safe
compatibility path and exposing the central tradeoff honestly: latency can be
reduced only by removing the redacted-text dependency, so parallel mode trades
some local-memory privacy isolation and PII-block short-circuit efficiency for
potentially lower cumulative guardrail latency.
