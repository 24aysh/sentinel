# Model Gateway v1.1: As-Built Guardrail Implementation

## 1. Document Purpose

This document records what has actually been implemented for the configurable
guardrail milestone specified in `02_model_gateway.md`.

It is an as-built specification, not a future implementation plan. It describes
the current source layout, configuration and policy contracts, runtime behavior,
HTTP behavior, verification scripts, automated test coverage, and known
limitations of the gateway at the time this document was written.

The milestone adds two concrete guardrail capabilities to the existing model
gateway:

- deterministic PII detection and input allow, redact, or block decisions; and
- strict JSON parsing plus JSON Schema validation for model output, with an
  optional bounded repair retry.

The implementation keeps guardrail policy logic outside the HTTP transport and
the model-provider adapter. The gateway pipeline remains the owner of the
end-to-end request lifecycle and provider attempts.

## 2. Versioning Note

The `v1.1` name in this document identifies the guardrail milestone requested
for `03_v1.1.md`.

The executable package and health response still report version `0.1.0`:

- `apps/gateway/package.json` contains `"version": "0.1.0"`; and
- `createApp()` defaults its health-response version to `0.1.0`.

No package-version or API-version migration has been performed as part of the
guardrail implementation. The YAML policy API has its own explicit version,
`guardrails/v1`.

## 3. Implementation Status

| Capability                                 | Status          | Main implementation                      |
| ------------------------------------------ | --------------- | ---------------------------------------- |
| Optional YAML policy path                  | Implemented     | `src/config/env.ts`                      |
| Strict YAML policy loading                 | Implemented     | `src/guardrails/config/policy-loader.ts` |
| Policy-level `enabled` switch              | Implemented     | Policy loader and `src/runtime.ts`       |
| Startup policy validation                  | Implemented     | `policy-loader.ts`                       |
| Local JSON Schema loading                  | Implemented     | `policy-loader.ts`                       |
| Draft 2020-12 schema compilation           | Implemented     | `output/json-schema-validator.ts`        |
| Email detection                            | Implemented     | `input/pii-detector.ts`                  |
| Phone-number detection                     | Implemented     | `input/pii-detector.ts`                  |
| Luhn-validated credit-card detection       | Implemented     | `input/pii-detector.ts`                  |
| Ordered input-rule matching                | Implemented     | `input/input-evaluator.ts`               |
| Input allow                                | Implemented     | `input/input-evaluator.ts`               |
| Immutable input redaction                  | Implemented     | `input/input-evaluator.ts`               |
| Input block before provider call           | Implemented     | `gateway-pipeline.ts`                    |
| Strict output JSON parsing                 | Implemented     | `guardrail-hub.ts`                       |
| Every-choice schema validation             | Implemented     | `guardrail-hub.ts`                       |
| Output block                               | Implemented     | `gateway-pipeline.ts`                    |
| Bounded output repair retry                | Implemented     | `guardrail-hub.ts` and pipeline          |
| Multi-attempt usage aggregation            | Implemented     | `gateway-pipeline.ts`                    |
| Fail-open runtime behavior                 | Implemented     | `gateway-pipeline.ts`                    |
| Fail-closed runtime behavior               | Implemented     | `gateway-pipeline.ts`                    |
| Guardrail lifecycle events                 | Implemented     | `pipeline/lifecycle.ts`                  |
| Sanitized guardrail decision logs          | Implemented     | `gateway-pipeline.ts`                    |
| Post-input provider-request debugging      | Implemented     | `src/app.ts`                             |
| Checked-in example policy and schema       | Implemented     | `policies/`                              |
| Deterministic guardrail verification       | Implemented     | `scripts/test-guardrails.ts`             |
| Real-provider guardrail smoke test         | Implemented     | `scripts/smoke-guardrails.ts`            |
| Policy hot reload                          | Not implemented | Deferred by design                       |
| Remote schemas or detector services        | Not implemented | Deferred by design                       |
| Streaming, tools, or multimodal guardrails | Not implemented | Deferred by design                       |

## 4. Current Source Layout

The guardrail implementation currently uses this layout:

```text
apps/gateway/
|-- index.ts
|-- .env.example
|-- package.json
|-- README.md
|-- policies/
|   |-- example-policy.yaml
|   `-- schemas/
|       `-- gateway-check-response.json
|-- scripts/
|   |-- smoke-client.ts
|   |-- smoke.ts
|   |-- smoke-guardrails.ts
|   |-- test-pipeline.ts
|   `-- test-guardrails.ts
|-- specs/
|   |-- 01_project_v1.md
|   |-- 02_model_gateway.md
|   `-- 03_v1.1.md
|-- src/
|   |-- app.ts
|   |-- runtime.ts
|   |-- config/
|   |   `-- env.ts
|   |-- domain/
|   |   |-- chat.ts
|   |   |-- errors.ts
|   |   `-- request-context.ts
|   |-- guardrails/
|   |   |-- types.ts
|   |   |-- guardrail-hub.ts
|   |   |-- config/
|   |   |   `-- policy-loader.ts
|   |   |-- input/
|   |   |   |-- pii-detector.ts
|   |   |   `-- input-evaluator.ts
|   |   `-- output/
|   |       `-- json-schema-validator.ts
|   |-- observability/
|   |   `-- logger.ts
|   |-- pipeline/
|   |   |-- gateway-pipeline.ts
|   |   `-- lifecycle.ts
|   |-- providers/
|   |   |-- model-provider.ts
|   |   `-- openai-compatible-provider.ts
|   `-- transport/
|       `-- http/
|           |-- error-response.ts
|           `-- schemas.ts
`-- tests/
    |-- app.test.ts
    |-- env.test.ts
    |-- gateway-pipeline.test.ts
    |-- guardrail-app.test.ts
    |-- guardrail-hub.test.ts
    |-- guardrail-pipeline.test.ts
    |-- openai-compatible-provider.test.ts
    |-- pii-detector.test.ts
    |-- policy-loader.test.ts
    |-- runtime.test.ts
    |-- fixtures/
    |   `-- disabled-policy.yaml
    `-- helpers/
        |-- fake-provider.ts
        `-- guardrail-policy.ts
```

The implementation intentionally consolidated some files proposed by
`02_model_gateway.md`:

- structural policy validation is part of `policy-loader.ts` instead of a
  separate `policy-validator.ts`;
- output evaluation is coordinated directly by `ConfiguredGuardrailHub`
  instead of a separate `output-evaluator.ts`; and
- the single repair-request builder is colocated with `ConfiguredGuardrailHub`
  instead of being kept as a one-function module;
- JSON Schema behavior is covered through policy-loader and hub tests rather
  than a standalone `json-schema-validator.test.ts` file.

These consolidations do not move policy logic into the HTTP layer or provider
adapter.

## 5. Added Dependencies

The gateway declares the following guardrail dependencies directly:

| Dependency    | Current declaration | Purpose                                              |
| ------------- | ------------------- | ---------------------------------------------------- |
| `yaml`        | `^2.9.0`            | Strict YAML policy parsing                           |
| `ajv`         | `^8.20.0`           | JSON Schema Draft 2020-12 compilation and validation |
| `ajv-formats` | `^3.0.1`            | Standard JSON Schema format validation               |

The implementation does not depend on a remote guardrail service. PII
detection and output validation execute inside the gateway process.

## 6. Environment Configuration

### 6.1 Added variables

`GatewayConfig` now includes:

```ts
interface GatewayConfig {
  // Existing gateway and provider settings omitted here.
  guardrailPolicyPath?: string;
  debugExposeProviderRequest: boolean;
}
```

The corresponding environment variables are:

| Variable                                | Default | Behavior                                                                                     |
| --------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `GUARDRAIL_POLICY_PATH`                 | Unset   | Optional YAML policy path. A blank value is treated as unset.                                |
| `GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST` | `false` | Enables an opt-in debug response containing the first post-input-guardrail provider request. |

`GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST` accepts only case-insensitive `true` or
`false`, after whitespace trimming. Any other non-empty value prevents startup
with a `ConfigurationError`.

### 6.2 Policy path resolution

When `GUARDRAIL_POLICY_PATH` is relative, it is resolved from the gateway
process working directory. With the normal command:

```bash
cd apps/gateway
bun run start
```

the checked-in policy is configured as:

```dotenv
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

When the variable is absent or blank, no policy is loaded and no guardrail hub
is attached.

## 7. Runtime Composition

`createRuntime()` now builds the gateway in this order:

```text
GatewayConfig
    |
    +--> OpenAICompatibleProvider
    |
    +--> optional loadGuardrailPolicy()
              |
              +--> ConfiguredGuardrailHub, only when enabled: true
    |
    v
GatewayPipeline
    |
    v
Elysia application
```

The policy and referenced schema are loaded and compiled once during runtime
construction. They are not read or compiled for each request.

`createRuntime()` returns the constructed `policy` and `guardrails` objects in
addition to the existing runtime components. This makes enabled, disabled, and
unconfigured composition testable without starting a listener.

When a policy was loaded, runtime construction emits a sanitized
`gateway.guardrail_policy_loaded` record containing:

- policy name and version;
- whether the policy is enabled;
- input-rule count; and
- output-rule count.

It does not log the policy document, schema, source path, prompt content, or
credentials.

## 8. Policy Enable and Disable Behavior

The policy supports one top-level switch:

```yaml
enabled: true
```

Its behavior is:

- omitted: defaults to `true`;
- `true`: the loaded policy is attached through `ConfiguredGuardrailHub`;
- `false`: the complete policy and referenced schema are still validated and
  compiled, but no guardrail hub is attached to the pipeline.

With `enabled: false`, requests use the original non-guardrail lifecycle and
make one provider call. The policy cannot be toggled per request.

Policy files are loaded only at startup. Editing `enabled` or any other policy
field requires a gateway restart before the change takes effect.

The checked-in `policies/example-policy.yaml` currently has `enabled: true`.

## 9. Implemented YAML Policy Contract

### 9.1 Top-level document

The loader accepts exactly one policy document with these fields:

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: example-policy
  version: 1

defaults:
  input_action: allow
  runtime_failure_mode: closed
  maximum_retries: 1

input: []
output: []
```

Unknown fields are rejected at the policy level and at every parsed nested
level. Duplicate YAML keys are rejected.

The required discriminators are:

- `apiVersion: guardrails/v1`; and
- `kind: GuardrailPolicy`.

`metadata` is required:

- `metadata.name` must match
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`; and
- `metadata.version` must be a positive integer.

### 9.2 Defaults

When `defaults` is omitted, the loaded values are:

```yaml
input_action: allow
runtime_failure_mode: closed
maximum_retries: 1
```

Validation rules are:

| Field                  | Accepted values               |
| ---------------------- | ----------------------------- |
| `input_action`         | `allow`, `redact`, or `block` |
| `runtime_failure_mode` | `open` or `closed`            |
| `maximum_retries`      | Integer from `0` through `3`  |

The default retry count is used by an output retry action that does not declare
its own `maximum_retries`.

### 9.3 Input rules

An input rule has this implemented shape:

```yaml
- id: redact-contact-data
  description: Optional operator-facing description.
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

Validation includes:

- rule IDs use the same identifier format as the policy name;
- rule IDs are globally unique across input and output rules;
- `description` is optional, non-empty when present, and at most 2,000
  characters after trimming;
- `detector` must be `pii`;
- `entities` is required, non-empty, duplicate-free, and contains only
  `EMAIL`, `PHONE_NUMBER`, or `CREDIT_CARD`;
- `roles`, when present, is non-empty, duplicate-free, and contains only
  `system`, `user`, or `assistant`;
- `action.type` is `allow`, `redact`, or `block`;
- `replacement` is accepted only for `redact`; and
- a custom replacement is non-empty and at most 256 characters after
  trimming.

Input rules remain in YAML declaration order. That order is used during
first-match evaluation.

### 9.4 Output rule

Version 1 accepts zero or one output rule:

```yaml
- id: require-json-response
  validator: json_schema
  schema_ref: schemas/response.json
  on_failure:
    type: retry
    maximum_retries: 1
    repair_prompt: Correct the response to match the schema.
```

Validation includes:

- `validator` must be `json_schema`;
- `schema_ref` is required and non-empty;
- `on_failure.type` is `retry` or `block`;
- `maximum_retries` and `repair_prompt` are rejected for `block`;
- retry count must be an integer from `0` through `3`; and
- `repair_prompt`, when present, is non-empty and at most 2,000 characters
  after trimming.

An empty `output` list is treated as no output rule.

### 9.5 Strict YAML and file limits

Policy loading implements these startup protections:

- the configured policy must resolve to a regular file;
- the policy file is limited to 1 MiB before parsing;
- YAML is parsed in strict mode;
- duplicate keys are rejected;
- YAML aliases are disabled through a zero alias-count limit; and
- invalid policies throw a sanitized `ConfigurationError` prefixed with
  `GUARDRAIL_POLICY_PATH`.

Policy loader errors do not include the contents of the invalid policy or the
underlying parser or filesystem error.

### 9.6 Schema-reference restrictions

The output schema reference is resolved relative to the directory containing
the real policy path.

The loader:

- rejects absolute schema paths;
- requires a `.json` extension, case-insensitively;
- resolves symlinks with `realpath()`;
- rejects traversal or symlink resolution outside the policy directory;
- requires a regular file;
- enforces a 1 MiB schema-file limit;
- parses the complete file as JSON;
- rejects remote and cross-file `$ref` and `$dynamicRef` values; and
- compiles the schema before runtime construction succeeds.

Internal references beginning with `#` remain available.

## 10. JSON Schema Validation

`CompiledJsonSchemaValidator` uses Ajv's dedicated Draft 2020-12
implementation.

Its active options are:

```ts
{
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
}
```

`ajv-formats` is installed in `fast` mode.

The validator accepts an object or boolean JSON Schema. Compilation failures,
unknown strict-mode keywords, and invalid schema types prevent gateway startup.
Validation does not coerce, remove, or add properties to the parsed model
value.

## 11. PII Detection

### 11.1 Supported entities

The detector recognizes exactly:

- `EMAIL`;
- `PHONE_NUMBER`; and
- `CREDIT_CARD`.

Each finding contains only structural metadata:

```ts
interface PiiFinding {
  entity: "EMAIL" | "PHONE_NUMBER" | "CREDIT_CARD";
  messageIndex: number;
  role: "system" | "user" | "assistant";
  start: number;
  end: number;
}
```

The matched value is not stored in the finding.

### 11.2 Email behavior

Email matching supports conventional ASCII local parts and dotted ASCII domain
names. Token-boundary checks prevent matching inside a larger alphanumeric or
underscore token.

Unicode internationalized mailbox syntax is not implemented.

### 11.3 Phone-number behavior

Phone candidates may contain:

- an optional leading `+` or opening parenthesis;
- digits; and
- common spaces, dots, parentheses, or hyphens.

After separators are removed, a candidate must contain 10 through 15 digits.
The same token-boundary checks are applied.

This is deterministic pattern recognition rather than locale-aware telephone
number validation.

### 11.4 Credit-card behavior

Credit-card candidates contain 13 through 19 digits with optional spaces or
hyphens. A candidate is emitted only when it passes a Luhn checksum.

The implementation does not identify card brands or retain the matched card
number.

### 11.5 Finding normalization

Raw findings are sorted by:

1. message index;
2. start offset;
3. longest span at the same start offset; and
4. entity precedence for identical spans:
   `CREDIT_CARD`, `EMAIL`, then `PHONE_NUMBER`.

After sorting, overlapping lower-priority findings are discarded. A character
range is therefore transformed at most once.

## 12. Input Rule Evaluation

Each normalized finding is resolved independently:

1. inspect input rules in YAML order;
2. choose the first rule matching both entity and optional role;
3. use that rule's action; or
4. use `defaults.input_action` when no rule matches.

Request-level resolution is:

1. any `block` finding blocks the complete request;
2. otherwise, every `redact` finding is replaced; and
3. otherwise, the normalized request is allowed unchanged.

This lets an early narrow `allow` rule override a later general block or redact
rule.

### 12.1 Redaction behavior

For a redaction rule:

- a configured replacement is used when present;
- otherwise the replacement is entity-specific, such as `<EMAIL>`,
  `<PHONE_NUMBER>`, or `<CREDIT_CARD>`; and
- a default `input_action: redact` also uses the entity-specific placeholder.

Redactions are applied from the end of each message to its beginning so earlier
offsets remain valid.

The transformed `ChatRequest`, messages, and changed content are new values.
The incoming HTTP body and caller-owned `ChatInput` are not mutated.

### 12.2 Block behavior

When any finding resolves to `block`:

- no provider call occurs;
- the pipeline throws `INPUT_GUARDRAIL_BLOCKED`;
- HTTP status is `400`; and
- the public message is
  `The request was blocked by an input guardrail.`

The public response excludes detected values, rule IDs, entity names, offsets,
and message content.

### 12.3 Decision metadata

Preparation
Internal guardrail results include:

- total finding count;
- unique matched rule IDs in stable encounter order; and
- unique entity types in stable encounter order.

This metadata is used for sanitized lifecycle and decision records. It is not
included in public error responses.

## 13. Output Evaluation

When an output rule exists, `ConfiguredGuardrailHub.evaluateOutput()` evaluates
provider choices in response order.

For every choice it:

1. trims outer whitespace from the complete assistant content;
2. parses the complete content with `JSON.parse()`; and
3. validates the parsed value with the compiled schema.

The response is allowed only when every returned choice passes. Markdown
fences, leading prose, trailing prose, malformed JSON, and schema-invalid JSON
are rejected.

When multiple choices are invalid, the first invalid choice in response order
becomes the deterministic repair source.

When no output rule exists, output evaluation immediately returns `allow`.

## 14. Repair Retry

### 14.1 Retry count

`maximum_retries` means additional provider calls after the initial call:

| Configured retries | Maximum provider attempts |
| -----------------: | ------------------------: |
|                `0` |                       `1` |
|                `1` |                       `2` |
|                `2` |                       `3` |
|                `3` |                       `4` |

`ConfiguredGuardrailHub.maximumAttempts` exposes this total to the pipeline.
The pipeline also enforces that bound if a custom or faulty hub requests an
extra retry.

### 14.2 Repair request construction

When output is invalid and retry budget remains, the next request preserves:

- the exact model request used for the previous attempt;
- post-input-guardrail messages;
- model selection;
- temperature, when present;
- max-token setting, when present; and
- the same request context and request ID.

It appends:

1. the invalid provider content as an `assistant` message; and
2. a `user` repair message containing:
   - the configured repair instruction or built-in default;
   - the serialized JSON Schema; and
   - an instruction to return only corrected JSON without Markdown or
     commentary.

Input detection is not rerun against gateway-generated repair messages.

Each retry output goes through the complete output validation process again.
Further retries extend the current repair conversation rather than rebuilding
it from the original request.

### 14.3 Retry exhaustion and block

If output remains invalid after the available attempts, or the rule uses
`on_failure.type: block`:

- invalid model content is discarded;
- the pipeline throws `OUTPUT_GUARDRAIL_FAILED`;
- HTTP status is `502`; and
- the public message is
  `The model response did not satisfy the output policy.`

Schema diagnostics and invalid content are not returned to the caller.

## 15. Usage Accounting Across Retries

The final public response keeps the ID, timestamp, model, choices, and finish
reasons from the final valid provider attempt.

When every attempt includes usage, the pipeline sums:

- prompt tokens;
- completion tokens; and
- total tokens.

If any attempt omits usage, usage is removed from the final response. The
gateway does not report a misleading partial total.

## 16. Gateway Pipeline Lifecycle

### 16.1 Guardrails absent or disabled

```text
received
  -> validated
  -> provider_started
  -> provider_completed
  -> completed
```

No guardrail events are emitted, and the provider is called once.

### 16.2 Enabled policy without retry

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

The output stages are present even when the policy has no output rule, because
the attached hub returns an immediate `allow` decision.

### 16.3 Enabled policy with one retry

```text
received
  -> validated
  -> input_guardrails_started
  -> input_guardrails_completed
  -> provider_started                 attempt=1
  -> provider_completed               attempt=1
  -> output_guardrails_started        attempt=1
  -> output_guardrails_completed      attempt=1, decision=retry
  -> retry_started                    attempt=2
  -> provider_started                 attempt=2
  -> provider_completed               attempt=2
  -> output_guardrails_started        attempt=2
  -> output_guardrails_completed      attempt=2, decision=allow
  -> completed
```

Attempt metadata includes both the current attempt and maximum attempts.

### 16.4 Failure lifecycle

Pipeline errors are normalized and produce one `failed` lifecycle event. It
contains:

- stable gateway error code; and
- `failedAt`, identifying the last recorded successful lifecycle stage.

The request ID and model remain consistent across guardrail stages and retry
attempts. The returned duration covers input evaluation, every provider
attempt, output evaluation, and repair retries.

## 17. Runtime Failure Modes

`runtime_failure_mode` applies only to unexpected exceptions thrown while
executing a guardrail evaluator. A real PII finding or schema violation is a
normal policy decision, not a runtime failure.

### 17.1 Fail open

For `runtime_failure_mode: open`:

- an input evaluator exception allows the original normalized request to
  continue unchanged;
- an output evaluator exception allows the current provider response;
- a sanitized `gateway.guardrail_runtime_failure` record is emitted; and
- the thrown error message and evaluated content are not logged.

The runtime-failure record identifies phase, request ID, policy identity, and
`action: fail_open`.

### 17.2 Fail closed

For `runtime_failure_mode: closed`:

- guardrail evaluation stops;
- the pipeline throws `GUARDRAIL_EVALUATION_FAILED`;
- HTTP status is `500`; and
- the public message is
  `The gateway could not evaluate the configured guardrails.`

An input failure happens before the provider call. An output failure happens
after the current provider attempt but before its response can be returned.

### 17.3 Startup failures

Policy and schema loading failures always prevent runtime construction. They
are never converted into fail-open behavior.

## 18. Public Error Contract

The following error codes were added:

| Condition                               | HTTP status | Code                          |
| --------------------------------------- | ----------: | ----------------------------- |
| Input policy blocks the request         |       `400` | `INPUT_GUARDRAIL_BLOCKED`     |
| Output does not satisfy policy          |       `502` | `OUTPUT_GUARDRAIL_FAILED`     |
| Unexpected fail-closed evaluation error |       `500` | `GUARDRAIL_EVALUATION_FAILED` |

They use the existing public error shape:

```json
{
  "error": {
    "code": "INPUT_GUARDRAIL_BLOCKED",
    "message": "The request was blocked by an input guardrail.",
    "request_id": "gateway-request-id"
  }
}
```

Guardrail errors reuse existing response headers, including `x-request-id` and
`x-gateway-duration-ms`.

Existing HTTP validation, provider authentication, rate-limit, timeout,
upstream, malformed-response, and internal-error contracts remain unchanged.

## 19. Observability and Privacy

### 19.1 Lifecycle metadata

Guardrail lifecycle events may contain:

- `policyName`;
- `policyVersion`;
- `decision`;
- `findingCount`;
- `ruleIds`;
- `entityTypes`;
- `attempt`; and
- `maximumAttempts`.

### 19.2 Decision logs

Each completed input or output decision emits
`gateway.guardrail_decision`. Records contain the request ID, phase, decision,
policy identity, and sanitized phase-specific metadata.

### 19.3 Excluded data

Normal operational logs and lifecycle events do not include:

- prompt or message content;
- assistant completion content;
- matched PII values;
- JSON values or validator diagnostics;
- complete schemas;
- repair prompt contents;
- API keys; or
- authorization headers.

## 20. Post-Input Provider-Request Debugging

The implementation includes an explicit local-debug path so an operator can
see what is sent to the first model call after input guardrails.

Both controls are required:

1. server environment:

   ```dotenv
   GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true
   ```

2. request header:

   ```http
   x-gateway-debug-provider-request: true
   ```

On a successful request, the response adds:

```json
{
  "gateway_debug": {
    "provider_request": {
      "model": "configured-model",
      "messages": [{ "role": "user", "content": "Contact <EMAIL>" }],
      "stream": false
    }
  }
}
```

`temperature` and `max_tokens` appear when present on the normalized request.
Authorization data is never included.

The value is the first provider request after input guardrails, before any
output-repair messages are added. It is therefore suitable for confirming PII
redaction but not for inspecting a later retry request.

When either control is absent, the normal response shape is unchanged.

This feature intentionally exposes prompt content and defaults to disabled. It
is intended only for controlled local debugging.

## 21. Checked-In Example Policy

The current `policies/example-policy.yaml`:

- is enabled;
- identifies itself as `gateway-e2e`, version `1`;
- uses fail-closed runtime behavior;
- permits one output repair retry;
- redacts email, phone-number, and credit-card findings in every supported
  message role;
- uses entity-specific placeholders because no custom replacement is set; and
- requires output to match
  `policies/schemas/gateway-check-response.json`.

The schema requires exactly this logical shape:

```json
{
  "status": "ok",
  "message": "a non-empty string",
  "contact": "<EMAIL>"
}
```

Additional properties are rejected.

The sample policy is designed to make the on/off difference visible:

- enabled: the input email sent upstream becomes `<EMAIL>` and output is
  validated;
- disabled after restart: the original email reaches the provider and output
  validation is not applied.

## 22. Verification Scripts

### 22.1 Baseline deterministic pipeline

`bun run test:pipeline` uses the production pipeline with an in-memory fake
provider and verifies the original lifecycle without guardrails.

It requires no listener, network, API key, or provider quota.

### 22.2 Deterministic guardrail pipeline

`bun run test:guardrails` loads the checked-in policy, constructs the concrete
guardrail hub, and uses an in-memory sequenced provider.

It asserts:

1. a synthetic input email is removed before the provider sees attempt one;
2. `<EMAIL>` is present in the transformed provider request;
3. the invalid first provider response triggers a retry;
4. the retry request ends with an invalid `assistant` response followed by a
   `user` repair instruction;
5. the second response satisfies the schema;
6. exactly two provider calls occur; and
7. usage from both attempts is aggregated.

It also requires no listener, network, API key, or provider quota.

### 22.3 Standard real-provider smoke

`bun run smoke` sends one request through a running gateway and requests debug
exposure with `x-gateway-debug-provider-request: true`.

It prints:

- the normalized first provider request after input guardrails; and
- the final assistant response.

The gateway must have `GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true` and must be
restarted after changing that setting.

### 22.4 Guardrail real-provider smoke

`bun run smoke:guardrails` sends one gateway request containing the synthetic
address `smoke.gateway@gmail.com`.

The current request intentionally sends only `messages`; it does not add
`temperature` or `max_tokens`. This keeps the smoke request compatible with the
working baseline request shape across current model-provider configurations.

The script requires the final assistant content to parse as JSON and asserts:

- `status` equals `ok`;
- `message` is a non-empty string; and
- `contact` equals `<EMAIL>`.

The script makes one client-to-gateway request, although the gateway may make a
second upstream call when output repair is needed.

This smoke test requires a running gateway and a real configured provider, so
it can consume provider quota.

## 23. Automated Test Coverage

The current suite contains guardrail coverage in these files:

| Test file                    | Covered behavior                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `env.test.ts`                | New environment defaults, explicit values, and invalid debug flag                   |
| `runtime.test.ts`            | Unconfigured, enabled, and disabled policy composition                              |
| `policy-loader.test.ts`      | Valid policy normalization, defaults, strict failures, schema loading               |
| `pii-detector.test.ts`       | Supported entities, invalid Luhn value, roles, and offsets                          |
| `guardrail-hub.test.ts`      | Redaction, first-match rules, block precedence, strict output, every choice, repair |
| `guardrail-pipeline.test.ts` | Retry lifecycle, usage, block paths, failure modes, hard attempt bound              |
| `guardrail-app.test.ts`      | Sanitized HTTP errors and opt-in debug exposure                                     |
| Existing baseline tests      | Original pipeline, HTTP, environment, and provider behavior                         |

All automated tests use fake providers or mocked fetch implementations. The
test suite does not consume model-provider quota.

Some defensive policy-loader branches are implemented but do not yet have a
dedicated test for every case listed in the original plan. Examples include
oversized files, every invalid nested field, absolute and symlink-escape schema
paths, and pathological detector inputs. The core positive and negative paths
are covered, but the original exhaustive test matrix is not yet represented by
one test per bullet.

## 24. Verification Snapshot

Verification was run from `apps/gateway` on 2026-08-06 with Bun `1.3.14`.

| Check                        | Result                                                 |
| ---------------------------- | ------------------------------------------------------ |
| `bun test`                   | Passed: 70 tests, 0 failures, 187 assertions, 10 files |
| `scripts/test-pipeline.ts`   | Passed                                                 |
| `scripts/test-guardrails.ts` | Passed; two calls, redaction, retry, valid result      |
| `tsc --noEmit`               | Passed                                                 |
| Bun production build         | Passed; 500 modules bundled                            |

The real-provider smoke scripts were not executed as part of this documentation
pass because they require a running gateway, external network access, valid
provider credentials, and may consume quota.

## 25. Acceptance-Criteria Mapping

| Criterion from `02_model_gateway.md`                             | Current result                                     |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| No policy preserves baseline behavior                            | Implemented and tested                             |
| Valid policy loads and compiles once                             | Implemented and tested                             |
| `enabled: false` validates without attaching guardrails          | Implemented and tested                             |
| Invalid configured policy prevents startup                       | Implemented and tested for representative failures |
| Supported PII is allowed, redacted, or blocked deterministically | Implemented; principal paths tested                |
| Blocked input never reaches provider                             | Implemented and tested                             |
| Redaction is immutable and provider sees transformed input       | Implemented and tested                             |
| Every assistant choice is strictly parsed and schema validated   | Implemented and tested                             |
| Retry count is bounded                                           | Implemented and tested                             |
| Invalid exhausted output is not exposed                          | Implemented and HTTP-tested                        |
| Fail-open and fail-closed behavior                               | Implemented and tested for both phases             |
| Guardrail logs exclude evaluated private content                 | Implemented and tested for injected failures       |
| Existing non-policy errors remain stable                         | Existing provider and HTTP tests pass              |
| Tests, scripts, type check, and build pass                       | Verified in the snapshot above                     |

## 26. Known Limitations and Operational Notes

### 26.1 OpenAI-compatible max-token field

The public gateway accepts `max_tokens`, and the current provider adapter
forwards it upstream as `max_tokens`.

Some newer OpenAI reasoning models require `max_completion_tokens` instead.
With those models, a request containing `max_tokens` can be rejected upstream
even though the same request without that field succeeds. The current
`smoke-guardrails.ts` omits the field for this reason.

A future compatibility change should either:

- add provider/model capability-aware request mapping; or
- introduce a provider-neutral completion-budget field and map it to the
  correct upstream parameter per adapter.

Changing the generic adapter globally to `max_completion_tokens` without a
compatibility strategy could break other OpenAI-compatible servers that expect
`max_tokens`.

### 26.2 Sanitized upstream diagnostics

For upstream HTTP failures other than authentication and rate limiting, the
provider adapter returns the generic `MODEL_UPSTREAM_ERROR` message and does not
surface the provider response body.

This protects callers from upstream detail leakage, but it also makes parameter
compatibility failures difficult to diagnose. Safe internal status and provider
error-code logging could be added later without exposing prompt or credential
data publicly.

### 26.3 Guardrail smoke failure hint

`smoke-guardrails.ts` currently prints the policy-startup hint for every caught
error. That hint is useful for a disabled policy but may be misleading for an
upstream provider failure, malformed provider response, or output-policy
failure.

### 26.4 Debug response scope

The debug response exposes only the first request sent after input guardrails.
It does not expose output-repair requests or raw transport headers.

### 26.5 Policy lifecycle

There is no policy hot reload, policy administration endpoint, or per-request
policy selection. Every policy edit requires a restart.

### 26.6 Guardrail scope

The implementation does not include:

- prompt-injection, toxicity, secret, or content-safety detection;
- confidence scores or probabilistic detectors;
- fallback response replacement;
- multiple output rules;
- provider routing or fallback providers;
- remote schemas or external detectors;
- persisted guardrail decisions;
- streaming guardrails;
- tool-call guardrails;
- multimodal-content guardrails; or
- retrieved-context guardrails.

## 27. Operator Runbook

### 27.1 Enable the checked-in policy

Set:

```dotenv
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

Ensure the YAML contains:

```yaml
enabled: true
```

Then restart the gateway.

### 27.2 Disable enforcement while still validating configuration

Change the YAML to:

```yaml
enabled: false
```

Restart the gateway. The policy and schema will still be loaded and validated,
but the request lifecycle will not include guardrail stages.

### 27.3 Inspect redaction

Set:

```dotenv
GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true
```

Restart the gateway, then run:

```bash
bun run smoke
```

Inspect `gateway_debug.provider_request.messages` in the printed response.

### 27.4 Verify without a real provider

Run:

```bash
bun test
bun run test:pipeline
bun run test:guardrails
bun run check-types
bun run build
```

Only the smoke scripts require a live gateway and real provider configuration.

## 28. Deferred Extensions

The central `GuardrailHub`, provider-neutral request and response types, strict
policy version, and separated detector and validator modules provide extension
points for future milestones.

Future policy versions may add detector registries, confidence thresholds,
secret and prompt-injection checks, output replacement, multiple validators,
fallback providers, route actions, external detector services, hot reload,
policy selection, retrieved-context checks, tool-call checks, and streaming.

Those capabilities should be added through an explicitly compatible policy
contract or a new `apiVersion`. Unknown `guardrails/v1` fields remain errors and
must not silently activate future behavior.
