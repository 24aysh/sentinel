# PII Input Guardrail Design

## Purpose

The PII guardrail detects supported personal data and credentials in chat
messages before a request reaches the model provider. Depending on policy, a
finding can be allowed, replaced, or cause the entire request to be blocked.

This document describes the behavior implemented in the gateway today. It is
intended for developers maintaining the detector, policy loader, pipeline, or
SDK contract.

The guardrail is deterministic and runs locally. It does not call an LLM or a
remote detection service.

## Design goals

The implementation is designed to:

- keep supported PII out of provider requests when the policy says to redact or
  block it;
- return stable findings with exact message and character offsets;
- avoid logging or returning the matched values;
- reject obvious look-alikes before treating them as secrets or personal data;
- preserve the original request object and create a new request when redaction
  is required;
- behave consistently when combined with prompt-injection detection; and
- remain bounded for normal chat input.

The following are not goals:

- detecting every possible secret or personal-data format;
- semantic entity recognition through an ML model;
- scanning model output;
- validating whether a credential is active;
- encrypting or persisting prompts; or
- replacing application-level data classification and access control.

## Position in the request flow

PII evaluation is part of the shared input-guardrail stage:

```text
ChatInput
  -> request normalization
  -> tool schema and history validation
  -> PII evaluation
  -> optional prompt-injection evaluation
  -> tool-definition filtering
  -> model provider
```

If PII produces a block decision, the provider is not called. If it produces a
redact decision, the sanitized request becomes the request used by later
pipeline stages.

Input guardrails run once before the provider loop. An output-repair attempt
does not run the input detectors again.

## Policy contract

A PII rule is an item in the policy's `input` array with `detector: pii`.

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: gateway-pii
  version: 1

defaults:
  input_action: allow
  input_execution_mode: sequential
  runtime_failure_mode: closed

input:
  - id: redact-user-secrets
    description: Remove supported secrets from user messages.
    detector: pii
    entities:
      - EMAIL
      - API_KEY
      - JWT
      - PRIVATE_KEY
    roles:
      - user
    action:
      type: redact
      replacement: "<SENSITIVE>"
```

### Rule fields

- `id` is required and must be globally unique across input, output, and tool
  rules.
- `description` is optional, validated at startup, and is not used at runtime.
- `entities` must contain one or more unique supported entity names.
- `roles` is optional. When omitted, the rule applies to every supported chat
  role.
- `action.type` must be `allow`, `redact`, or `block`.
- `action.replacement` is accepted only for `redact` and is limited to 256
  characters.

The supported roles are `system`, `user`, `assistant`, and `tool`. Only string
message content is inspected. An assistant message with `content: null` and
tool calls has no text for this detector to inspect.

### Default action

`defaults.input_action` controls a detected finding that does not match a PII
rule. Its default is `allow`.

The detector still looks for every supported entity. The `entities` field
controls how a finding is handled; it does not switch individual finders on or
off.

### Rule precedence

Rules are evaluated in policy order. The first PII rule whose `entities` and
optional `roles` match a finding supplies that finding's action. Later matching
rules do not override it.

This makes rule ordering part of the policy contract. Put narrower role-based
exceptions before broader rules when they overlap.

## Supported entities

The public entity set is defined by `PII_ENTITIES`:

- `EMAIL`
- `PHONE_NUMBER`
- `IP_ADDRESS`
- `API_KEY`
- `JWT`
- `PRIVATE_KEY`
- `CLOUD_CREDENTIAL`
- `CREDIT_CARD`
- `DATABASE_CONNECTION_STRING`

Adding a new entity is an additive policy-schema change. It requires a finder,
validation behavior, overlap precedence, tests, and documentation.

## Detection architecture

Detection has two stages: candidate extraction and structural validation.

### Candidate extraction

Bounded regular expressions find possible spans in each string message. A
finding records only:

- entity type;
- message index;
- message role;
- start offset; and
- end offset.

Offsets use JavaScript string indices, which are UTF-16 code-unit offsets. The
matched value is deliberately not included in `PiiFinding`.

Candidate matching also checks token boundaries so that a detector does not
silently extract a credential-like substring from a larger identifier.

### Structural validation

Format-specific validators reduce common false positives:

- email addresses enforce local-part and domain-label structure;
- phone numbers enforce digit counts, balanced punctuation, plausible
  international prefixes, and non-placeholder digits;
- IPv4 and IPv6 candidates use the platform IP parser;
- generic secrets use length, character variety, entropy, and placeholder
  rejection;
- JWTs require three valid base64url segments, JSON header and payload objects,
  a non-`none` algorithm, and a non-empty signature;
- private keys require matching supported PEM labels and a decodable body;
- credit cards require a consistent separator style and a valid Luhn checksum;
- cloud credentials use known provider prefixes or structurally recognizable
  key forms; and
- database connection strings require a supported scheme or recognizable DSN
  fields.

These checks establish syntax and plausibility only. They do not prove that a
credential belongs to a person or can authenticate.

### Overlap resolution

Multiple finders can claim overlapping text. The detector returns one finding
per overlap group using this protection precedence:

```text
PRIVATE_KEY
DATABASE_CONNECTION_STRING
JWT
CLOUD_CREDENTIAL
API_KEY
CREDIT_CARD
EMAIL
IP_ADDRESS
PHONE_NUMBER
```

If two findings have the same precedence, the longer span wins. If their
lengths are equal, the earlier span wins. Findings are returned in stable
message and offset order.

This prevents a large secret, such as a database URL, from being fragmented
into lower-value findings.

## Decision algorithm

For each request:

1. Scan every string message and normalize overlapping findings.
2. Resolve each finding to the first matching PII rule or the default action.
3. If any resolved action is `block`, return one block decision for the whole
   request.
4. Otherwise, collect every `redact` finding.
5. Apply replacements from right to left within each message so earlier offsets
   remain valid.
6. Return `redact` with a new request when replacements were made; otherwise
   return `allow` with the normalized request.

Block has request-level precedence. The gateway does not partially redact and
then send a request that also contains a blocked finding.

The default replacement is `<ENTITY>`, for example `<EMAIL>` or `<API_KEY>`.
One rule-level replacement can intentionally replace multiple entity types with
the same neutral value.

## Result and error behavior

An allow or redact result includes:

- the request to continue with;
- `findingCount`;
- matched `ruleIds`;
- unique `entityTypes`; and
- `detectorTypes`, including `pii`.

A block result includes the same sanitized metadata but does not include the
request. The pipeline converts it into:

```text
code: INPUT_GUARDRAIL_BLOCKED
status: 400
message: The request was blocked by an input guardrail.
```

The public error intentionally does not identify the entity, rule, or matched
text.

## Interaction with prompt-injection evaluation

The policy controls input execution through
`defaults.input_execution_mode`.

In `sequential` mode:

1. PII runs first.
2. A PII block skips prompt-injection inference.
3. Prompt-injection inference receives the PII-redacted request.

In `parallel` mode:

1. PII and prompt-injection evaluation start independently.
2. Prompt-injection inference sees the normalized raw request.
3. Both started tasks are settled.
4. If neither blocks, the provider receives the PII-redacted request.

Parallel mode reduces combined latency but changes which text the classifier
sees. It must be selected explicitly and requires a prompt-injection rule.

When both detectors succeed, a block from either detector wins over redaction
or allow. PII redaction is preserved when prompt-injection inference fails and
the policy is fail-open.

## Runtime failure behavior

`defaults.runtime_failure_mode` applies to unexpected detector failures:

- `closed` turns an otherwise unblocked detector failure into
  `GUARDRAIL_EVALUATION_FAILED` with status 500;
- `open` continues with the safe result available from the other detector, or
  the original request if no transformation succeeded.

A successful block from one detector is not undone because its peer failed.
When the coordinator can identify a failed peer, failure metadata contains only
detector types, never exception messages or prompt content. A failure that
escapes the coordinator is still logged without its private exception details.

Policy syntax and configuration errors are startup failures and do not use
runtime fail-open behavior.

## Privacy and security properties

The following invariants should remain true:

- raw matches are never added to lifecycle metadata, decision logs, or public
  errors;
- detection and redaction are request-local;
- the original request and message objects are not mutated;
- redaction happens before a sequential prompt-injection classifier and before
  the provider;
- a block prevents provider execution; and
- heuristic validation rejects common placeholders and malformed look-alikes.

Consumers should still treat `GatewayExecutionResult.providerRequest` as
sensitive. It contains the full request after input guardrails and may retain
data that the configured policy permits.

## Observability

The shared input lifecycle stages are:

```text
input_guardrails_started
input_guardrails_completed
```

Completion metadata can include:

- `decision`: `allow`, `redact`, or `block`;
- `findingCount`;
- `ruleIds`;
- `entityTypes`;
- `detectorTypes`;
- `failedDetectorTypes`; and
- `inputExecutionMode`.

The logger emits `gateway.guardrail_decision` for the input phase. Runtime
failures produce sanitized failure records. No event should contain message
content or matched values.

## Performance characteristics

The PII detector is synchronous and local. Regexes and format validators are
bounded by the already-normalized message strings. Connection strings, JWT
segments, secret candidates, and private-key bodies have explicit size limits.

The detector currently scans all supported entity patterns even when the
policy mentions only a subset. This keeps default-action behavior consistent,
but it means entity lists should not be treated as a detector-performance
switch.

## Testing

From `apps/gateway`:

```bash
bun test tests/pii-detector.test.ts
bun test tests/input-evaluation-coordinator.test.ts
bun test tests/guardrail-hub.test.ts
bun test tests/guardrail-pipeline.test.ts
bun test tests/policy-loader.test.ts
bun run smoke:layer2 -- ../model
```

The test suite should cover:

- positive synthetic examples for every supported entity;
- invalid and placeholder look-alikes;
- stable message roles and offsets;
- overlap precedence;
- first-rule resolution and default actions;
- custom and default replacements;
- whole-request block precedence;
- sequential and parallel composition;
- fail-open and fail-closed behavior; and
- absence of raw findings in logs and errors.

## Main implementation files

- `src/guardrails/input/pii-detector.ts`: candidate extraction, ordering, and
  overlap resolution.
- `src/guardrails/input/pii-validators.ts`: structural validators.
- `src/guardrails/input/input-evaluator.ts`: policy resolution, decisions, and
  redaction.
- `src/guardrails/input/input-evaluation-coordinator.ts`: composition with
  prompt-injection evaluation.
- `src/guardrails/config/policy-loader.ts`: strict YAML parsing.
- `src/guardrails/types.ts`: public and loaded policy types.
- `src/pipeline/gateway-pipeline.ts`: provider-blocking and lifecycle behavior.

The implementation history and broader rationale are recorded in
`specs/10_layer1_implement.md` and the earlier gateway guardrail specs.

## Known limitations

- Detection is pattern-based, so false positives and false negatives remain
  possible.
- Free-form names, postal addresses, government IDs, and unrecognized secret
  formats are not detected.
- Obfuscated or split credentials can evade a single-message pattern.
- The detector does not scan binary, image, audio, or non-string content.
- An `allow` action records a finding but intentionally permits the original
  value to continue.
- Redaction protects the provider boundary, not application logs created before
  the request enters the gateway.

These limitations are reasons to combine the guardrail with least-privilege
credentials, application logging controls, and provider-side data protections.
