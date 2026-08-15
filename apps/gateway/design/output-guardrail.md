# Structured Output Guardrail Design

## Purpose

The structured output guardrail requires every textual assistant choice to be a
JSON object that satisfies one configured JSON Schema. It can either block an
invalid model response or make a bounded repair request and validate the new
response again.

The gateway uses two complementary controls:

1. It asks compatible providers to constrain generation with the schema.
2. It independently parses and validates the returned content locally.

Local validation is authoritative. Provider-side structured output improves the
chance of a valid first response but does not replace gateway enforcement.

## Design goals

The implementation is designed to:

- make the successful response shape explicit and deterministic;
- reject invalid JSON, non-object JSON, fields disallowed by the schema, and
  other schema violations without coercion;
- support inline and safely referenced JSON Schemas;
- fail during startup when the policy schema is invalid;
- avoid returning a known-invalid model response;
- support a small, bounded repair budget;
- keep provider and custom-provider contracts independent of a specific schema
  library; and
- expose sanitized violation metadata for operations.

The following are not goals:

- inventing values that are absent from model output;
- converting arbitrary field names into data the model cannot know;
- applying defaults, coercing types, or removing additional properties;
- returning a configured fallback object;
- validating tool-call arguments through the output rule;
- supporting streaming output; or
- guaranteeing that semantically incorrect data is truthful merely because its
  JSON shape is valid.

## Position in the response flow

For a text completion, the relevant flow is:

```text
normalized request
  -> input guardrails
  -> tool-definition guardrails
  -> provider call with optional upstream JSON Schema constraint
  -> classify response as text or tool calls
  -> local JSON parsing and schema validation for text
       -> allow
       -> repair and call provider again
       -> block
```

Tool-call responses take the tool-call validation path and do not pass through
the output JSON Schema. If a request offers tools but the provider returns an
ordinary text response, the output guardrail still applies.

## Policy contract

The policy accepts zero or one output rule:

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: structured-response
  version: 1

defaults:
  runtime_failure_mode: closed
  maximum_retries: 1

output:
  - id: require-api-result
    validator: json_schema
    schema:
      type: object
      properties:
        status:
          type: string
          enum: [ok, error]
        message:
          type: string
        error:
          anyOf:
            - type: string
            - type: "null"
      required: [status, message, error]
      additionalProperties: false
    on_failure:
      type: retry
      maximum_retries: 1
      repair_prompt: Correct the response to match the required schema.
```

### Output rule fields

- `id` is required and globally unique across the policy.
- `validator` must be `json_schema`.
- exactly one of `schema` and `schema_ref` is required;
- `on_failure.type` must be `block` or `retry`;
- `maximum_retries` and `repair_prompt` are accepted only for `retry`;
- `maximum_retries` must be an integer from 0 through 3; and
- `repair_prompt` is optional and limited to 2,000 characters.

When `maximum_retries` is omitted from a retry action, it uses
`defaults.maximum_retries`, whose default is 1.

An empty or absent `output` array disables structured output enforcement while
leaving other configured guardrails active.

## Schema sources

### Inline schema

`schema` contains the JSON Schema directly in YAML. YAML values must still form
a finite JSON-compatible value after parsing. Cyclic values, non-finite numbers,
functions, or other non-JSON values are rejected.

### Referenced schema

`schema_ref` points to a `.json` file relative to the directory containing the
policy:

```yaml
output:
  - id: require-api-result
    validator: json_schema
    schema_ref: schemas/api-result.json
    on_failure:
      type: block
```

Referenced schemas must:

- use a relative path;
- have a `.json` extension;
- resolve inside the policy directory, including after symbolic-link
  resolution;
- reference a regular file;
- stay within the 1 MiB policy-file limit; and
- contain valid JSON.

These checks prevent the policy from reading arbitrary files outside its
directory.

## Accepted schema contract

The local compiler uses JSON Schema Draft 2020-12 through Ajv.

The root schema must explicitly declare:

```json
{ "type": "object" }
```

If `$schema` is present, it must equal:

```text
https://json-schema.org/draft/2020-12/schema
```

External `$ref` and `$dynamicRef` values are rejected. Internal fragment
references beginning with `#` are allowed and resolved by the local compiler.

Ajv is configured with:

- strict schema compilation;
- all-errors validation;
- no type coercion;
- no default insertion; and
- no removal of additional properties.

The gateway therefore validates the value the model actually returned. It does
not silently repair the object in memory.

The schema accepted by Ajv can be broader than the strict structured-output
subset accepted by a particular provider. In that case, local compilation may
succeed while the provider rejects the upstream request. That rejection is a
provider error, not a local schema mismatch.

## Startup behavior

Policy loading parses, normalizes, and compiles the output schema once. Invalid
or unsupported schemas fail `ModelGateway.create()` before any chat request can
run.

The public configuration error is intentionally generic:

```text
GUARDRAIL_POLICY_PATH contains an invalid or unsupported output schema.
```

When a logger is supplied, the gateway also emits a sanitized
`gateway.guardrail_policy_rejected` event with reason code
`invalid_output_schema`. It does not log schema content or filesystem details.

## Provider-side constraint

`ConfiguredGuardrailHub` exposes the loaded schema as a provider-neutral
`JsonSchemaOutputConstraint`:

```ts
interface JsonSchemaOutputConstraint {
  name: string;
  schema: unknown;
  strict: true;
}
```

The constraint name is derived from the rule ID, normalized to letters, digits,
underscores, and hyphens, and limited to 64 characters.

The OpenAI-compatible Chat Completions adapter maps the constraint to:

```json
{
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "guardrail_require-api-result",
      "schema": {},
      "strict": true
    }
  }
}
```

The adapter uses the provider's HTTP JSON contract directly. It does not use
SDK helpers such as Python `text_format` or JavaScript `zodTextFormat`, because
the gateway accepts provider-neutral JSON Schema and sends a Chat Completions
request itself. Those SDK helpers ultimately produce an equivalent structured
output request for their respective SDKs; they are not required for local
enforcement.

`structuredOutputMode: "disabled"` can be set on the OpenAI-compatible provider
when an upstream endpoint does not support `response_format`. This disables only
the provider hint. The gateway continues local validation and repair behavior.

The original user messages are not changed merely because an output schema is
configured. A prompt containing the schema is added only after an invalid
response triggers an explicit repair attempt.

## Local evaluation algorithm

For each assistant choice, in array order:

1. Require non-null string content. The pipeline's response classifier normally
   rejects a null text-only response before this evaluator runs.
2. Reject content longer than 1,000,000 JavaScript string code units.
3. Trim outer whitespace and parse the complete string with `JSON.parse`.
4. Require a non-null, non-array object.
5. Validate the object against the compiled schema.
6. Stop at the first invalid choice.

Every choice must be valid for the response to pass. Validation does not accept
Markdown fences, commentary before or after the JSON, or a top-level array.

### Violation types

The evaluator exposes one sanitized category:

- `output_too_large`: content exceeds the one-million-character limit;
- `invalid_json`: content cannot be parsed as complete JSON; the evaluator also
  uses this type for null content when called directly;
- `non_object`: parsed JSON is null, an array, or a scalar; or
- `schema_mismatch`: the object does not satisfy the schema.

Ajv's detailed error paths and values are not exposed in public errors or
lifecycle events.

## Repair behavior

When policy selects `retry`, the hub creates a new provider request containing:

1. all messages in the current provider request;
2. one assistant message containing the invalid response; and
3. one user message containing the repair prompt, serialized schema, and an
   instruction to return only the corrected JSON object.

The default repair instruction is:

```text
Correct the previous response so it satisfies the JSON Schema.
```

For an oversized response, the full invalid content is not copied into the
repair request. It is replaced with a fixed omission marker to keep the retry
bounded.

Repair requests preserve the request after input and tool-definition
guardrails. The pipeline does not re-run input guardrails on the appended
assistant and repair messages.

### Retry budget

`maximum_retries` counts additional provider calls, not total attempts:

- `0` means the first invalid response blocks immediately;
- `1` allows at most two provider calls; and
- `3` allows at most four provider calls.

The hub exposes `maximumAttempts = maximumRetries + 1`. The pipeline enforces
this bound even for a custom hub that incorrectly requests another retry after
the maximum attempt.

If a repair response is still invalid after the budget, the invalid response is
not returned to the consumer.

## Success and failure behavior

On success, the gateway returns the provider's original text unchanged. It does
not parse the JSON string into an object and does not add missing schema fields.

An exhausted or immediate policy block becomes:

```text
code: OUTPUT_GUARDRAIL_FAILED
status: 502
message: The model response did not satisfy the output policy.
```

The response is treated as a bad upstream result, so the status is 502 rather
than a client-input status.

An unexpected evaluator failure follows `defaults.runtime_failure_mode`:

- `closed` returns `GUARDRAIL_EVALUATION_FAILED` with status 500;
- `open` permits the provider response to continue without output validation
  for that evaluation.

Provider authentication, timeout, rate-limit, and upstream errors during any
attempt retain their provider-specific error codes. They are not converted into
schema violations.

## Usage accounting

When a repair attempt succeeds, token usage is summed across every provider
response. If any attempt omits usage, the final response omits usage rather
than returning a misleading partial total.

The final response identity and choices come from the successful final
response. `GatewayExecutionResult.providerRequest` remains the initial request
sent before output repair; it is not replaced with the internal repair request.

## Lifecycle and observability

Each evaluated attempt records:

```text
provider_started
provider_completed
output_guardrails_started
output_guardrails_completed
```

A repair adds:

```text
retry_started
provider_started
provider_completed
output_guardrails_started
output_guardrails_completed
```

Output completion metadata can include:

- `decision`: `allow`, `retry`, or `block`;
- `attempt`;
- `maximumAttempts`;
- `ruleIds`; and
- `violationType`.

The logger emits a sanitized `gateway.guardrail_decision` record. It does not
include response content, schema content, or Ajv validation details.

## Security and reliability properties

The important invariants are:

- local validation remains active even when upstream constraint support is
  disabled or imperfect;
- invalid content is never returned after a block decision;
- schema validation does not coerce or mutate model output;
- external schema references and escaped schema paths are rejected;
- repair count and copied invalid content are bounded;
- all choices must pass the same schema; and
- public failures do not expose the invalid model content.

Structured shape is not semantic correctness. For example, a schema can require
an `error` field, but the model must still know whether an error occurred and
what it was. A schema cannot obtain provider failures such as an API-key error,
because those failures occur before an assistant JSON response exists.

## Testing

From `apps/gateway`:

```bash
bun test tests/output-evaluator.test.ts
bun test tests/policy-loader.test.ts
bun test tests/guardrail-hub.test.ts
bun test tests/guardrail-pipeline.test.ts
bun test tests/openai-compatible-provider.test.ts
bun run smoke:output-guardrail
```

Coverage should include:

- inline and referenced schemas;
- path containment and external-reference rejection;
- Draft 2020-12 and object-root requirements;
- valid objects and every violation category;
- multiple choices and deterministic first-invalid behavior;
- the one-million-character boundary;
- immediate block and bounded retry;
- oversized-content omission in repair prompts;
- usage aggregation and missing-usage behavior;
- fail-open and fail-closed evaluator failures;
- provider `response_format` mapping; and
- local enforcement with upstream structured output disabled.

The smoke script prints the provider response before local validation and the
final guarded response. It is useful for inspection, while deterministic tests
remain the source of regression coverage.

## Main implementation files

- `src/guardrails/output/json-schema-validator.ts`: strict Ajv compilation and
  validation.
- `src/guardrails/output/output-evaluator.ts`: parsing, size bound, choice
  iteration, and violation categories.
- `src/guardrails/config/policy-loader.ts`: schema source and policy parsing.
- `src/guardrails/guardrail-hub.ts`: provider constraint, repair request, and
  retry decision.
- `src/providers/model-provider.ts`: provider-neutral constraint contract.
- `src/providers/openai-compatible-provider.ts`: Chat Completions mapping.
- `src/pipeline/gateway-pipeline.ts`: attempt loop, enforcement, lifecycle, and
  usage aggregation.

The implementation plan and rationale are recorded in
`specs/16_output_guardrail.md` and `specs/17_output_guardrail_implement.md`.

## Known limitations

- Only one output schema can be active for a policy.
- Successful output remains a JSON string in `ChatResponse`, not a parsed
  application object.
- A single schema applies to every textual choice.
- Provider support for strict JSON Schema varies.
- Repair is another model call and adds latency and token cost.
- The repair prompt includes the full schema and normally includes the invalid
  response.
- Output guardrails do not validate tool calls; tool argument schemas and tool
  policy handle those separately.
- There is no output fallback object or partial-field repair.

Consumers should parse the successful content into their application type only
after the gateway returns it, while still handling provider and guardrail
errors as a separate transport outcome.
