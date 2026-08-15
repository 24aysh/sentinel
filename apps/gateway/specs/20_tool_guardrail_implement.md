# Inspection-Only Tool Guardrails: Implementation Specification

## 1. Purpose and Status

This document specifies the first implementable tool-guardrail milestone for
the gateway. It follows the research in `19_tool_guardrail_research.md` and
adopts the deliberately narrower architecture selected for the current phase:

> The gateway accepts function-tool definitions, allows the model to propose
> tool calls, removes disallowed calls, and returns allowed calls to the
> consuming application. The gateway does not execute tools.

This is an implementation specification, not an assertion that the work is
already present in the codebase.

The scope is OpenAI-compatible Chat Completions function calling. Streaming,
provider-hosted tools, custom tools, MCP tools, approvals, tool execution, and
execution sandboxing are deferred.

## 2. Decision Summary

The milestone will add:

- function-tool definitions and tool-selection options to `ChatInput` and
  `ChatRequest`;
- assistant `toolCalls` and `tool` result messages to the public chat domain;
- OpenAI-compatible request and response mapping for `tools`, `tool_choice`,
  `parallel_tool_calls`, `tool_calls`, and `tool_call_id`;
- a `tools` section in `guardrails/v1` policies;
- pre-provider filtering of disallowed tool definitions;
- post-provider validation and filtering of returned tool calls;
- a sanitized `ChatResponse` containing allowed calls only;
- decision metadata that reports allow/filter outcomes without exposing tool
  arguments; and
- deterministic unit, integration, and smoke tests that execute no real tool.

The public SDK remains camel-cased. Therefore OpenAI's wire field
`message.tool_calls` becomes `message.toolCalls` in `ChatResponse`, just as
`finish_reason` already becomes `finishReason`.

## 3. Does This Serve the Requested Purpose?

### 3.1 Yes, for an inspection-only application boundary

This design serves the immediate purpose when all of the following are true:

1. The consuming application sends its tool definitions through the gateway.
2. It receives model results only through `GatewayExecutionResult.response`.
3. It dispatches only the `message.toolCalls` contained in that sanitized
   response.
4. It does not retain or execute a raw provider response obtained outside the
   gateway.
5. Tool implementations are not independently exposed to model-generated text.

Under that contract, an exact disallowed call is not returned to the code that
dispatches tools. Allowed calls remain available for the application to
execute.

### 3.2 No, as a universal execution-security guarantee

This milestone does not prove that a disallowed side effect can never occur.
The gateway does not own the execution boundary, so it cannot prevent:

- a consumer from bypassing the gateway or ignoring its sanitized response;
- application code from constructing and executing a call independently;
- an equivalent dangerous shell command written in a different form;
- a tool from performing broader side effects than its name or schema implies;
- provider-hosted tools that execute before a response returns; or
- another service or identity from invoking the same underlying operation.

The accurate security claim is:

> The gateway did not return the tool calls that matched its configured block
> policy.

The inaccurate claim would be:

> The gateway guaranteed that no equivalent operation was executed anywhere.

The execution-broker architecture described in
`19_tool_guardrail_research.md` remains the recommended later milestone for
stronger guarantees.

## 4. API Contract Background

In Chat Completions function calling, the application supplies function-tool
definitions. A model can return zero, one, or several structured calls in
`message.tool_calls`; the application executes the permitted calls and sends
their results back as `tool` messages. Each result references the original
call with `tool_call_id`.

OpenAI also supports `tool_choice` controls and disabling parallel calls. The
official documentation recommends strict function schemas and describes the
strict-schema requirements:

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)

Provider controls reduce unwanted proposals. They do not replace the local
post-response check in this specification.

### 4.1 JSON Schema is the transport contract; Zod is not required

The gateway should not convert caller JSON Schema back into Zod. Helpers such
as `zodResponseFormat` and function-tool Zod helpers are SDK conveniences that
convert an in-process Zod schema into the JSON Schema sent over HTTP. This
gateway already receives provider-neutral JSON Schema and uses a raw HTTP
adapter, so a JSON Schema -> Zod -> JSON Schema round trip would add a lossy,
unnecessary dependency.

For function tools, send the validated schema directly as
`tools[].function.parameters` with `strict: true`, and use AJV for the local
check. `response_format` remains the separate contract for final assistant
content. Arbitrary argument fields are valid only when they are declared in
the particular tool's `parameters` schema.

## 5. Goals and Non-Goals

### 5.1 Goals

- Represent normal function-tool requests and responses without losing data.
- Keep the gateway provider-neutral at its public API boundary.
- Reject malformed or unoffered model-generated calls.
- Apply local policy even when the provider has already filtered available
  tools.
- Remove blocked calls before returning a response to the consumer.
- Preserve allowed calls in a mixed allowed/blocked response.
- Support the consumer's next Chat Completions turn after it executes an
  allowed tool.
- Fail closed when the tool guardrail itself cannot evaluate a call.
- Avoid logging tool arguments, command strings, schemas, or tool results.
- Keep existing text-only requests backward compatible.

### 5.2 Non-goals

- Executing any function, command, HTTP request, or other side effect.
- Deciding whether a user is authorized to access a business resource.
- Providing a shell security sandbox.
- Reliably classifying all semantically equivalent commands.
- Implementing an approval or human-in-the-loop workflow.
- Running a multi-turn tool loop inside the gateway.
- Supporting streaming tool-call deltas.
- Supporting the Responses API in this milestone.
- Supporting provider-hosted tools, built-in tools, MCP, or custom tool types.
- Modifying the user's prompt to describe hidden guardrail policy.

The final point is important: tool policy remains a gateway concern. Policy
rules are not appended to system or user messages.

## 6. Security and Trust Model

### 6.1 Trusted components

- the loaded guardrail policy;
- gateway normalization and provider adapters;
- the local JSON Schema validator;
- the consuming application's dispatcher, but only if it follows the returned
  response contract; and
- tool implementations and their own authorization controls.

### 6.2 Untrusted inputs

- caller-supplied tool definitions and schemas;
- all conversation messages, including tool results;
- provider responses;
- tool names, call IDs, and serialized arguments returned by the model; and
- model-generated assistant text next to a tool call.

### 6.3 Enforcement invariant

For every call returned by the provider:

```text
parse -> verify offered tool -> parse arguments -> validate schema
      -> evaluate local policy -> copy allowed call into sanitized response
```

A call must not enter the public `ChatResponse` until all checks have passed.
The provider's parsed response is an internal value and must not be emitted,
logged, or attached to thrown errors before sanitization.

### 6.4 Consumer invariant

The consuming application must treat the gateway response as the only dispatch
manifest:

```ts
for (const choice of result.response.choices) {
  for (const call of choice.message.toolCalls ?? []) {
    await dispatchKnownTool(call);
  }
}
```

Assistant text must never be interpreted as a command. The application must
also look up tools in its own fixed registry rather than evaluating a tool name
as code.

## 7. Public Chat Domain Changes

### 7.1 Function-tool definitions

Add these types to `src/domain/chat.ts`:

```ts
export interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
    strict: true;
  };
}

export interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "function";
      function: { name: string };
    };
```

The public `arguments` value remains a JSON-encoded string. This matches the
provider contract, prevents parse/stringify drift, and lets the application
use the exact call approved by the gateway. The gateway still parses it once
internally for schema and policy evaluation.

Only `strict: true` is supported in this milestone. Accepting loose schemas
would weaken both provider behavior and local validation.

### 7.2 Message union

Replace the current single `ChatMessage` interface with a discriminated union:

```ts
export type ChatMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: FunctionToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      content: string;
    };
```

This is required for continuation. After the application executes an allowed
call, it sends both the sanitized assistant call message and the corresponding
tool result on its next request.

The message invariants are:

- system and user content is a non-empty string;
- an assistant message may have text, one or more `toolCalls`, or both;
- assistant `content: null` is allowed only when `toolCalls` is non-empty;
- assistant tool-call IDs must be unique inside the request;
- a tool message has non-empty `toolCallId` and string content;
- every tool result must reference a preceding assistant tool call in the same
  message history;
- every historical assistant call must have exactly one tool result before the
  next non-tool message or the end of the request;
- a call may have at most one tool result;
- historical call names and arguments must validate against a definition in
  the request's `tools` list; and
- only the `function` tool type is accepted.

Tool-result content may be an empty string because an application can
legitimately execute a function with no textual result.

For a continuation request, the consumer therefore resends the definitions
needed to validate the sanitized assistant call history. It may set
`toolChoice: "none"` if it wants a final response without allowing another
call.

### 7.3 Request parameters

Extend the shared chat parameters:

```ts
interface ChatParameters {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: FunctionToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
}
```

Normalization rules:

- `tools`, when supplied, contains 1 through 128 definitions;
- tool names are unique, non-empty, at most 64 characters, and match
  `^[A-Za-z0-9_-]+$`;
- descriptions are at most 1,024 Unicode code points;
- tool schemas and total serialized request size remain subject to explicit
  gateway limits;
- `toolChoice: "required"` or a forced function requires a non-empty `tools`
  array;
- a forced function name must exist in `tools`;
- `parallelToolCalls` must be boolean when present;
- `parallelToolCalls` is rejected when `tools` is absent;
- tool options are rejected if streaming is requested; and
- omitted tool fields preserve existing text-only behavior.

### 7.4 Response shape

Change the response choice message to:

```ts
message: {
  role: "assistant";
  content: string | null;
  toolCalls?: FunctionToolCall[];
}
```

Do not add blocked calls, blocked arguments, policy rules, or synthetic tool
results to `ChatResponse`.

### 7.5 Gateway result metadata

Add optional non-provider metadata beside `response`:

```ts
export interface ToolGuardrailSummary {
  decision: "allow" | "filter";
  allowedCallCount: number;
  blockedCallCount: number;
  ruleIds: string[];
}

export interface GatewayExecutionResult {
  // existing fields
  toolGuardrails?: ToolGuardrailSummary;
}
```

This metadata belongs on `GatewayExecutionResult`, not in `ChatResponse`,
because it is gateway state rather than a provider response field. A fully
blocked response throws and therefore returns no summary object.

## 8. Policy Contract

### 8.1 Additive `guardrails/v1` section

Add `tools` as an optional top-level field without changing the policy version:

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true
metadata:
  name: application-tools
  version: 1
defaults:
  runtime_failure_mode: closed

tools:
  default_action: block
  rules:
    - id: allow-weather
      tool_names: [get_weather]
      action: allow

    - id: allow-order-read
      tool_names: [get_order]
      action: allow

    - id: block-shell-entirely
      tool_names: [run_shell]
      action: block
```

When `tools` is absent, tool calling works without policy filtering, but all
structural, offered-tool, and argument-schema validation still runs. Existing
policies therefore remain valid and backward compatible.

For security-sensitive deployments, `default_action: block` is recommended.

### 8.2 Argument matcher

An optional argument matcher is supported only on block rules:

```yaml
tools:
  default_action: allow
  rules:
    - id: block-fork-bomb-literal
      tool_names: [run_shell]
      arguments:
        - path: command
          operator: equals
          values:
            - ":(){ :|:& };:"
      action: block

    - id: block-destructive-fragment
      tool_names: [run_shell]
      arguments:
        - path: command
          operator: contains
          values: ["rm -rf"]
      action: block
```

The contract is intentionally small:

- `path` is a dot-separated object path such as `command` or
  `request.method`;
- array indexes, wildcards, recursive paths, JSONPath, and prototype-related
  segments are rejected;
- `equals` compares a scalar to one of the configured scalars;
- `contains` is allowed only for string values and performs a literal,
  case-sensitive substring check;
- all matchers in one rule use AND semantics;
- `values` inside one matcher use OR semantics;
- an absent path does not match;
- an empty matcher or value list is invalid; and
- allow rules are name-only so an argument-specific allowlist is not mistaken
  for complete business authorization.

For `equals` and `contains`, candidate strings normalize CRLF to LF and trim
leading and trailing ASCII whitespace. No case-folding, Unicode confusable
mapping, shell tokenization, variable expansion, or command interpretation is
performed. This normalization exists only in the matcher; it must not change
the raw argument string or parsed value returned to the consumer.

This matcher can block known exact literals. It is not a general shell
security boundary. For example, aliases, encoding, variable expansion,
subshells, alternate binaries, and multi-stage commands can express equivalent
behavior without matching the configured value.

### 8.3 Rule precedence

Rules are deterministic and independent of YAML ordering:

1. Any matching block rule blocks the call.
2. Otherwise, any matching name-only allow rule allows the call.
3. Otherwise, `default_action` applies.

The same precedence applies while deciding which definitions are sent to the
provider, with one exception: an argument-scoped block rule does not remove a
definition because the tool may still have safe argument values.

Examples:

| Default | Name allow | Name block | Argument block matches | Result |
| ------- | ---------- | ---------- | ---------------------- | ------ |
| block   | yes        | no         | no                     | allow  |
| allow   | no         | no         | no                     | allow  |
| block   | no         | no         | no                     | block  |
| allow   | yes        | yes        | no                     | block  |
| allow   | yes        | no         | yes                    | block  |

### 8.4 Policy-loader limits

The loader should reject unknown fields and enforce bounded configuration:

- at most 128 tool rules;
- at most 128 names per rule;
- at most 16 argument matchers per rule;
- at most 64 values per matcher;
- string policy values at most 4,096 code points;
- globally unique IDs across input, output, and tool rules; and
- only `allow` or `block` actions and the documented operators.

The policy loader compiles normalized rule data once at startup. Runtime calls
must not reinterpret YAML.

## 9. End-to-End Processing

### 9.1 Request path

```text
ChatInput
  |
  v
normalize messages, tool definitions, and tool selection
  |
  v
input guardrails over configured message roles
  |
  v
tool-definition guardrail
  |-- remove name-blocked definitions
  |-- reconcile toolChoice
  v
OpenAI-compatible provider request
```

The gateway never modifies the prompt to disclose or describe hidden tool
policy. It constrains the actual `tools` request field instead.

### 9.2 Pre-provider definition filtering

Before each provider call:

1. Evaluate every supplied definition by canonical tool name.
2. Remove definitions blocked by a name rule or by the default action.
3. Preserve the caller's definition order for allowed tools.
4. Reconcile `toolChoice` against the filtered list.
5. Send only the filtered definitions to the provider.

`toolChoice` outcomes:

| Caller value    | Filter result     | Gateway behavior                                              |
| --------------- | ----------------- | ------------------------------------------------------------- |
| omitted/auto    | some tools remain | send remaining tools and auto                                 |
| omitted/auto    | none remain       | omit tools and send `tool_choice: none`                       |
| none            | any               | send filtered definitions with `none`; no new call is allowed |
| required        | some remain       | send remaining tools and required                             |
| required        | none remain       | reject before provider call                                   |
| forced function | function remains  | send forced function                                          |
| forced function | function removed  | reject before provider call                                   |

Pre-provider rejection uses `INVALID_REQUEST` with HTTP 400 and a generic
message. It must make zero provider calls. The lifecycle and logs record the
policy rule IDs and counts, not arguments or hidden schemas.

Filtering definitions is defense in depth. The post-provider check remains
mandatory.

### 9.3 Provider call

The provider receives the sanitized `ChatRequest`. It may return text, tool
calls, or malformed data. The adapter parses only supported fields into an
internal `ChatResponse`.

### 9.4 Post-provider call validation

For every tool call in every choice, in original order:

1. Require a non-empty call ID with a bounded length.
2. Require `type: "function"`.
3. Require a syntactically valid and bounded tool name.
4. Require the name to be in the exact definitions sent for this provider
   attempt.
5. Require `function.arguments` to be a bounded string containing JSON.
6. Parse arguments once and require a JSON object.
7. Validate the parsed object against the offered tool's schema.
8. Evaluate local block/allow policy.
9. Copy an allowed call into a new response object.
10. Do not copy a blocked call.

Call IDs must be unique across the response. Unknown tools, malformed argument
JSON, non-object arguments, duplicate IDs, schema mismatches, and unsupported
tool types are provider protocol failures, not policy blocks. They produce
`INVALID_MODEL_RESPONSE` with HTTP 502.

This ordering matters for name blocks. A tool excluded by pre-provider policy
is not in the definitions actually sent. If the provider nevertheless returns
that tool, the gateway rejects the response as an unoffered call instead of
silently treating a provider protocol violation as an ordinary policy match.
Argument-scoped block rules remain the normal way to exercise mixed
post-response filtering because their tool definitions stay available to the
model.

Schema validation prevents a provider from returning arguments outside the
definition the caller supplied. Policy evaluation answers the separate
question of whether a structurally valid call should be exposed.

### 9.5 Sanitization outcomes

The response is processed atomically in memory before any part is returned:

| Returned calls | Blocked calls | Outcome                                         |
| -------------- | ------------- | ----------------------------------------------- |
| one or more    | zero          | return response; summary decision is `allow`    |
| one or more    | one or more   | return allowed calls only; decision is `filter` |
| zero           | one or more   | throw `TOOL_GUARDRAIL_BLOCKED`                  |
| zero           | zero          | normal text-response path                       |

For a mixed response:

- preserve allowed calls in original choice and call order;
- omit any choice whose original calls were all blocked;
- preserve assistant content without interpreting it;
- preserve `finishReason` as returned; and
- never substitute a fake tool result or invent new assistant text.

Omitting an all-blocked choice prevents the gateway from returning
`content: null` without a call and avoids detaching assistant text from a plan
whose calls were all blocked. If every tool-call choice is omitted, the entire
request fails with `TOOL_GUARDRAIL_BLOCKED`.

Filtering siblings has an important semantic cost. A model may have intended
several calls as one plan, while the application executes only the allowed
subset. This behavior matches the selected requirement to return allowed
calls. A later policy option can add atomic `block_response` behavior for
applications that prefer to reject the entire plan when any sibling is
blocked.

### 9.6 Multiple choices

The current gateway does not expose a request option for `n`, but a compatible
provider can still return several choices. The implementation evaluates all of
them.

- Tool calls are sanitized per choice.
- Counts aggregate across choices.
- All-tool-call choices whose calls are all blocked are omitted.
- If no allowed calls remain anywhere but at least one was blocked, the whole
  gateway request fails.
- A response containing both text-only choices and tool-call choices is
  rejected as `INVALID_MODEL_RESPONSE`. This avoids bypassing the output
  JSON-schema guardrail for the text choices and keeps one deterministic
  response mode per gateway result.

## 10. Interaction with Existing Guardrails

### 10.1 Input guardrails

Input guardrails still run before tool-definition filtering. Adding the `tool`
message role also makes tool results available to input policies:

```yaml
input:
  - id: block-injection-in-tool-output
    detector: prompt_injection
    roles: [tool]
    action:
      type: block
```

Existing rules keep their configured roles and behavior. Tool results are
untrusted input, so security-focused policies should explicitly cover the
`tool` role. Adding the role to the domain must not silently widen existing
rules whose roles are explicit.

PII redaction of tool result content is permitted only when a policy selects
the `tool` role. Redaction must preserve `toolCallId` and the message shape.
Input detectors inspect textual `message.content`; they skip null assistant
content and do not inspect or rewrite assistant `function.arguments` in this
milestone. Arguments are instead parsed, schema-validated, and evaluated by
the tool boundary. PII-aware argument rules can be designed separately without
risking corruption of a signed-off call payload.

### 10.2 Output JSON-schema guardrail

Tool calls are not final structured model output. The pipeline must classify a
provider response before selecting an output guardrail:

- a response with any `toolCalls` runs the tool-call guardrail;
- a response with no calls follows the existing output guardrail path; and
- the output JSON-schema guardrail does not validate or retry a tool-call
  response.

The provider request also requires one important change. When callable tools
are present, keep sending the current output `response_format` constraint. A
strict function schema structures a function call, while `response_format`
structures a final assistant response; the official structured-output guide
describes these as separate uses. If the provider returns calls, the gateway
validates the function schemas and defers final output validation. If it
returns final text, the existing output guardrail validates that text.

This routing must be explicit; it must not alter user messages or construct a
repair prompt for a tool-call turn.

### 10.3 Guardrail runtime failure

Tool definition and call evaluation always fail closed, even if the existing
input/output `runtime_failure_mode` is `open`. A fail-open tool filter could
expose a call that policy was intended to hide.

An evaluator exception produces `GUARDRAIL_EVALUATION_FAILED`, emits no raw
response, and returns no calls. This exception to the general runtime mode must
be documented in the SDK README.

## 11. OpenAI-Compatible Provider Mapping

### 11.1 Outbound request

`toProviderRequest()` maps the internal camel-cased contract to OpenAI's wire
format:

| Internal              | Provider wire          |
| --------------------- | ---------------------- |
| `tools`               | `tools`                |
| `toolChoice`          | `tool_choice`          |
| `parallelToolCalls`   | `parallel_tool_calls`  |
| assistant `toolCalls` | assistant `tool_calls` |
| tool `toolCallId`     | tool `tool_call_id`    |
| `maxTokens`           | `max_tokens`           |

The tool definitions themselves already use provider-neutral
`type/function/name/description/parameters/strict` keys and can be copied only
after normalization.

### 11.2 Inbound response

`parseChoice()` currently requires string `message.content`. It must instead:

- accept string content for a text response;
- accept `null` content when a valid non-empty `tool_calls` array is present;
- parse every tool call with strict field checks;
- reject unknown fields only where the gateway contract needs a security
  invariant, while tolerating unrelated provider response extensions; and
- map wire snake case to the public camel-cased response.

Example wire response:

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_weather_1",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Pune\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

Public result:

```json
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "toolCalls": [
          {
            "id": "call_weather_1",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\":\"Pune\"}"
            }
          }
        ]
      },
      "finishReason": "tool_calls"
    }
  ]
}
```

### 11.3 Provider compatibility

`OpenAICompatibleProvider` can advertise tool capabilities:

```ts
interface ProviderCapabilities {
  functionTools: boolean;
  functionToolsWithJsonSchemaOutput: boolean;
}
```

The OpenAI-compatible adapter defaults this to enabled. A future adapter that
cannot support the required wire contract rejects a tool-bearing request with
`UNSUPPORTED_FEATURE` before network I/O. An adapter that cannot combine
function tools with final JSON-schema output must also reject that combination
instead of silently removing either guardrail.

## 12. Tool Schema Validation

### 12.1 Request-time compilation

For every normalized request, compile each unique tool schema with the existing
AJV-based validation foundation. Compilation happens before the provider call
so an invalid caller schema cannot become an upstream error.

The helper should return an immutable map:

```ts
type CompiledToolSchemas = ReadonlyMap<
  string,
  { definition: FunctionToolDefinition; validate(value: unknown): boolean }
>;
```

### 12.2 Supported strict-schema subset

The loader must recursively require strict object schemas:

- root `type: "object"`;
- `additionalProperties: false` for each object;
- every property listed in `properties` also listed in `required`;
- no remote `$ref` or schema loading over the network;
- bounded schema depth and serialized size; and
- no JavaScript-transforming or code-generating extensions from callers.

Optional logical values should use nullable types while remaining required,
consistent with strict function calling.

### 12.3 Validation failure separation

- Invalid tool schema supplied by the caller: `INVALID_REQUEST`, HTTP 400.
- Invalid arguments returned by the provider: `INVALID_MODEL_RESPONSE`, HTTP 502.
- Valid arguments blocked by policy: filter the call or, when none remain,
  `TOOL_GUARDRAIL_BLOCKED`, HTTP 502.

This distinction makes testing and operations materially clearer.

## 13. Guardrail Types and Evaluator

### 13.1 Loaded policy types

Add normalized types to `src/guardrails/types.ts`:

```ts
export type ToolPolicyAction = "allow" | "block";
export type ToolArgumentOperator = "equals" | "contains";

export interface ToolArgumentMatcher {
  path: string[];
  operator: ToolArgumentOperator;
  values: readonly (string | number | boolean | null)[];
}

export interface ToolPolicyRule {
  id: string;
  toolNames: readonly string[];
  action: ToolPolicyAction;
  arguments?: readonly ToolArgumentMatcher[];
}

export interface ToolPolicy {
  defaultAction: ToolPolicyAction;
  rules: readonly ToolPolicyRule[];
}
```

Add `tools?: ToolPolicy` to `LoadedGuardrailPolicy`.

### 13.2 Evaluator API

Add a focused module under `src/guardrails/tools/`:

```ts
export interface ToolDefinitionFilterResult {
  request: ChatRequest;
  allowedDefinitionCount: number;
  blockedDefinitionCount: number;
  ruleIds: string[];
}

export interface ToolCallEvaluationResult {
  response: ChatResponse;
  decision: "allow" | "filter" | "block";
  allowedCallCount: number;
  blockedCallCount: number;
  ruleIds: string[];
}
```

Extend `GuardrailHub` with:

```ts
filterToolDefinitions(
  request: ChatRequest,
  context: RequestContext,
): Promise<ToolDefinitionFilterResult>;

evaluateToolCalls(
  requestSentToProvider: ChatRequest,
  response: ChatResponse,
  context: RequestContext,
): Promise<ToolCallEvaluationResult>;
```

The implementation returns new request and response objects rather than
mutating caller, provider, or cached policy values.

Protocol and schema validation is not conditional on `GuardrailHub`. The
pipeline always calls the tool-schema validator when a request contains tools,
including when no guardrail policy is configured. The hub methods add policy
decisions only:

```text
always: normalize definitions -> compile schemas -> validate returned calls
optional policy: filter definitions -> allow/filter/block valid calls
```

If there is no hub, the validated response passes unchanged. If a hub exists
but its loaded policy has no `tools` section, both methods behave as allow-all
policy methods while the always-on protocol checks still apply.

### 13.3 Matching algorithm

For one parsed call:

```text
matchingBlocks = rules where
  action == block
  and name matches
  and every optional argument matcher matches

if matchingBlocks is non-empty: block

matchingAllows = rules where
  action == allow
  and name matches

if matchingAllows is non-empty: allow

otherwise: use defaultAction
```

Return sorted, deduplicated rule IDs for deterministic logs and tests. Do not
return or log the matching argument values.

## 14. Pipeline Integration

The revised pipeline order is:

```text
received
  -> normalized/validated
  -> input guardrails
  -> compile and retain offered tool schemas
  -> tool-definition guardrails
  -> provider
  -> classify response
       -> tool calls: protocol/schema validation -> tool-call guardrails
          -> sanitize -> return
       -> final text: output guardrails -> retry/block/return
```

### 14.1 Provider request identity

`GatewayExecutionResult.providerRequest` must be the exact sanitized request
sent on the first provider attempt, not the original unfiltered request. This
prevents diagnostics from claiming the provider saw a blocked definition.

If a separate caller request is useful later, add it under a clearly named
field rather than overloading `providerRequest`.

### 14.2 Retry behavior

Output-schema retry is not entered for a tool-call response. A tool policy
block also does not ask the model to repair or choose another tool in this
milestone. Retrying could reveal policy through prompts and can create an
unbounded decision loop.

The application can make a new request under its own product semantics after a
generic block error.

### 14.3 Usage accounting

Filtering tool calls does not change provider usage. Return the provider's
usage unchanged. No synthetic usage is added because the gateway makes no
repair call for a tool decision.

## 15. Errors

Add one public error code:

```ts
| "TOOL_GUARDRAIL_BLOCKED"
```

Error behavior:

| Condition                                   | Code                          | HTTP |
| ------------------------------------------- | ----------------------------- | ---- |
| invalid caller tool definition/schema       | `INVALID_REQUEST`             | 400  |
| forced/required selection removed by policy | `INVALID_REQUEST`             | 400  |
| provider lacks tool capability              | `UNSUPPORTED_FEATURE`         | 400  |
| malformed/unoffered provider tool call      | `INVALID_MODEL_RESPONSE`      | 502  |
| all returned calls blocked                  | `TOOL_GUARDRAIL_BLOCKED`      | 502  |
| guardrail evaluator failure                 | `GUARDRAIL_EVALUATION_FAILED` | 500  |

Public error messages remain generic. Never include a blocked call's name,
arguments, command, schema-validation details, or raw provider body.

## 16. Lifecycle and Logging

Add lifecycle stages:

```ts
| "tool_definitions_guardrails_started"
| "tool_definitions_guardrails_completed"
| "tool_calls_guardrails_started"
| "tool_calls_guardrails_completed"
```

Extend lifecycle decisions with `filter` and metadata with:

```ts
allowedDefinitionCount?: number;
blockedDefinitionCount?: number;
allowedCallCount?: number;
blockedCallCount?: number;
```

Safe event example:

```json
{
  "event": "gateway.guardrail_decision",
  "phase": "tool_calls",
  "decision": "filter",
  "allowedCallCount": 1,
  "blockedCallCount": 1,
  "ruleIds": ["block-shell-entirely"]
}
```

Never log:

- `function.arguments`;
- command or query strings;
- tool schemas or descriptions;
- raw provider request/response bodies;
- tool result content; or
- removed tool calls.

The dedicated smoke script described below may print its deterministic fake
fixtures for local inspection. Production logger behavior must remain
redacted.

## 17. File-by-File Implementation Plan

### 17.1 `src/domain/chat.ts`

- Add function definition, call, and selection types.
- Add the `tool` role and message union.
- Extend request parameters.
- Extend response message content and `toolCalls`.
- Export all public tool types.

### 17.2 `src/pipeline/gateway-pipeline.ts`

- Normalize tool definitions, selection, assistant call messages, and tool
  result messages.
- Enforce cross-message call/result references.
- Run pre-provider definition filtering.
- Pass the sanitized request to the provider.
- Classify text versus tool-call responses.
- Run and apply post-provider call filtering before returning.
- Skip output-schema evaluation for tool-call responses.
- Attach safe `toolGuardrails` result metadata.
- Fail closed on tool evaluator errors.

Move normalization into focused helpers if `gateway-pipeline.ts` becomes too
large; `domain/chat-normalizer.ts` is preferable to continuing to grow one
function.

### 17.3 `src/providers/openai-compatible-provider.ts`

- Serialize tool definitions and selection.
- Serialize assistant call history and tool result messages.
- Parse null assistant content with calls.
- Parse, bound, and normalize all returned calls.
- Preserve raw argument strings for approved responses.
- Reject malformed tool payloads.

### 17.4 `src/providers/model-provider.ts`

- Add explicit provider capabilities if more than one adapter is expected.
- Keep tool fields in `ChatRequest`; they are part of the model request rather
  than out-of-band provider options.
- Continue using provider options only for gateway-generated constraints such
  as output JSON Schema.

### 17.5 `src/guardrails/config/policy-loader.ts`

- Allow the top-level `tools` field.
- Parse strict default action, rules, names, arguments, and operators.
- Enforce all bounds and unknown-field rejection.
- Include tool rule IDs in global uniqueness validation.
- Return immutable normalized paths and values.

### 17.6 `src/guardrails/types.ts`

- Add tool policy, matcher, evaluator result, and summary types.
- Extend `LoadedGuardrailPolicy` and `GuardrailHub`.
- Add the tool role to policy role typing.

### 17.7 `src/guardrails/tools/tool-schema-validator.ts`

- Validate the supported strict schema subset.
- Compile schemas with bounded AJV configuration.
- Parse and locally validate returned arguments.
- Keep detailed validation errors internal and free of argument values.

### 17.8 `src/guardrails/tools/tool-call-evaluator.ts`

- Implement name decision and argument matcher behavior.
- Implement deterministic precedence.
- Filter definitions and sanitize response calls without mutation.
- Return counts and deduplicated rule IDs.

### 17.9 `src/guardrails/guardrail-hub.ts`

- Construct the tool evaluator from the loaded policy.
- Expose definition and call evaluation methods.
- Do not silently reuse input/output fail-open behavior.

### 17.10 `src/pipeline/lifecycle.ts`

- Add tool stages, `filter`, and safe count metadata.
- Preserve `failedAt` accuracy for pre-provider and post-provider failures.

### 17.11 `src/domain/errors.ts`

- Add `TOOL_GUARDRAIL_BLOCKED`.

### 17.12 `src/index.ts`

- Export public function-tool and tool-call types.
- Export summary types needed by SDK consumers.
- Do not export raw internal policy matcher utilities.

### 17.13 Documentation and examples

- Add the request, sanitized response, and continuation examples to README.
- Document the consumer dispatch invariant.
- Add a sample tool policy with a default block posture.
- State the command-matching and execution-boundary limitations prominently.

## 18. Implementation Phases

### Phase 1: Chat and provider protocol

1. Add domain types and validation.
2. Map tool request fields to OpenAI Chat Completions.
3. Parse response calls and continuation messages.
4. Add provider tests before introducing policy behavior.

Exit criterion: a valid tool call round trip is preserved, and malformed calls
are rejected.

### Phase 2: Policy loading and evaluator

1. Add the `tools` policy section.
2. Implement name and argument matching.
3. Implement strict tool-schema compilation and response validation.
4. Add pure evaluator and policy-loader tests.

Exit criterion: deterministic fixtures prove precedence, validation, and
filtering without a network call.

### Phase 3: Pipeline enforcement

1. Filter definitions before provider invocation.
2. Sanitize calls after provider response.
3. Route tool responses away from output JSON-schema evaluation.
4. Add lifecycle, result summary, and errors.

Exit criterion: no blocked call is observable through the public result in
integration tests.

### Phase 4: SDK documentation and smoke coverage

1. Add consumer continuation and dispatch examples.
2. Add deterministic smoke policy and script.
3. Add an opt-in live-provider diagnostic that executes no tools.
4. Run the complete package validation suite.

Exit criterion: a consumer can copy the documented flow and safely inspect the
allowed call manifest.

Because the exported chat types change materially, publish this as SDK version
`0.7.0` under the repository's current pre-1.0 versioning convention.

## 19. Detailed Test Plan

### 19.1 Domain normalization tests

Add tests for:

- valid function definition with a strict object schema;
- duplicate tool names;
- invalid names and overlong descriptions;
- missing, loose, or non-object schemas;
- `toolChoice: required` without tools;
- forced choice for an unknown tool;
- valid assistant call history followed by a tool result;
- orphan, duplicate, and forward-referenced tool result IDs;
- null assistant content without calls;
- empty tool result content;
- unsupported tool types; and
- unchanged text-only request behavior.

Input-guardrail coverage must also prove that null assistant content is
skipped safely, configured `tool` message content is inspected, and tool-call
argument strings are not rewritten by input redaction.

### 19.2 Provider request mapping tests

Capture the request body and assert exact mapping for:

- `tools` and strict schemas;
- auto, none, required, and forced `tool_choice`;
- `parallel_tool_calls: false`;
- assistant `tool_calls` history;
- tool `tool_call_id` result messages; and
- preservation of output `response_format` on a callable-tool attempt.

### 19.3 Provider response parser tests

Cover:

- text-only assistant content;
- one function call with null content;
- several calls in stable order;
- text plus calls;
- malformed IDs, names, types, arguments, and missing fields;
- duplicate call IDs;
- null content without calls; and
- safe tolerance of unrelated response extensions.

### 19.4 Policy-loader tests

Cover:

- absent `tools` section;
- default allow and default block;
- name-only allow and block rules;
- equals and contains matchers;
- argument matchers rejected on allow rules;
- unknown keys, operators, actions, and path syntax;
- all maximum sizes and counts;
- duplicate IDs across input/output/tool rules; and
- deterministic normalized path segments.

### 19.5 Pure evaluator tests

The evaluator test table must include:

- default action with no matching rule;
- allow by exact canonical name;
- name block overriding allow;
- argument block overriding name allow;
- missing path not matching;
- AND across matchers and OR across values;
- scalar type-aware equality;
- case-sensitive contains;
- CRLF and edge-whitespace normalization;
- allowed order preserved after filtering;
- input request and response objects not mutated;
- deterministic sorted rule IDs; and
- no arguments included in the returned metadata.

### 19.6 Pipeline integration tests

Use a recording fake provider to prove:

1. A name-blocked definition is absent from the provider request.
2. A forced blocked definition produces zero provider calls.
3. An unknown tool returned by a provider produces
   `INVALID_MODEL_RESPONSE`.
4. A schema-invalid call produces `INVALID_MODEL_RESPONSE`.
5. All allowed calls are returned unchanged.
6. Mixed calls with an argument-scoped block return only allowed calls and
   decision `filter`.
7. All blocked calls produce `TOOL_GUARDRAIL_BLOCKED` and no result.
8. Calls across multiple choices are all evaluated.
9. A tool-call response skips the output JSON-schema evaluator and retry.
10. A final text response still uses the output JSON-schema guardrail.
11. Tool evaluator failure is closed even under runtime fail-open policy.
12. Lifecycle stages, counts, rule IDs, and `failedAt` are correct.
13. Logs contain no argument strings, schemas, or tool results.

### 19.7 Consumer contract test

Build a tiny fake dispatcher with spies:

```ts
const registry = {
  get_weather: weatherSpy,
  run_shell: shellSpy,
};

for (const call of allowedCallsFromGateway) {
  await registry[call.function.name](JSON.parse(call.function.arguments));
}
```

Given one allowed weather call and one blocked shell call, assert:

- the gateway returns only weather;
- `weatherSpy` runs once;
- `shellSpy` runs zero times; and
- no raw provider response is passed to the dispatcher.

This is the test that most directly demonstrates the selected purpose. It also
makes the consumer's responsibility visible.

### 19.8 Continuation integration test

Test the complete two-request protocol:

1. The fake provider returns an allowed `get_weather` call.
2. The gateway returns the sanitized assistant message.
3. The application executes the fake function.
4. The next request includes that assistant message and a matching tool result.
5. The provider adapter emits `tool_calls` and `tool_call_id` correctly.
6. The fake provider returns final text.
7. The output guardrail runs on the final text response.

No real tool or network access is needed.

### 19.9 Deterministic smoke script

Add `scripts/smoke-tool-guardrail.ts` and a script entry:

```json
"smoke:tool-guardrail": "bun scripts/smoke-tool-guardrail.ts"
```

The smoke script should remain as small as the existing `smoke.ts`:

1. Create a gateway with an in-memory fake provider and an argument-scoped
   rule that blocks the fork-bomb literal for `run_shell`.
2. Offer `get_weather` and `run_shell` definitions.
3. Have the fake provider return one call for each.
4. Print the deterministic fake provider response under `before guardrail`.
5. Print the public gateway response under `after guardrail`.
6. Assert weather remains.
7. Assert shell is absent.
8. Assert decision is `filter` with one allowed and one blocked call.
9. Exit non-zero on any failed assertion.
10. Never execute either function.

The fixture can include a fork-bomb literal because it is inert JSON text. The
script must not pass it to a shell or interpolate it into a command.

### 19.10 Optional live-provider diagnostic

An opt-in live mode may offer the same two tools to a configured provider and
print only the gateway's sanitized result. It must:

- require an explicit environment flag;
- never dispatch returned tools;
- warn that model tool selection is probabilistic;
- avoid becoming a required CI test; and
- redact API credentials and arguments from production-style logs.

The deterministic fake-provider smoke remains the acceptance test. A live
model deciding not to call a requested tool is not evidence that filtering is
broken.

### 19.11 Commands

From `apps/gateway`:

```bash
bun test tests/openai-compatible-provider.test.ts
bun test tests/tool-call-evaluator.test.ts tests/policy-loader.test.ts
bun test tests/guardrail-pipeline.test.ts
bun run smoke:tool-guardrail
bun run check-types
bun test
bun run check:package
```

## 20. Manual Inspection Scenario

Use this policy:

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true
metadata:
  name: manual-tool-check
  version: 1
defaults:
  runtime_failure_mode: closed
tools:
  default_action: allow
  rules:
    - id: block-fork-bomb-literal
      tool_names: [run_shell]
      arguments:
        - path: command
          operator: equals
          values:
            - ":(){ :|:& };:"
      action: block
```

Offer these tools:

```ts
const tools: FunctionToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a command",
      strict: true,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];
```

A fake provider returns:

```json
{
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"Pune\"}"
      }
    },
    {
      "id": "call_2",
      "type": "function",
      "function": {
        "name": "run_shell",
        "arguments": "{\"command\":\":(){ :|:& };:\"}"
      }
    }
  ]
}
```

The returned public message must contain only:

```json
{
  "toolCalls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"city\":\"Pune\"}"
      }
    }
  ]
}
```

The result summary must be:

```json
{
  "decision": "filter",
  "allowedCallCount": 1,
  "blockedCallCount": 1,
  "ruleIds": ["block-fork-bomb-literal"]
}
```

This proves that the disallowed call is not exposed through `ChatResponse`. It
does not execute or sandbox the remaining call.

## 21. Rollout and Compatibility

### 21.1 Backward compatibility

- Existing text-only callers compile and behave as before.
- Existing policies without `tools` remain valid.
- `ChatResponse.message.content` changes from `string` to `string | null`, so
  TypeScript consumers must handle null after upgrading.
- Existing consumers that ignore optional `toolCalls` remain text-only.
- Streaming remains explicitly unsupported.

### 21.2 Recommended rollout

1. Release protocol support behind tests, with no tool policy configured.
2. Enable a default-allow audit policy and inspect counts only.
3. Add explicit block rules for known unwanted tools.
4. Migrate sensitive environments to `default_action: block` with named
   allows.
5. Add a gateway-owned executor later for high-impact tools.

Because this implementation is filtering rather than audit-only, there is no
production mode that logs blocked calls while still returning them.

## 22. Acceptance Criteria

Implementation is complete only when all criteria below are true:

- `ChatInput` accepts strict function tools and tool selection.
- `ChatResponse` exposes allowed calls as `message.toolCalls`.
- tool result continuation works through the OpenAI-compatible adapter.
- a name-blocked definition is not sent to the provider.
- every returned call is checked against the exact definitions sent.
- every returned argument object passes its local strict schema.
- matching blocked calls never occur in the public result.
- allowed siblings remain in a mixed response.
- an all-blocked response fails closed.
- output JSON-schema validation does not run on a tool-call response.
- text-only behavior and output guardrails remain unchanged.
- evaluator failures expose no calls.
- production logs and errors contain no tool arguments or raw response body.
- deterministic smoke output visibly shows before and after filtering.
- the consumer contract test proves a blocked executor is never invoked.
- type checks, all tests, package build, and package check pass.

## 23. Final Recommendation

Implement this inspection-only milestone. It is useful and proportionate for
applications that already own tool execution and can commit to dispatching
only the gateway's sanitized `toolCalls`.

Treat it as a call-distribution guardrail, not an execution sandbox. Exact tool
name policy is reliable within the gateway contract. Literal argument blocking
is useful for known values but is insufficient for adversarial shell safety.
High-impact tools should eventually move behind the gateway-managed execution
broker described in the research specification, with authorization, approval,
and runtime isolation immediately before the side effect.
