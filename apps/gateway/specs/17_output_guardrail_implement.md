# Schema-Constrained Output Guardrail: Implementation Plan

## 1. Purpose and Status

This document turns the request in `16_output_guardrail.md` into an
implementation-ready specification for the in-process gateway SDK.

Implementation status (August 14, 2026): implemented. The repository loads an
inline or referenced JSON Schema, compiles it with Ajv, sends it as an optional
native provider constraint, validates every provider choice locally, performs
bounded repair calls, and prevents invalid output from reaching the caller.
The completed work closes the remaining gaps in the new request:

- allow the schema to be declared as an inline JSON-compatible object beside
  the YAML policy, while preserving the existing `schema_ref` form;
- make the JSON-object guarantee explicit rather than accepting arbitrary JSON
  values;
- classify validation failures without exposing response or schema content;
- produce one sanitized startup log when gateway construction rejects a
  malformed or unsupported schema; and
- document exact policy, retry, failure, observability, and compatibility
  contracts.

Verification completed with 145 automated tests, workspace type checks, SDK
build, declaration/package checks, side-effect import checks, and built Bun and
Node smoke checks.

The target request path is:

```text
load configured policy
  -> resolve exactly one inline or referenced schema
  -> validate and compile the schema during gateway construction
  -> accept traffic only after compilation succeeds

normalized ChatRequest
  -> input guardrails
  -> provider attempt
  -> parse each complete assistant choice as one JSON object
  -> validate every object against the compiled schema
       |-- all valid: return the provider response
       |-- invalid and retries remain: append a repair turn and call again
       `-- invalid and no retries remain: throw OUTPUT_GUARDRAIL_FAILED
```

In this specification, **force** means a gateway-boundary guarantee: when the
output guardrail is enabled and evaluation completes normally, the SDK never
returns a successful completion whose assistant content fails the configured
schema. The explicitly configured fail-open behavior for an unexpected
evaluator exception is the only runtime exception to that guarantee. “Force”
does not claim that every provider performs grammar-constrained decoding
internally.

## 2. Repository Baseline

### 2.1 Existing SDK boundary

The gateway is a provider-neutral, in-process TypeScript SDK. Callers use:

```ts
gateway.chat.completions.create(input, options);
```

The gateway does not start an HTTP listener. `ChatResponse` deliberately keeps
assistant content as a string, matching chat-completions semantics. When output
evaluation completes normally, the guardrail guarantees that this string
parses to a conforming JSON object; it does not replace the string with a parsed
object in the public response.

### 2.2 Existing output implementation

The current implementation already has these components:

| Area               | Current behavior                                                              |
| ------------------ | ----------------------------------------------------------------------------- |
| Policy             | Zero or one output rule using `validator: json_schema` and `schema_ref`       |
| Schema loading     | Relative JSON file, confined to the policy directory, at most 1 MiB           |
| References         | Internal references allowed; remote and cross-file references rejected        |
| Compilation        | Ajv Draft 2020-12, strict mode, during `ModelGateway.create()`                |
| Runtime parsing    | Trim the complete choice content, then call `JSON.parse()`                    |
| Runtime validation | Validate every returned choice; any invalid choice fails the attempt          |
| Failure action     | Immediately block or retry from zero through three times                      |
| Repair             | Append invalid assistant content and a schema-bearing user correction message |
| Exhaustion         | Throw generic `OUTPUT_GUARDRAIL_FAILED`, status `502`                         |
| Runtime exception  | Apply global `runtime_failure_mode: open                                      | closed` |
| Usage              | Aggregate usage across all provider attempts when every attempt reports it    |

### 2.3 Gaps relative to `16_output_guardrail.md`

1. A schema cannot currently be placed inline in the YAML policy.
2. The validator accepts any JSON Schema root, including boolean schemas and
   schemas whose successful instance can be an array, scalar, or `null`.
3. A malformed schema becomes a sanitized `ConfigurationError`, but gateway
   construction does not emit the requested rejection log.
4. Runtime decision metadata reports retry or block but not the sanitized class
   of violation.
5. The word “force” is not bounded explicitly; this can be mistaken for a
   promise of provider-native constrained decoding.

### 2.4 Contracts that remain stable

The implementation must preserve:

- the canonical `gateway.chat.completions.create()` operation;
- the `ModelProvider.complete(request, context)` abstraction;
- the public `ChatResponse` string-content shape;
- existing valid `schema_ref` policies;
- zero or one output rule in `guardrails/v1`;
- strict policy parsing and global rule-ID uniqueness;
- the existing retry range of zero through three additional calls;
- generic public output and guardrail-runtime errors;
- fail-open and fail-closed evaluator behavior;
- lifecycle stage names and attempt numbering;
- input guardrails running once before the first provider attempt;
- immutable caller input and repair-request construction;
- usage aggregation across retries;
- no-policy and `enabled: false` bypass behavior; and
- Bun source plus built Node.js 20+ support.

## 3. Confirmed Design Decisions

### 3.1 Enforcement is authoritative at the gateway boundary

Local parse-and-validate remains authoritative when a provider receives a
native structured-output constraint. A completion is successful only after
local validation passes.

This provides one consistent contract for custom providers and
OpenAI-compatible endpoints with different structured-output capabilities.
The OpenAI-compatible adapter sends the schema through native Chat Completions
Structured Outputs by default. Compatible endpoints that do not implement that
extension can disable the upstream constraint while retaining local validation.

### 3.2 The output must be a JSON object

For this guardrail, valid assistant content must satisfy both conditions:

1. the complete trimmed content parses as JSON; and
2. the parsed value is a non-null object that is not an array and satisfies the
   configured JSON Schema.

Examples:

| Assistant content                 | Result                               |
| --------------------------------- | ------------------------------------ |
| `{"status":"ok"}`                 | Continue to schema validation        |
| `  {"status":"ok"}\n`             | Continue to schema validation        |
| ` ```json\n{"status":"ok"}\n``` ` | Invalid JSON for this contract       |
| `Result: {"status":"ok"}`         | Invalid JSON for this contract       |
| `[1, 2]`                          | Invalid because the root is an array |
| `"ok"`                            | Invalid because the root is a string |
| `null`                            | Invalid because the root is null     |

The gateway does not extract JSON from prose, remove Markdown fences, coerce
types, remove unknown properties, or populate schema defaults.

### 3.3 Inline and referenced schemas are both supported

An output rule must contain exactly one of:

- `schema`, holding an inline JSON-compatible YAML mapping; or
- `schema_ref`, holding the existing relative `.json` file path.

Supporting both meets the new inline authoring request without breaking
deployed policies or requiring large schemas to be embedded in YAML.

### 3.4 Invalid schemas are startup configuration failures

Schemas are policy configuration, not request data. They are loaded and
compiled before the gateway accepts traffic. A malformed, unsupported, or
unsafe schema therefore prevents `ModelGateway.create()` from resolving.

There is no `ChatResponse` to return in this condition because no completion
request has run. “Log a valid response” from the source request is implemented
as:

- one sanitized `gateway.guardrail_policy_rejected` error log when construction
  is performed through `ModelGateway.create()` with a logger;
- a sanitized `ConfigurationError` for the caller; and
- no schema source, filesystem details, Ajv diagnostics, or nested property
  names in either output.

Direct callers of the low-level `loadGuardrailPolicy()` function receive the
same `ConfigurationError` but no automatic log because that function does not
own a logger.

### 3.5 Existing repair retries remain the portable forcing mechanism

When an attempt is invalid and its rule uses `on_failure.type: retry`, the
gateway asks the provider to correct the exact invalid response. Every repair
response is parsed and validated again. If no valid response is produced
within the configured bound, the gateway returns no model content and throws
`OUTPUT_GUARDRAIL_FAILED`.

### 3.6 Policy presence controls enablement

The output guardrail is active when all of these are true:

- a policy path is configured;
- the loaded policy has `enabled: true` or omits `enabled`; and
- the policy contains one output rule.

An absent output rule means output evaluation immediately allows the current
response. A policy with `enabled: false` is still fully parsed and schema
validated during construction, but no guardrail hub is attached at runtime.
This preserves the current rule that disabled configuration is not allowed to
rot unnoticed.

## 4. Scope

### 4.1 Goals

1. Add inline object schemas without breaking `schema_ref`.
2. Require exactly one schema source per output rule.
3. Guarantee object-root JSON at the SDK return boundary.
4. Compile all configured schemas during gateway construction.
5. Reject unsupported schema dialects and external references without network
   access.
6. Keep validation strict and non-mutating.
7. Validate every provider choice deterministically.
8. Retry invalid output only within the configured bound.
9. Never return invalid model content after retry exhaustion.
10. Preserve provider-neutral behavior and custom-provider compatibility.
11. Emit sanitized validation categories for operations and tests.
12. Emit a sanitized schema-rejection startup record.
13. Keep response content, schema contents, Ajv errors, and repair prompts out
    of lifecycle events and logs.
14. Add unit, policy-loader, pipeline, provider, package, and smoke coverage.
15. Send an optional native JSON Schema constraint to capable providers without
    weakening local enforcement or breaking existing custom providers.

### 4.2 Non-goals

- changing `ChatResponse.choices[].message.content` from a string to an object;
- returning a second parsed-object field;
- allowing a request caller to supply or override a schema dynamically;
- selecting schemas by model, tenant, route, or message content;
- supporting more than one output rule in `guardrails/v1`;
- validating partial streaming chunks or adding streaming support;
- extracting JSON from Markdown or natural-language prose;
- transforming an invalid value into a valid value locally;
- applying schema defaults, type coercion, or property removal;
- enabling remote schema downloads;
- supporting cross-file `$ref` resolution in this policy version;
- sending schema diagnostics or invalid content to SDK callers;
- logging full schemas, invalid output, or model prompts;
- promising that all upstream providers implement JSON-schema constrained
  decoding; or
- rerunning input guardrails against gateway-generated repair turns.

## 5. Policy Contract

### 5.1 Inline form

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: structured-gateway-output
  version: 1

defaults:
  runtime_failure_mode: closed
  maximum_retries: 1

output:
  - id: require-gateway-result
    validator: json_schema
    schema:
      $schema: https://json-schema.org/draft/2020-12/schema
      type: object
      properties:
        status:
          type: string
          enum: [ok, error]
        message:
          type: string
          minLength: 1
      required: [status, message]
      additionalProperties: false
    on_failure:
      type: retry
      maximum_retries: 1
      repair_prompt: Correct the response to match the required JSON object.
```

### 5.2 Referenced form

Existing policy files remain valid:

```yaml
output:
  - id: require-gateway-result
    validator: json_schema
    schema_ref: schemas/gateway-result.json
    on_failure:
      type: block
```

### 5.3 Exactly-one rule

These configurations are rejected:

```yaml
# Neither source
validator: json_schema
on_failure: { type: block }
```

```yaml
# Ambiguous duplicate sources
validator: json_schema
schema: { type: object }
schema_ref: schemas/result.json
on_failure: { type: block }
```

### 5.4 Output rule shape

The strict YAML fields are:

```ts
interface ParsedOutputRule {
  id: string;
  validator: "json_schema";
  schemaSource:
    { type: "inline"; value: unknown } | { type: "reference"; path: string };
  onFailure:
    | { type: "block" }
    | {
        type: "retry";
        maximumRetries: number;
        repairPrompt?: string;
      };
}
```

`description` is not added to output rules in this change. It can be proposed
separately if policy documentation needs it; silently accepting it would weaken
the current unknown-field contract.

### 5.5 Failure action

`on_failure` remains required.

For `type: block`:

- `maximum_retries` is rejected;
- `repair_prompt` is rejected; and
- the first invalid attempt ends with `OUTPUT_GUARDRAIL_FAILED`.

For `type: retry`:

- `maximum_retries` defaults to `defaults.maximum_retries`;
- the value must be an integer from `0` through `3`;
- the value counts additional calls after the first provider call; and
- `repair_prompt`, when present, is trimmed, non-empty, and at most 2,000 UTF-16
  code units.

| `maximum_retries` | Maximum provider attempts |
| ----------------: | ------------------------: |
|                 0 |                         1 |
|                 1 |                         2 |
|                 2 |                         3 |
|                 3 |                         4 |

## 6. Schema Acceptance Contract

### 6.1 Supported dialect

The output validator uses JSON Schema Draft 2020-12.

- An omitted `$schema` means Draft 2020-12.
- If `$schema` is present at the root, it must equal
  `https://json-schema.org/draft/2020-12/schema`.
- Other drafts and custom meta-schema URIs are rejected at startup.

Being explicit avoids accidental dialect changes when Ajv dependencies are
updated.

### 6.2 Root-object declaration

The root schema must be a mapping with `type: object`.

The first implementation intentionally rejects:

- boolean schemas;
- root arrays;
- omitted root `type`;
- union types such as `type: [object, "null"]`; and
- indirect object roots expressed only through `anyOf`, `oneOf`, or `$ref`.

This narrow contract makes the promised JSON-object shape statically visible
during policy review. Nested schemas may use the complete supported Draft
2020-12 vocabulary, including internal references and combinators.

### 6.3 JSON-compatible inline values

An inline schema must recursively contain only JSON data:

- objects with string keys;
- arrays;
- strings;
- booleans;
- `null`; and
- finite numbers.

Non-finite values and implementation-specific YAML values are rejected. YAML
aliases remain disabled for the whole policy.

### 6.4 Reference safety

Referenced schemas retain the existing protections:

- `schema_ref` is a non-empty relative path;
- the extension is `.json`, case-insensitively;
- the path resolves relative to the real policy file directory;
- `realpath()` resolves symlinks before containment is checked;
- traversal and symlink escape outside the policy directory are rejected;
- the target must be a regular file;
- the file is limited to 1 MiB before it is read; and
- the entire file must parse as one JSON value.

Inline schemas are already bounded by the existing 1 MiB policy-file limit.
No second, inconsistent byte limit is added.

### 6.5 Reference behavior

Internal references are supported:

```json
{
  "type": "object",
  "$defs": {
    "status": { "type": "string", "enum": ["ok", "error"] }
  },
  "properties": {
    "status": { "$ref": "#/$defs/status" }
  },
  "required": ["status"],
  "additionalProperties": false
}
```

The loader recursively rejects `$ref` and `$dynamicRef` when their values do
not begin with `#`. It also rejects a non-string reference value. The runtime
must not configure an Ajv `loadSchema` callback and must perform no network I/O.

### 6.6 Compilation

Use the existing dedicated Ajv 2020 implementation with:

```ts
{
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
}
```

Continue installing `ajv-formats` in fast mode. A schema is accepted only when
Ajv validates and compiles it successfully.

Compilation is performed once per gateway construction, never once per
completion and never once per retry. No parsed output or validation result is
cached across requests.

### 6.7 Sanitized configuration error

All schema-source, parsing, dialect, reference, root-shape, and compilation
failures throw:

```text
ConfigurationError
GUARDRAIL_POLICY_PATH contains an invalid or unsupported output schema.
```

The public message deliberately does not distinguish filesystem existence,
schema syntax, keyword, reference, or compiler details. Tests that need exact
diagnostics should target private helper behavior only if such helpers are
introduced; callers must not depend on Ajv error strings.

## 7. Runtime Output Evaluation

### 7.1 Evaluation order

For each provider attempt:

1. require the provider adapter to return its normal validated `ChatResponse`;
2. inspect choices in array order;
3. enforce the structured-output character bound;
4. trim outer whitespace from the complete assistant content;
5. parse with `JSON.parse()`;
6. verify that the parsed root is an object, is non-null, and is not an array;
7. validate the object with the precompiled schema; and
8. allow the attempt only if every choice passes.

Do not parse or inspect `finishReason` to waive schema enforcement. A truncated
or length-limited response that is invalid follows the same retry/block policy.

### 7.2 Output-size safety bound

Before `JSON.parse()`, each assistant choice is limited to 1,000,000 UTF-16 code
units. This protects local parsing and repair-prompt construction from an
unbounded provider string.

An oversized choice is a normal `output_too_large` policy violation. It may be
retried when the rule permits retry, but the oversized content must not be
copied into the repair conversation. Instead, append a fixed assistant marker:

```text
[Previous model response omitted because it exceeded the output guardrail limit.]
```

The repair instruction and schema are still appended normally. The omitted
content must not appear in logs, lifecycle metadata, public errors, or the next
provider request.

### 7.3 Multiple choices

Every returned choice must conform. If more than one choice fails, the first
invalid choice in response-array order determines:

- `violationType`;
- the invalid content used for repair when it is within the size limit; and
- deterministic test expectations.

The gateway does not return only the valid subset and does not merge objects
across choices.

### 7.4 Sanitized violation types

Add:

```ts
export type OutputViolationType =
  "output_too_large" | "invalid_json" | "non_object" | "schema_mismatch";
```

Internal output results become:

```ts
export type OutputGuardrailResult =
  | { decision: "allow" }
  | {
      decision: "retry";
      ruleId: string;
      violationType: OutputViolationType;
      repairRequest: ChatRequest;
    }
  | {
      decision: "block";
      ruleId: string;
      violationType: OutputViolationType;
    };
```

`violationType` describes only the broad failure class. Do not expose:

- the response content;
- the parsed value;
- schema paths or instance paths;
- failed property names;
- expected or actual values;
- Ajv keyword names or error arrays; or
- choice content hashes.

`OutputGuardrailResult` is exported today, so adding a required field to its
retry and block variants is a source-level API change for custom hubs. To avoid
breaking custom implementations in the current minor release, implement the
field as optional in the public type for `guardrails/v1`, while
`ConfiguredGuardrailHub` always supplies it. It can become required only in a
future major version.

### 7.5 Validation purity

Validation must not mutate the parsed object, provider response, request, or
caller input. Ajv options that coerce values, add defaults, or remove properties
remain disabled.

## 8. Repair Request Contract

### 8.1 Construction

When retry is permitted, create a new request that preserves the exact request
used for the failed attempt, including:

- model;
- all post-input-guardrail messages;
- prior repair turns, if any;
- temperature, when present; and
- max token setting, when present.

Append two messages:

1. an `assistant` message containing the invalid content, except for the fixed
   oversized-output marker; and
2. a `user` message containing the repair instruction, serialized schema, and
   an instruction to return only one JSON object without Markdown or prose.

The built-in instruction is:

```text
Correct the previous response so it satisfies the JSON Schema.
```

The final fixed instruction is:

```text
Return only the corrected JSON object without Markdown or commentary.
```

The user-configured `repair_prompt` is inserted before the schema and cannot
remove the final fixed instruction.

### 8.2 Schema serialization

Serialize the already loaded schema with `JSON.stringify()`. Do not reread a
referenced file during retry. Startup validation guarantees that serialization
is defined and deterministic for the in-memory JSON value.

### 8.3 Retry sequencing

- Attempt numbering starts at `1`.
- `maximum_retries` counts attempts after attempt `1`.
- Each attempt is validated before another provider call can begin.
- Input guardrails are not rerun against generated repair turns.
- All attempts use the same request context and request ID.
- A retry extends the current repair conversation rather than returning to the
  original prompt.
- The pipeline's `maximumAttempts` check remains an independent defense against
  a custom hub requesting too many attempts.

### 8.4 Retry exhaustion

If the final permitted attempt remains invalid, convert the result to block
without another provider call. Preserve the most recent `ruleId` and optional
`violationType` in internal decision metadata.

## 9. Public Success and Error Contracts

### 9.1 Successful completion

The final `GatewayExecutionResult.response` is the final conforming provider
response. Each choice content remains a JSON string.

The existing `providerRequest` result field remains the request sent on the
first provider call after input guardrails. It does not become the final repair
request and may contain prompt data, as already documented.

### 9.2 Policy violation

When the rule blocks immediately or retry budget is exhausted, throw:

```ts
new GatewayError(
  "OUTPUT_GUARDRAIL_FAILED",
  "The model response did not satisfy the output policy.",
  502,
);
```

No provider content, rule ID, violation type, schema data, or compiler detail is
included in the public error.

### 9.3 Evaluator runtime failure

A thrown implementation error is different from a normal schema violation.

For `runtime_failure_mode: closed`:

- discard the current provider response;
- throw `GUARDRAIL_EVALUATION_FAILED`, status `500`; and
- emit a sanitized runtime-failure log.

For `runtime_failure_mode: open`:

- return the current, unvalidated provider response;
- emit `gateway.guardrail_runtime_failure` with `action: fail_open`; and
- do not fabricate a successful validation decision.

Fail-open is an explicit availability-over-enforcement choice. Documentation
must warn that it weakens the gateway-boundary schema guarantee during runtime
evaluator failures. Normal invalid JSON and schema mismatch never use fail-open.

### 9.4 Provider errors during repair

Authentication, rate-limit, timeout, upstream, and invalid provider-envelope
errors on a repair attempt keep their existing provider error codes. They are
not rewritten as output-policy violations because no evaluable assistant choice
was obtained.

## 10. Usage Accounting

Keep the existing accounting rule:

- sum prompt, completion, and total tokens across all attempts when every
  attempt reports usage; or
- omit usage from the successful final response if any attempt omits it.

Never report only the final attempt's usage after the gateway initiated repair
calls. Failed calls that produce no parsed `ChatResponse` cannot contribute
usage because the provider abstraction does not supply it.

## 11. Lifecycle and Observability

### 11.1 Successful first attempt

```text
received
validated
input_guardrails_started
input_guardrails_completed
provider_started                 attempt=1
provider_completed               attempt=1
output_guardrails_started        attempt=1
output_guardrails_completed      attempt=1, decision=allow
completed
```

### 11.2 One repair attempt

```text
provider_started                 attempt=1
provider_completed               attempt=1
output_guardrails_started        attempt=1
output_guardrails_completed      attempt=1, decision=retry
retry_started                    attempt=2
provider_started                 attempt=2
provider_completed               attempt=2
output_guardrails_started        attempt=2
output_guardrails_completed      attempt=2, decision=allow
completed
```

No new lifecycle stage is required. `output_guardrails_completed` may add the
sanitized `violationType` when the decision is retry or block.

### 11.3 Decision log

Continue emitting `gateway.guardrail_decision` with:

- request ID;
- phase `output`;
- policy name and version;
- attempt and maximum attempts;
- decision;
- rule IDs for retry or block; and
- optional sanitized violation type.

Do not log response content, parsed objects, schema content, repair messages,
Ajv errors, or provider bodies.

### 11.4 Malformed-schema startup log

When `ModelGateway.create()` rejects output schema loading or compilation,
emit exactly one record through the configured logger:

```ts
logger.error({
  event: "gateway.guardrail_policy_rejected",
  phase: "startup",
  reasonCode: "invalid_output_schema",
});
```

Do not include:

- the configured path;
- policy or schema source text;
- schema IDs, titles, descriptions, property names, `const` values, or examples;
- filesystem or symlink targets;
- YAML, JSON, or Ajv exception messages; or
- stack traces.

The logging call must not replace or mask the original `ConfigurationError` if
a user-supplied logger throws. The implementation should make one best-effort
call and then reject construction with the configuration error.

Policy failures unrelated to the output schema keep current behavior in this
milestone. Generalizing `gateway.guardrail_policy_rejected` to every policy
failure is separate observability work.

### 11.5 Privacy invariant

The following values must not appear in SDK-produced logs or lifecycle data:

- original user messages;
- invalid or repaired model content;
- complete schema documents;
- schema property paths or validation values;
- custom repair prompts;
- provider request or response bodies; and
- underlying parser or validator error messages.

Applications may still access the successful response and the documented
`providerRequest` field. Those caller-owned values are outside SDK logging.

## 12. Provider Interaction

### 12.1 Provider-call constraint

Keep `ChatRequest` unchanged. Add an optional third argument to
`ModelProvider.complete()`:

```ts
interface ProviderCompletionOptions {
  outputJsonSchema?: {
    name: string;
    schema: unknown;
    strict: true;
  };
}
```

Existing custom provider implementations with two method arguments remain
structurally compatible and may ignore the option. The pipeline supplies the
same normalized constraint on the initial attempt and every repair attempt.

### 12.2 OpenAI-compatible mapping

By default, `OpenAICompatibleProvider` maps the constraint to:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "guardrail_rule_name",
      "schema": {},
      "strict": true
    }
  }
}
```

The name is derived from the output rule ID, normalized to letters, digits,
underscores, or dashes, and limited to 64 characters. The provider never logs
the schema.

Set `structuredOutputMode: "disabled"` on the adapter for compatible endpoints
that do not implement native JSON Schema output. This disables only the
upstream request field; local parse, validation, retry, and block behavior stay
active.

Do not retry automatically without `response_format` when an endpoint rejects
the request. Such fallback would create an unbudgeted provider call and could
hide configuration drift. Provider errors retain their existing mapping.

Native strict mode supports a provider-specific subset of JSON Schema. Local
Ajv validation remains authoritative and may support schemas beyond an
upstream endpoint's subset; those deployments must either use a compatible
schema or disable native mode explicitly.

## 13. Code Change Plan

### 13.1 `src/guardrails/config/policy-loader.ts`

1. Add `schema` to the allowed output-rule fields.
2. Require exactly one of `schema` and `schema_ref`.
3. Normalize both forms into one `schemaSource` discriminated union.
4. Validate inline values as JSON-compatible data.
5. Resolve referenced schemas with the current confinement rules.
6. Apply dialect, root-object, and external-reference checks to both forms.
7. Compile with `CompiledJsonSchemaValidator`.
8. Collapse all schema-specific load and compile failures into the stable
   sanitized configuration message.
9. Retain existing output action and rule-ID validation.

Schema validation must still occur when the top-level policy is disabled.

### 13.2 `src/guardrails/output/json-schema-validator.ts`

1. Add a schema-acceptance helper or constructor checks for the fixed 2020-12
   dialect and explicit object root.
2. Preserve strict, non-mutating Ajv options.
3. Keep the public `validate(value): boolean` API.
4. Do not expose `validateFunction.errors` outside this module.
5. Ensure the constructor performs no filesystem or network work.

The policy loader remains responsible for converting specific exceptions into
sanitized `ConfigurationError` values.

### 13.3 `src/guardrails/types.ts`

1. Add `OutputViolationType`.
2. Add optional `violationType` to public retry and block result variants for
   minor-version compatibility.
3. Keep `OutputPolicyRule.schema` as the normalized loaded schema value so
   repair construction is independent of its source.
4. Do not expose a schema file path at runtime.

### 13.4 `src/guardrails/guardrail-hub.ts`

1. Extract deterministic per-choice parsing into an output evaluator helper.
2. Enforce the output-size bound before parsing.
3. Require a non-array object root before schema validation.
4. Return the first invalid choice's sanitized violation type.
5. Use the fixed omission marker for oversized content.
6. Preserve immutable repair-request construction.
7. Continue validating every choice and every attempt.

A dedicated `src/guardrails/output/output-evaluator.ts` is preferred so parser,
root-type, size, and choice-order behavior can be unit tested without the input
coordinator or pipeline.

### 13.5 `src/pipeline/gateway-pipeline.ts`

1. Propagate optional `violationType` into output completion lifecycle metadata
   and decision logs.
2. Preserve it when converting an over-budget retry result to block.
3. Keep the generic public output error unchanged.
4. Do not change input evaluation, provider sequencing, or usage aggregation.

### 13.6 `src/model-gateway.ts`

1. Catch only the sanitized invalid-output-schema configuration rejection from
   policy loading.
2. Best-effort emit `gateway.guardrail_policy_rejected` through the supplied
   logger.
3. Rethrow the original `ConfigurationError`.
4. Do not emit `gateway.guardrail_policy_loaded` when policy construction
   fails.

Use a stable internal discriminator rather than matching free-form error text
if `ConfigurationError` is extended. Do not add schema details to the public
error class.

### 13.7 `src/providers/model-provider.ts`

1. Add `JsonSchemaOutputConstraint` and `ProviderCompletionOptions`.
2. Add the optional provider-call options argument to `complete()`.
3. Keep existing two-argument provider implementations structurally
   compatible.
4. Do not add schema data to `ChatRequest` or `GatewayExecutionResult`.

### 13.8 `src/providers/openai-compatible-provider.ts`

1. Map an output constraint to Chat Completions `response_format.json_schema`.
2. Send `strict: true` and a provider-safe name no longer than 64 characters.
3. Default `structuredOutputMode` to `json_schema`.
4. Support `structuredOutputMode: disabled` without disabling local guardrails.
5. Preserve existing provider error mapping and avoid silent fallback calls.

### 13.9 Documentation and examples

Update:

- `policies/example-policy.yaml` with a commented inline example and retain a
  referenced example for larger schemas;
- `README.md` with the gateway-boundary definition of force;
- the malformed-schema startup behavior;
- object-root and strict complete-content rules;
- retry cost and fail-open warning; and
- native structured-output mapping and the explicit disable option.

Do not replace the existing example schema file; it remains useful coverage for
`schema_ref`.

## 14. Test Plan

### 14.1 Policy loader

Add deterministic tests that accept:

- a minimal inline Draft 2020-12 object schema;
- an inline schema with an internal `$ref`;
- the existing referenced schema form;
- an omitted `$schema` interpreted as Draft 2020-12;
- a disabled policy with a valid schema; and
- retry defaults inherited from `defaults.maximum_retries`.

Add rejection tests for:

- neither schema source;
- both schema sources;
- malformed referenced JSON;
- referenced path escape and symlink escape;
- absolute reference and non-JSON extension;
- referenced file above 1 MiB;
- external `$ref` and `$dynamicRef` in either source form;
- non-string reference values;
- unsupported `$schema` dialect;
- boolean schema;
- array or scalar inline schema;
- root schema without `type`;
- root type other than the exact string `object`;
- invalid or unknown strict-mode keywords;
- non-finite inline numbers if the YAML parser can produce them;
- an unknown output-rule field;
- more than one output rule;
- duplicate rule IDs across input and output; and
- invalid retry-only fields on a block action.

Every schema-specific rejection through `ModelGateway.create()` must have the
same sanitized public configuration message.

### 14.2 Output evaluator

Cover:

- valid compact object JSON;
- valid object JSON with surrounding whitespace;
- malformed JSON;
- fenced JSON;
- prose-prefixed and prose-suffixed JSON;
- valid array JSON rejected as `non_object`;
- scalar and null JSON rejected as `non_object`;
- object rejected as `schema_mismatch`;
- no type coercion;
- no default insertion;
- no removal of additional properties;
- exactly-at-limit content;
- over-limit content classified as `output_too_large`;
- all choices valid;
- first choice invalid;
- later choice invalid; and
- stable first-invalid selection when several choices fail differently.

### 14.3 Repair construction

Verify:

- the original request and caller input are unchanged;
- the invalid assistant content and repair user turn are appended in order;
- a custom repair prompt appears before the schema;
- the final JSON-only instruction is always last;
- inline and referenced schemas serialize identically after loading;
- an oversized response uses the fixed omission marker and is not copied;
- subsequent retries extend the previous repair request;
- model, temperature, and max tokens are preserved; and
- repair messages are not sent through input guardrails again.

### 14.4 Pipeline

Cover these provider-attempt cases:

| Initial output        | Repair outputs   | Expected result                            |                 Calls |
| --------------------- | ---------------- | ------------------------------------------ | --------------------: |
| valid                 | none             | success                                    |                     1 |
| invalid, block action | none             | `OUTPUT_GUARDRAIL_FAILED`                  |                     1 |
| invalid, retries `0`  | none             | `OUTPUT_GUARDRAIL_FAILED`                  |                     1 |
| invalid               | valid            | success                                    |                     2 |
| invalid               | invalid          | `OUTPUT_GUARDRAIL_FAILED`                  | 2 with retry budget 1 |
| invalid               | invalid, valid   | success                                    | 3 with retry budget 2 |
| oversized             | valid            | success, oversized text absent from repair |                     2 |
| valid                 | none             | usage unchanged                            |                     1 |
| invalid with usage    | valid with usage | summed usage                               |                     2 |
| invalid without usage | valid with usage | usage omitted                              |                     2 |

Also assert:

- lifecycle ordering and attempt metadata;
- `violationType` appears only on retry/block decisions;
- the final valid response retains its own ID, model, choices, and finish reason;
- the public error contains no invalid content or schema details;
- provider failures during repair keep provider error codes;
- a custom hub cannot exceed `maximumAttempts`;
- no output rule allows immediately; and
- no-policy and disabled-policy calls retain their current lifecycle.

### 14.5 Runtime failure mode

Use a throwing output evaluator or hub to verify:

- fail-open returns the current provider response unchanged;
- fail-closed returns `GUARDRAIL_EVALUATION_FAILED`;
- a normal schema mismatch never enters runtime-failure handling;
- logs never include thrown exception messages or response content; and
- provider-call counts are correct in both modes.

### 14.6 Startup logging

Through `ModelGateway.create()` with a recording logger, verify:

- malformed schema emits exactly one policy-rejected event;
- the event contains only the stable event, phase, and reason code;
- `gateway.guardrail_policy_loaded` is absent;
- valid schema emits the existing loaded event and no rejected event;
- direct `loadGuardrailPolicy()` does not log;
- a throwing user logger does not replace the configuration error; and
- serialized records do not contain schema text, property names, paths, or Ajv
  diagnostics.

### 14.7 Provider and package compatibility

Confirm:

- the OpenAI-compatible provider payload is unchanged by the presence of an
  output schema;
- custom `ModelProvider` implementations need no new method or capability;
- TypeScript source checks pass;
- Bun tests pass;
- built ESM runs under Node.js 20+;
- package entry import remains side-effect free; and
- package contents do not accidentally include policy schema files unless they
  were already intentionally published.

### 14.8 Smoke test

Add a deterministic recording-provider smoke that performs no network call:

1. construct a gateway from a referenced-schema policy;
2. return invalid content, then valid JSON;
3. assert two provider calls and one valid returned response;
4. repeat with an inline-schema policy;
5. assert identical runtime decisions; and
6. attempt construction with a malformed schema and assert sanitized rejection.

An optional real-provider smoke may verify practical repair success, but it is
not a deterministic CI gate and must not print invalid model content.

## 15. Implementation Phases

### Phase 0: Lock compatibility

- Add characterization tests for all current `schema_ref`, retry, usage,
  lifecycle, and public error behavior.
- Confirm the current Bun and built Node checks are green.

Exit criterion: the existing output contract is captured before code changes.

### Phase 1: Normalize schema sources

- Add strict inline `schema` parsing.
- Enforce exactly one source.
- Apply common acceptance checks after source resolution.
- Preserve the normalized schema value in `LoadedGuardrailPolicy`.

Exit criterion: inline and referenced forms compile to equivalent loaded rules.

### Phase 2: Enforce object output and size safety

- Add root-object schema checks at startup.
- Add the output evaluator helper.
- Enforce content size, exact JSON parsing, object root, schema validation, and
  stable violation classification.
- Add oversized-content omission during repair.

Exit criterion: no successful configured call can return a non-object or
schema-invalid choice.

### Phase 3: Observability and error hardening

- Propagate optional violation metadata.
- Preserve metadata at retry exhaustion.
- Add best-effort malformed-schema startup logging.
- Audit all records for content leakage.

Exit criterion: operators can distinguish broad violation classes without
seeing content or schema details.

### Phase 4: Documentation and release verification

- Update README and policy examples.
- Run unit, type, build, package, Bun, Node, and deterministic smoke checks.
- Record the behavior change for schemas that previously allowed non-object
  roots.

Exit criterion: all acceptance criteria below are verified in supported
runtimes.

## 16. Compatibility and Migration

### 16.1 Compatible behavior

- Valid referenced object schemas continue to work unchanged.
- Existing retry and block actions retain their meaning.
- Existing callers continue receiving JSON as assistant string content.
- Custom providers receive the same `ChatRequest` shape.
- Existing lifecycle stage names and public gateway errors remain stable.

### 16.2 Intentional tightening

Policies using any of these currently compilable schemas will be rejected after
this change:

- `true` or `false` boolean schemas;
- root array or scalar schemas;
- schemas without explicit root `type: object`;
- object behavior expressed only indirectly through a root `$ref` or
  combinator; and
- non-2020-12 schema dialect declarations.

Before release, search all repository and deployment policies for these forms.
If external users depend on them, introduce the tightening in a new policy API
version instead of changing `guardrails/v1` in place.

### 16.3 Versioning recommendation

Inline `schema` support is additive. The root-object restriction is not
additive for every currently valid `guardrails/v1` schema.

For this private, unpublished package, update `guardrails/v1` directly only if
the deployment policy audit finds no non-object schemas. Otherwise:

- keep legacy `schema_ref` semantics in `guardrails/v1`; and
- introduce the object-only contract under `guardrails/v2`.

The implementation must not silently reinterpret an existing accepted schema.

## 17. Security, Privacy, and Reliability Analysis

| Risk                                           | Mitigation                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| Invalid output reaches caller                  | Local validation is authoritative; retry or block before return             |
| Provider claims schema support but violates it | Native constraint never replaces local validation                           |
| Remote schema fetch or SSRF                    | Reject non-fragment references; configure no async loader                   |
| Policy path escape                             | Resolve real paths and confine referenced schemas to policy directory       |
| Schema compilation denial of service           | 1 MiB source bound, strict parsing, compile once at startup                 |
| Huge model string stresses parsing or retry    | 1,000,000-code-unit choice bound and fixed omission marker                  |
| Validator mutates model value                  | Disable coercion, defaults, and property removal                            |
| Invalid content leaks through errors           | Generic public error with no cause details                                  |
| Invalid content leaks through logs             | Sanitized categories only; explicit privacy tests                           |
| Schema secrets leak through startup logs       | Stable reason code only; never log schema or paths                          |
| Repair creates unbounded provider spend        | Zero-to-three retry bound and independent pipeline attempt cap              |
| Repair prompt is overridden by invalid output  | Invalid output has assistant role; fixed JSON-only user instruction is last |
| Fail-open breaks enforcement guarantee         | Explicit documentation and sanitized runtime-failure event                  |
| Multiple choices create partial success        | Require every choice to conform                                             |
| Dependency update changes dialect behavior     | Dedicated Ajv 2020 import, exact dialect rule, regression tests             |
| Existing non-object schema breaks              | Policy audit and policy-version migration gate                              |
| Endpoint lacks native JSON Schema support      | Explicitly disable upstream structured output; retain local enforcement     |

## 18. Acceptance Criteria

The feature is complete when all of the following are true:

1. An enabled policy accepts exactly one inline or referenced schema.
2. Existing valid referenced object-schema policies still load unchanged.
3. Inline schemas are strict JSON-compatible Draft 2020-12 object schemas.
4. Malformed, unsupported, external-reference, and non-object schemas prevent
   gateway construction.
5. `ModelGateway.create()` emits one sanitized rejection record for an invalid
   output schema and rethrows a sanitized `ConfigurationError`.
6. No schema loading or validation path performs network I/O.
7. Every choice returned after normal output evaluation parses as a complete
   JSON object and satisfies the compiled schema.
8. Fenced, prose-wrapped, array, scalar, null, oversized, and schema-invalid
   output is never returned as success except under the explicitly configured
   fail-open behavior for an unexpected evaluator exception.
9. Invalid output is retried only when configured and never beyond the maximum
   attempt count.
10. Oversized output is not copied into a repair request.
11. Exhaustion throws the unchanged generic `OUTPUT_GUARDRAIL_FAILED` error.
12. Runtime evaluator exceptions obey the configured global failure mode.
13. Lifecycle and logs contain stable attempt, decision, rule, and optional
    violation metadata without content or schema details.
14. Caller input, provider response objects, and parsed JSON values are not
    mutated by validation or repair construction.
15. Usage across repair attempts follows the existing complete-or-omitted
    aggregation rule.
16. Existing custom providers require no implementation change; the new
    provider-call options argument is optional.
17. Bun tests, type checks, build, built Node checks, package checks, and
    deterministic smoke checks pass.
18. The policy-version migration gate for existing non-object schemas is
    resolved before release.

## 19. Explicit Assumptions and Deferred Decisions

This plan proceeds with these assumptions inferred from the current gateway:

- “JSON object” excludes arrays, scalars, and null.
- A fixed policy schema is loaded during gateway construction rather than
  supplied per completion request.
- “Force” means normal output evaluation never returns invalid output, using
  validation plus bounded repair or block; the configured runtime fail-open
  exception remains explicit.
- The existing output rule, public response shape, and retry limit should remain
  compatible.
- Malformed policy configuration should prevent startup, not create a fake chat
  response.

The following require a separate product decision only if they are desired in
a later milestone:

1. automatic provider capability discovery or silent fallback;
2. per-request or per-tenant schemas;
3. more than one output rule or rule routing;
4. returning parsed objects in the public SDK result;
5. streaming structured-output validation; and
6. support for non-object JSON roots.

None of these deferred choices blocks the implementation described here.
