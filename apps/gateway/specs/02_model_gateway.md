# Configurable Guardrail Gateway: Implementation Specification

## 1. Document Purpose

This document defines the second gateway milestone. It is an implementation
specification for adding configurable input and output guardrails to the
working gateway described in `01_project_v1.md`.

The milestone deliberately implements only two guardrail capabilities:

- deterministic PII detection for chat input; and
- JSON Schema validation for model output.

The design leaves explicit extension points for future detectors, validators,
actions, providers, and policy versions without implementing those future
features now.

## 2. Baseline

The current gateway already provides:

- a validated, provider-neutral `ChatRequest` before the provider call;
- a normalized `ChatResponse` after the provider call;
- a single `ModelProvider` boundary;
- sanitized public errors;
- structured lifecycle logging; and
- deterministic tests using an in-memory provider.

The guardrail milestone must extend those boundaries rather than move policy
logic into the HTTP transport or provider adapter.

When no guardrail policy is configured, the gateway must retain the behavior
documented in `01_project_v1.md`, including one provider call and the current
successful lifecycle stages.

## 3. Goals

The implementation must:

1. Load a versioned guardrail policy from YAML at process startup.
2. Validate the complete policy before accepting traffic.
3. Detect configured PII entities in input messages.
4. Deterministically allow, redact, or block each input finding.
5. Validate every assistant output choice against one configured JSON Schema.
6. Retry an invalid output with a deterministic repair request when configured.
7. Block an output that remains invalid after its retry budget is exhausted.
8. Resolve overlapping findings and matching rules deterministically.
9. Support fail-open and fail-closed handling of unexpected guardrail runtime
   failures.
10. Record policy decisions without logging prompt, completion, or detected PII
    values.
11. Keep guardrail implementations behind a central hub that can be extended in
    later milestones.

## 4. Non-goals

This milestone must not implement:

- prompt-injection detection;
- content-safety, secrets, or toxicity detection;
- confidence scores or probabilistic detectors;
- output replacement or configured fallback responses;
- provider routing or fallback providers;
- arbitrary action pipelines;
- policy hot reload;
- remote policy or schema retrieval;
- external detector services or detector timeouts;
- streaming, tool calls, multimodal content, or retrieval guardrails;
- persistence of prompts, responses, findings, or decisions;
- a policy administration API; or
- changes to provider authentication or caller authentication.

The terms `replace`, `route`, and `escalate` are reserved for later policy
versions. They are not accepted by the `guardrails/v1` policy schema.

## 5. Design Decisions

### 5.1 PII scope

Version 1 recognizes exactly these entities:

- `EMAIL`
- `PHONE_NUMBER`
- `CREDIT_CARD`

Rules may target `system`, `user`, or `assistant` input messages. If a rule does
not specify roles, it applies to all three roles.

Detection is deterministic and local. Version 1 therefore has no confidence
field and does not accept `confidence_gte`.

### 5.2 Supported actions

Input PII rules support:

- `allow`
- `redact`
- `block`

Output JSON Schema rules allow a valid response and support the following
failure actions:

- `retry`
- `block`

Successful validation is implicitly an allow decision. `replace` and `route`
are not part of version 1.

### 5.3 Policy loading

One policy may be configured through `GUARDRAIL_POLICY_PATH`.

- When the variable is absent or blank, guardrails are disabled and the current
  gateway behavior is preserved.
- A relative policy path is resolved from the process working directory.
- The policy is loaded once during runtime construction.
- A configured file that is missing, unreadable, malformed, or invalid prevents
  startup.
- Startup policy errors are never subject to fail-open behavior.

### 5.4 JSON output interpretation

The complete trimmed assistant message must parse as JSON. Markdown fences,
leading commentary, and trailing commentary are invalid even if they contain a
valid JSON fragment.

Every returned assistant choice must satisfy the schema. One invalid choice
makes the provider response invalid.

### 5.5 Retry meaning

`maximum_retries` is the number of additional provider calls after the initial
call. A value of `1` permits at most two total provider calls.

The version 1 maximum is three retries. This bound is validated at startup.

### 5.6 Runtime failure modes

The policy declares `runtime_failure_mode: open` or `closed`.

This setting applies only when guardrail code unexpectedly cannot evaluate a
request or response. It does not convert a real PII finding or schema violation
into an operational failure.

- `open`: log sanitized failure metadata and continue unchanged.
- `closed`: stop processing with `GUARDRAIL_EVALUATION_FAILED`.

The default is `closed`.

## 6. Policy Contract

### 6.1 Complete example

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: customer-support-production
  version: 1

defaults:
  input_action: allow
  runtime_failure_mode: closed
  maximum_retries: 1

input:
  - id: block-card-data-in-system-prompts
    description: System prompts must never contain payment-card data.
    detector: pii
    entities:
      - CREDIT_CARD
    roles:
      - system
    action:
      type: block

  - id: redact-customer-contact-data
    description: Remove contact details before sending input upstream.
    detector: pii
    entities:
      - EMAIL
      - PHONE_NUMBER
      - CREDIT_CARD
    roles:
      - user
      - assistant
    action:
      type: redact
      replacement: "<PII>"

output:
  - id: require-support-response
    validator: json_schema
    schema_ref: schemas/support-response.json
    on_failure:
      type: retry
      maximum_retries: 1
      repair_prompt: Return only JSON that conforms to the supplied schema.
```

### 6.2 Top-level fields

| Field        | Required | Contract                                                 |
| ------------ | -------- | -------------------------------------------------------- |
| `apiVersion` | Yes      | Must equal `guardrails/v1`.                              |
| `kind`       | Yes      | Must equal `GuardrailPolicy`.                            |
| `enabled`    | No       | Boolean policy switch. Defaults to `true`.               |
| `metadata`   | Yes      | Policy identity and revision.                            |
| `defaults`   | No       | Defaults described below.                                |
| `input`      | No       | Ordered PII rules. Defaults to an empty list.            |
| `output`     | No       | Zero or one JSON Schema rule. Defaults to an empty list. |

Unknown fields are rejected at every policy level. YAML duplicate keys are
rejected.

When `enabled` is `false`, the complete policy and referenced schema are still
loaded and validated at startup, but the runtime does not construct a guardrail
hub. Requests follow the same lifecycle and provider behavior as a gateway with
no configured policy. Changing this value requires a process restart.

### 6.3 Metadata

```yaml
metadata:
  name: customer-support-production
  version: 1
```

- `name` is required and must match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}`.
- `version` is a required positive integer.
- The pair is included in sanitized policy logs.
- The version is policy metadata, not `apiVersion`.

### 6.4 Defaults

```yaml
defaults:
  input_action: allow
  runtime_failure_mode: closed
  maximum_retries: 1
```

| Field                  | Default  | Validation                     |
| ---------------------- | -------- | ------------------------------ |
| `input_action`         | `allow`  | `allow`, `redact`, or `block`. |
| `runtime_failure_mode` | `closed` | `open` or `closed`.            |
| `maximum_retries`      | `1`      | Integer from `0` through `3`.  |

When the default input action is `redact`, its replacement is the entity name
in angle brackets, such as `<EMAIL>`.

### 6.5 Input rule

```yaml
- id: redact-customer-contact-data
  description: Optional operator-facing text.
  detector: pii
  entities:
    - EMAIL
    - PHONE_NUMBER
  roles:
    - user
  action:
    type: redact
    replacement: "<PII>"
```

Contract:

- `id` is required, uses the metadata name format, and is globally unique
  across input and output rules.
- `description` is optional and is never returned to callers.
- `detector` must equal `pii`.
- `entities` is a required, non-empty, duplicate-free subset of the supported
  entity names.
- `roles` is optional. When present, it is a non-empty, duplicate-free subset
  of `system`, `user`, and `assistant`.
- `action.type` must be `allow`, `redact`, or `block`.
- `action.replacement` is allowed only for `redact`, must be non-empty, and may
  contain at most 256 characters.
- A redaction rule without a replacement uses `<ENTITY_NAME>` for each finding.

Input rules are evaluated in YAML declaration order.

### 6.6 Output rule

```yaml
- id: require-support-response
  validator: json_schema
  schema_ref: schemas/support-response.json
  on_failure:
    type: retry
    maximum_retries: 1
    repair_prompt: Return only valid JSON.
```

Contract:

- Version 1 accepts at most one output rule.
- `id` follows the same uniqueness rules as input rule IDs.
- `validator` must equal `json_schema`.
- `schema_ref` is required and points to a local JSON file.
- `on_failure.type` must be `retry` or `block`.
- `maximum_retries` is allowed only for `retry`; it overrides the policy
  default and must be an integer from `0` through `3`.
- `repair_prompt` is optional, allowed only for `retry`, and limited to 2,000
  characters.
- When `repair_prompt` is omitted, the gateway uses a built-in repair
  instruction.

An empty output list means no output validation.

### 6.7 Schema references

`schema_ref` is resolved relative to the directory containing the policy file.

The loader must:

- reject absolute paths;
- reject a resolved path outside the policy directory, including symlink
  escapes;
- require a regular `.json` file;
- parse the file as JSON;
- compile the schema during startup;
- support JSON Schema Draft 2020-12;
- allow internal references such as `#/$defs/Address`; and
- reject remote and cross-file `$ref` values.

Policy and schema files are limited to 1 MiB each.

## 7. Input Guardrail Behavior

### 7.1 Detection

The PII detector evaluates each configured message independently and returns
findings with internal metadata:

```ts
interface PiiFinding {
  entity: "EMAIL" | "PHONE_NUMBER" | "CREDIT_CARD";
  messageIndex: number;
  role: ChatRole;
  start: number;
  end: number;
}
```

The matched value must not be stored on lifecycle events or written to logs.
The detector may retain it only transiently while creating the transformed
message.

Detection behavior:

- `EMAIL` recognizes conventional ASCII mailbox and domain forms. Unicode
  internationalized addresses are outside version 1.
- `PHONE_NUMBER` recognizes candidates containing 10 through 15 digits, with
  an optional leading `+` and common spaces, dots, hyphens, or parentheses.
- `CREDIT_CARD` recognizes 13 through 19 digits with optional spaces or hyphens
  and requires a valid Luhn checksum.

Regexes must use bounded input scans and must not contain catastrophic
backtracking patterns.

### 7.2 Overlapping findings

Findings are normalized before rule evaluation:

1. Sort by message index.
2. Sort by start position.
3. At the same start position, prefer the longest span.
4. For an identical span, use entity precedence:
   `CREDIT_CARD`, `EMAIL`, then `PHONE_NUMBER`.
5. Discard a lower-precedence finding that overlaps an accepted finding.

This guarantees that one character range is transformed at most once.

### 7.3 Rule matching and conflict resolution

For each normalized finding:

1. Find the first declared input rule whose entity and role match.
2. Assign that rule's action to the finding.
3. If no rule matches, assign `defaults.input_action`.

The first-match rule makes configured exceptions possible. For example, an
early `allow` rule for system-message emails can override a later general email
redaction rule.

The request-level decision is then resolved as follows:

1. If any finding is assigned `block`, block the complete request.
2. Otherwise, redact every finding assigned `redact`.
3. Findings assigned `allow` remain unchanged.
4. If there are no findings, allow the request unchanged.

### 7.4 Redaction

Redactions are applied from the end of each message toward the beginning so
earlier offsets remain valid.

The gateway must create new message and request objects. It must not mutate the
HTTP body, caller-owned `ChatInput`, or original normalized `ChatRequest`.

Only the transformed request is sent to the provider. Raw detected PII must not
appear in operational logs or guardrail errors.

### 7.5 Blocking

An input block:

- prevents every provider call;
- produces HTTP `400`;
- uses error code `INPUT_GUARDRAIL_BLOCKED`; and
- returns the generic message `The request was blocked by an input guardrail.`

The public response must not include the rule ID, entity type, message index,
or detected value.

## 8. Output Guardrail Behavior

### 8.1 Validation

After each successful provider call, the output evaluator:

1. Reads every assistant choice's `message.content`.
2. Trims outer whitespace.
3. Parses the complete content with `JSON.parse`.
4. Validates the parsed value against the compiled schema.
5. Allows the response only when every choice passes.

If more than one choice fails, the first failing choice in provider response
order is the repair source. This is deterministic and does not depend on the
provider's choice indexes.

Schema validation errors are retained only long enough to construct sanitized
logs and a repair request. They are not returned verbatim to the caller.

### 8.2 Repair retry

When validation fails and retries remain, the gateway creates a new provider
request by extending the exact request used for the immediately preceding
provider attempt with:

1. the selected invalid assistant choice as an `assistant` message; and
2. a new `user` repair message.

This preserves the post-input-guardrail messages and the complete repair
conversation across multiple retries. The `request` passed to
`evaluateOutput()` is the exact request used for the current provider attempt.

The repair message contains:

- the configured `repair_prompt` or the built-in instruction;
- the JSON Schema serialized as JSON; and
- a requirement to return only the corrected JSON value.

The repair message must not include validator stack traces or gateway-internal
paths. The invalid assistant content is already present as its own message and
must not be duplicated inside the repair text.

The retry request preserves the selected model, temperature, and max-token
settings. It uses the same request ID and provider timeout behavior.

Every retry response passes through output validation again. Input PII
detection is not rerun against gateway-generated repair messages.

### 8.3 Retry exhaustion

When output remains invalid after the configured retry budget, or when
`on_failure.type` is `block`, the gateway:

- discards the invalid response;
- produces HTTP `502`;
- uses error code `OUTPUT_GUARDRAIL_FAILED`; and
- returns the message `The model response did not satisfy the output policy.`

No invalid model content or schema diagnostic is returned to the caller.

### 8.4 Usage accounting

The successful public response uses the ID, creation time, model, choices, and
finish reasons from the final valid provider response.

When every provider attempt reports token usage, the gateway sums prompt,
completion, and total tokens across all attempts. If any attempt omits usage,
the public response omits usage rather than reporting a misleading partial
total.

## 9. Guardrail Hub

The pipeline depends on one central abstraction rather than importing concrete
detectors or validators:

```ts
interface GuardrailHub {
  evaluateInput(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<InputGuardrailResult>;

  evaluateOutput(
    request: ChatRequest,
    response: ChatResponse,
    context: RequestContext,
    attempt: number,
  ): Promise<OutputGuardrailResult>;
}
```

Expected result shapes:

```ts
type InputGuardrailResult =
  | { decision: "allow"; request: ChatRequest; findingCount: number }
  | { decision: "redact"; request: ChatRequest; findingCount: number }
  | { decision: "block"; findingCount: number; ruleIds: string[] };

type OutputGuardrailResult =
  | { decision: "allow" }
  | { decision: "retry"; ruleId: string; repairRequest: ChatRequest }
  | { decision: "block"; ruleId: string };
```

Exact type names may change during implementation, but the separation of
responsibilities must remain:

- policy loading parses and validates configuration;
- detectors produce findings;
- evaluators match findings to rules and resolve decisions;
- action code transforms or blocks;
- the hub coordinates input and output components; and
- the pipeline owns provider attempts and the overall lifecycle.

The runtime creates either a configured hub or no hub. The HTTP layer and
provider adapter remain unaware of policy details.

## 10. Pipeline Lifecycle

### 10.1 Policy disabled

With no `GUARDRAIL_POLICY_PATH`, or with a loaded policy whose `enabled` value is
`false`, the successful lifecycle remains:

```text
received
  -> validated
  -> provider_started
  -> provider_completed
  -> completed
```

### 10.2 Policy enabled without retry

```text
received
  -> validated
  -> input_guardrails_started
  -> input_guardrails_completed
  -> provider_started
  -> provider_completed
  -> output_guardrails_started
  -> output_guardrails_completed
  -> completed
```

### 10.3 Policy-enabled retry

```text
received
  -> validated
  -> input_guardrails_started
  -> input_guardrails_completed
  -> provider_started              attempt=1
  -> provider_completed            attempt=1
  -> output_guardrails_started     attempt=1
  -> output_guardrails_completed   attempt=1, decision=retry
  -> retry_started                 attempt=2
  -> provider_started              attempt=2
  -> provider_completed            attempt=2
  -> output_guardrails_started     attempt=2
  -> output_guardrails_completed   attempt=2, decision=allow
  -> completed
```

Lifecycle events may add these sanitized optional fields:

- `policyName`
- `policyVersion`
- `decision`
- `findingCount`
- `ruleIds`
- `attempt`
- `maximumAttempts`

They must not contain message content, completion content, repair content,
matched values, schema contents, or JSON validation values.

Failures continue to record one `failed` event with the last successful stage
and stable error code.

## 11. Error Contract

Add the following stable error codes:

| Condition                               | Status | Code                          |
| --------------------------------------- | -----: | ----------------------------- |
| Input policy blocks request             |    400 | `INPUT_GUARDRAIL_BLOCKED`     |
| Output is invalid after policy handling |    502 | `OUTPUT_GUARDRAIL_FAILED`     |
| Fail-closed runtime evaluation error    |    500 | `GUARDRAIL_EVALUATION_FAILED` |

Existing model and HTTP errors remain unchanged.

Public errors retain the current shape:

```json
{
  "error": {
    "code": "INPUT_GUARDRAIL_BLOCKED",
    "message": "The request was blocked by an input guardrail.",
    "request_id": "gateway-request-id"
  }
}
```

Policy loading errors use `ConfigurationError` during startup and never become
HTTP responses.

## 12. Observability and Privacy

Add structured events for:

- successful policy loading;
- input allow, redact, and block decisions;
- output allow, retry, and block decisions;
- retry attempt counts; and
- fail-open runtime errors.

Logs may include policy identity, rule IDs, entity types, counts, decisions,
attempt numbers, durations, request ID, and error code.

Logs must not include:

- original or redacted prompt text;
- completion text;
- detected values;
- JSON values or validation payloads;
- complete schemas or repair prompts;
- API keys or authorization headers; or
- full policy documents.

Fail-open errors must be normalized before logging so third-party error objects
cannot leak evaluated content.

## 13. Configuration Changes

Extend `GatewayConfig` with:

```ts
guardrailPolicyPath?: string;
debugExposeProviderRequest: boolean;
```

Add to `.env.example`:

```dotenv
# Optional. When omitted, guardrails are disabled.
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml

# Local debugging only.
GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=false
```

No API endpoint is added for selecting or overriding policies. Callers cannot
choose a policy per request in version 1.

When `GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true` and a request includes
`x-gateway-debug-provider-request: true`, a successful response may include a
`gateway_debug.provider_request` object. It contains the normalized first
provider request after input guardrails and never includes authorization data.
Both controls are required, and the feature defaults to disabled because it
exposes prompt content.

## 14. Dependencies

Declare these direct gateway dependencies:

- `yaml` for YAML 1.2 parsing;
- `ajv` for JSON Schema Draft 2020-12 compilation and validation; and
- `ajv-formats` for standard `format` assertions.

The YAML loader uses one strict document, requires unique keys, disables aliases
with `maxAliasCount: 0`, and does not register custom tags.

The schema validator uses Ajv's dedicated 2020-12 implementation in strict
mode. Standard formats are installed in `fast` mode. Unknown formats and schema
keywords fail compilation during startup. The validator must not modify model
output by applying defaults, coercing types, or removing additional fields.

The implementation should use a maintained YAML parser and JSON Schema
validator rather than hand-written parsers. Dependencies must be declared in
`apps/gateway/package.json`; transitive workspace dependencies must not be
imported directly.

Policy validation remains separate from JSON Schema validation of model output.

## 15. Proposed Source Layout

```text
apps/gateway/
|-- policies/
|   |-- example-policy.yaml
|   `-- schemas/
|       `-- support-response.json
|-- src/
|   |-- guardrails/
|   |   |-- guardrail-hub.ts
|   |   |-- types.ts
|   |   |-- config/
|   |   |   |-- policy-loader.ts
|   |   |   `-- policy-validator.ts
|   |   |-- input/
|   |   |   |-- input-evaluator.ts
|   |   |   `-- pii-detector.ts
|   |   |-- output/
|   |   |   |-- json-schema-validator.ts
|   |   |   `-- output-evaluator.ts
|   |   `-- retry/
|   |       `-- repair-request.ts
|   |-- pipeline/
|   |   |-- gateway-pipeline.ts
|   |   `-- lifecycle.ts
|   `-- runtime.ts
|-- tests/
|   |-- guardrail-hub.test.ts
|   |-- policy-loader.test.ts
|   |-- pii-detector.test.ts
|   |-- json-schema-validator.test.ts
|   |-- guardrail-pipeline.test.ts
|   `-- fixtures/
|       |-- policies/
|       `-- schemas/
`-- scripts/
    `-- test-guardrails.ts
```

The exact split may be adjusted to avoid trivial files, but concrete PII and
JSON Schema logic must remain outside `gateway-pipeline.ts`.

## 16. Runtime Composition

Runtime construction becomes:

```text
GatewayConfig
    +
ConsoleLogger
    +
OpenAICompatibleProvider
    +
optional loaded GuardrailPolicy
    |
    v
GuardrailHub (only when configured)
    |
    v
GatewayPipeline
    |
    v
Elysia application
```

The policy and schema are parsed and compiled once. They must not be re-read or
recompiled per request.

Tests may inject a fake hub or concrete in-memory policy without reading from
disk.

## 17. Implementation Sequence

### Phase 1: Policy domain and loading

1. Define strict TypeScript policy types.
2. Add `GUARDRAIL_POLICY_PATH` configuration.
3. Parse YAML with duplicate-key and resource limits.
4. Validate policy structure, discriminated actions, IDs, bounds, and version.
5. Resolve and validate the local schema path.
6. Compile the schema during startup.
7. Add a checked-in example policy and schema.

### Phase 2: Input guardrails

1. Implement the three PII entity detectors.
2. Normalize overlapping findings.
3. Implement ordered rule matching.
4. Implement request-level conflict resolution.
5. Implement immutable redaction.
6. Implement sanitized input-block errors.

### Phase 3: Output guardrails

1. Implement strict JSON parsing.
2. Validate every response choice against the compiled schema.
3. Implement deterministic repair-request construction.
4. Add bounded retry coordination to the gateway pipeline.
5. Aggregate usage when complete usage is available.
6. Implement sanitized retry-exhaustion errors.

### Phase 4: Failure modes and observability

1. Add fail-open and fail-closed handling around hub evaluation.
2. Extend lifecycle stage types and metadata.
3. Add sanitized decision logs.
4. Confirm that no content or findings are logged.

### Phase 5: HTTP, documentation, and scripts

1. Extend public error-code mappings.
2. Update `.env.example` and `README.md`.
3. Add a deterministic guardrail pipeline script using a fake provider.
4. Update the as-built specification after implementation is verified.

## 18. Test Plan

### 18.1 Policy loading

Cover:

- no configured path;
- valid policy and schema;
- enabled and disabled policies;
- missing policy file;
- oversized files;
- malformed YAML and duplicate keys;
- unsupported `apiVersion` or `kind`;
- missing metadata;
- invalid or duplicate rule IDs;
- unknown fields;
- unsupported detector, validator, entity, role, or action;
- invalid action-specific fields;
- invalid retry bounds;
- more than one output rule;
- missing, malformed, or uncompilable schema;
- absolute, traversal, and symlink-escape schema paths; and
- remote or cross-file schema references.

### 18.2 PII detector

Cover positive and negative examples for:

- conventional email addresses;
- formatted and international phone numbers;
- valid credit-card candidates;
- invalid Luhn candidates;
- role filtering;
- multiple findings in one message;
- findings across multiple messages;
- overlapping candidates; and
- input strings designed to expose pathological regex performance.

Tests must use synthetic values, not real personal data.

### 18.3 Input decisions

Cover:

- no finding;
- unmatched finding with each default action;
- first matching rule wins;
- an early allow exception;
- block precedence across multiple findings;
- multiple redactions applied with stable offsets;
- default and custom replacements;
- all supported message roles;
- provider not called on block;
- provider receives only transformed content on redact; and
- original input and normalized request remain unchanged.

### 18.4 Output validation and retry

Cover:

- valid JSON satisfying schema;
- malformed JSON;
- fenced JSON rejected;
- valid JSON failing schema;
- multiple choices where one fails;
- immediate block behavior;
- zero retries;
- invalid first output followed by valid retry;
- retry exhaustion;
- exact provider-call bound;
- repair-message ordering and content;
- input transformations retained on retry;
- provider error during retry;
- complete usage aggregation; and
- usage omission when any attempt lacks usage.

### 18.5 Failure modes

Inject throwing input and output evaluators and cover:

- fail-open input continuation;
- fail-open output continuation;
- fail-closed input failure before provider call;
- fail-closed output failure after provider call;
- stable public errors; and
- sanitized logs without thrown private details.

### 18.6 Pipeline and HTTP integration

Cover:

- unchanged behavior with no policy;
- policy-enabled lifecycle without retry;
- retry lifecycle and attempt metadata;
- one failed lifecycle event per failure;
- request ID preserved across retries;
- duration header includes all attempts;
- block and output-failure HTTP statuses and bodies; and
- current model-provider error mappings remain unchanged.

All automated tests must use fake providers. No test may consume provider quota.

## 19. Deterministic Verification Script

Add `scripts/test-guardrails.ts` and a package script such as
`test:guardrails`.

The script must use the production pipeline and concrete guardrail hub with an
in-memory fake provider. It should deterministically verify:

1. PII is redacted before the fake provider observes the request.
2. An invalid first response causes one repair retry.
3. A valid repaired response is returned.
4. Exactly two provider calls occur.
5. No network listener, API key, or external request is required.

## 20. Security Constraints

- Policy configuration is trusted operator input, but must still be validated
  strictly to catch mistakes before traffic is accepted.
- Request and model content remain untrusted input.
- File references cannot escape the policy directory.
- Remote schema resolution is disabled.
- Retry counts have a hard upper bound.
- Policy and schema size limits are enforced before parsing.
- Detector regexes are reviewed for bounded execution.
- The repair request does not execute templates or interpolate arbitrary
  placeholders.
- Error and log sanitization is tested explicitly.
- Guardrail handling never logs or persists raw PII.

## 21. Acceptance Criteria

The milestone is complete when all of the following are true:

1. Starting without `GUARDRAIL_POLICY_PATH` preserves the existing gateway
   behavior and tests.
2. A valid policy is loaded and compiled once at startup.
3. A policy with `enabled: false` is validated but does not attach guardrails or
   alter the original request lifecycle.
4. An invalid configured policy prevents startup with a sanitized,
   variable-specific configuration error.
5. Configured email, phone-number, and credit-card findings are deterministically
   allowed, redacted, or blocked.
6. Blocked input never reaches the provider.
7. Redacted input reaches the provider without mutating the caller's input.
8. Every assistant choice is strictly parsed and validated against the schema.
9. Invalid output triggers no more than the configured number of retries.
10. Retry exhaustion never exposes invalid model output to the caller.
11. Fail-open and fail-closed runtime behavior is covered by tests.
12. Policy lifecycle and decision logs contain no prompt, response, schema, or
    detected PII values.
13. Existing error behavior for non-policy failures remains intact.
14. The full Bun test suite, deterministic pipeline scripts, type check, build,
    formatter check, and `git diff --check` pass.

## 22. Deferred Extensions

Later policy versions may add detector registries, confidence scores, output
replacement, fallback references, prompt-injection checks, content safety,
secrets detection, routing, multiple providers, external detectors, hot reload,
policy selection, retrieved-context checks, tool-call checks, and streaming.

Those features must be introduced through a new compatible policy contract or
an explicit `apiVersion` change. They must not be inferred from unknown fields
in `guardrails/v1`.
