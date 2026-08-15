# Tool-Call Guardrail Design

## Purpose

The tool-call guardrail controls which function tools are exposed to a model
and which returned function calls are passed back to the consuming application.
It can block a tool by name or block calls whose structured arguments match a
configured rule.

The gateway does not execute tools. It returns only allowed calls. The consuming
application remains responsible for executing them, collecting results, and
sending a continuation request.

This is an inspection and filtering boundary. It reduces the chance that a
consumer executes a disallowed call, but it cannot protect a consumer that
ignores the sanitized gateway response and executes raw provider output from
another source.

## Design goals

The implementation is designed to:

- represent function definitions, function calls, and tool-result messages in
  the provider-neutral chat domain;
- remove name-blocked definitions before the provider sees them;
- validate every returned call against a tool definition and strict argument
  schema;
- apply exact, deterministic name and argument rules after generation;
- return allowed calls without executing them;
- filter mixed allowed and blocked parallel calls;
- fail closed when no returned call remains;
- preserve sanitized decision metadata; and
- work even when no tool policy is configured by retaining protocol and schema
  validation.

The following are not goals:

- executing, sandboxing, or scheduling tools;
- guaranteeing that a tool implementation is safe;
- interpreting arbitrary shell syntax securely;
- inspecting tool-result content;
- asking a human for approval;
- persisting tool-loop state; or
- managing provider-hosted tools that execute outside the consumer boundary.

## Trust boundary

The model's tool call is untrusted data. A model can select the wrong tool,
invent a name, return malformed JSON, or provide dangerous arguments.

The trusted path is:

```text
consumer tool definitions
  -> gateway request validation
  -> policy definition filtering
  -> provider
  -> gateway response and argument validation
  -> policy call filtering
  -> sanitized ChatResponse
  -> consumer authorization and execution
```

The consumer must execute only calls from the gateway's returned
`ChatResponse`. It should not execute provider traffic captured from logs,
callbacks, or a second unguarded client.

The final tool implementation is a separate security boundary. A `run_shell`
function, for example, still needs a restricted executable allowlist,
filesystem and network isolation, resource limits, and safe argument handling.

## Public chat contract

### Function definitions

The request uses strict function definitions:

```ts
interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
    strict: true;
  };
}
```

Example:

```ts
const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
        },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
] as const;
```

### Tool selection fields

`ChatInput` supports:

- `tools`: one through 128 unique function definitions;
- `toolChoice`: `auto`, `none`, `required`, or one forced function; and
- `parallelToolCalls`: a boolean provider hint.

A non-`none` tool choice requires definitions. A forced choice must reference a
supplied tool.

### Returned calls

An assistant tool call has this shape:

```ts
interface FunctionToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}
```

`arguments` stays a JSON string in the public response. The gateway parses it
internally for validation and matching but does not replace it with a JavaScript
object.

### Continuation messages

After executing an allowed call, the consumer sends the assistant tool-call
message and one tool-result message per call:

```ts
messages: [
  { role: "user", content: "What is the weather in Pune?" },
  {
    role: "assistant",
    content: null,
    toolCalls: [allowedCall],
  },
  {
    role: "tool",
    toolCallId: allowedCall.id,
    content: JSON.stringify({ temperatureC: 28 }),
  },
]
```

The gateway is stateless. The consuming application sends the tool definitions
again on every completion request that contains tool history or may need
another tool call. Historical calls must reference a tool supplied on that
request.

Every assistant call must receive exactly one following tool-result message
before the conversation continues. Call IDs must remain unique across the
provided history.

## Policy contract

Tool rules are configured in the optional top-level `tools` section:

```yaml
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: true

metadata:
  name: tool-policy
  version: 1

tools:
  default_action: allow
  rules:
    - id: block-fork-bomb
      tool_names: [run_shell]
      arguments:
        - path: command
          operator: equals
          values:
            - ":(){ :|:& };:"
      action: block
```

### Policy fields

- `default_action` is required and must be `allow` or `block`.
- `rules` is required and supports at most 128 items.
- every rule has a globally unique `id`;
- `tool_names` contains one through 128 unique exact names;
- `action` is `allow` or `block`; and
- `arguments` is optional and accepted only on a block rule.

Tool names contain one through 64 ASCII letters, digits, underscores, or
hyphens. Matching is exact and case-sensitive.

### Name-only rules

A rule without `arguments` applies to the whole named tool:

```yaml
- id: block-weather
  tool_names: [get_weather]
  action: block
```

Name-only rules are enforceable both before and after the provider call.

### Argument rules

An argument rule applies only to a returned call whose tool name and every
argument matcher match:

```yaml
- id: block-root-delete
  tool_names: [run_shell]
  arguments:
    - path: command
      operator: contains
      values: ["rm -rf /"]
  action: block
```

A rule with `tool_names: [get_weather]` and `path: command` does not block a
normal `get_weather` call containing only `{ "city": "Pune" }`. The argument
path is missing, so the rule does not match.

To block every call to a tool, omit `arguments`.

### Argument paths and operators

`path` is a dot-separated object path such as:

```text
command
request.options.mode
```

Paths support at most 16 segments. Segments contain letters, digits,
underscores, or hyphens. `__proto__`, `prototype`, and `constructor` are
forbidden. Traversal is through objects only; array indexing is not supported.

Operators are:

- `equals`: candidate equals any configured scalar value; and
- `contains`: candidate is a string containing any configured string.

`equals` accepts strings, finite numbers, booleans, and null. `contains`
accepts strings only. Each matcher accepts one through 64 values; policy strings
are limited to 4,096 characters.

String comparison normalizes CRLF to LF and trims leading and trailing ASCII
whitespace. It remains case-sensitive and otherwise literal. `contains` is a
substring operation, not a regular expression or shell parser.

### Decision precedence

For a tool or call:

1. collect all matching rules;
2. if any matching rule blocks, block;
3. otherwise, if any matching rule allows, allow; and
4. otherwise, use `default_action`.

Block therefore wins over allow regardless of rule order.

For an allowlist with an argument-specific exception, use both rules:

```yaml
tools:
  default_action: block
  rules:
    - id: allow-shell
      tool_names: [run_shell]
      action: allow
    - id: block-fork-bomb
      tool_names: [run_shell]
      arguments:
        - path: command
          operator: equals
          values: [":(){ :|:& };:"]
      action: block
```

The name-only allow makes the definition available. The argument block then
wins only for the dangerous returned call.

## Request validation

Request normalization validates the public tool protocol before guardrails run:

- at most 128 definitions;
- unique tool names;
- name syntax and description length;
- `strict: true` on every definition;
- object-valued parameter schemas;
- bounded call IDs and argument strings;
- valid tool selection fields; and
- complete, ordered tool-call history.

The schema registry then compiles every definition before the input guardrails
or provider are called.

### Strict schema subset

Every tool parameter schema must have an object root. Every schema node that
declares `type: object` must:

- declare `properties`;
- set `additionalProperties: false`; and
- list every property exactly once in `required`.

An application can model a conceptually optional value as a required property
whose schema accepts `null`.

Tool schemas must be finite JSON values, stay within 32 levels of nesting, and
serialize to no more than 100,000 characters. External HTTP, HTTPS, and file
references are rejected. Internal schema references may be used when the local
compiler can resolve them.

These restrictions provide one predictable validation contract across provider
and gateway boundaries.

## Pre-provider definition filtering

After input guardrails, the gateway filters request definitions with name-level
policy information.

Argument-specific rules are ignored in this phase because no model-generated
arguments exist yet. Only name-only rules and `default_action` can decide
whether a definition is offered.

Consequences:

- a name-blocked definition is never sent to the provider;
- a forced choice that becomes blocked causes `INVALID_REQUEST` before the
  provider call;
- `toolChoice: required` fails when every definition becomes blocked;
- if no definitions remain, the gateway removes `tools` and
  `parallelToolCalls`, then sets `toolChoice: none`; and
- if some definitions remain, their original order is preserved.

With `default_action: block`, an argument-only block rule does not by itself
make its tool available. Add a name-only allow rule for safe calls, as shown in
the allowlist example.

Definition filtering records allowed and blocked definition counts and matched
name-level rule IDs.

## Provider mapping

The OpenAI-compatible adapter sends:

- `tools` unchanged after filtering;
- `tool_choice` from `toolChoice`;
- `parallel_tool_calls` from `parallelToolCalls`;
- historical assistant calls as `tool_calls`; and
- tool-result messages with `tool_call_id`.

Incoming provider choices are converted back to camel-case gateway fields.
The adapter requires an assistant message with text, tool calls, or both; it
rejects malformed call IDs, names, types, and argument strings before the
policy evaluator receives them.

## Post-provider validation

The gateway first classifies the complete response as text or tool calls.

All choices must use the same mode. A response mixing text-only choices and
tool-call choices is rejected as an invalid model response.

For every returned tool call, the evaluator requires:

- a well-formed and globally unique call ID;
- `type: function`;
- a syntactically valid tool name;
- a name that was actually offered in the filtered provider request;
- a bounded JSON argument string;
- a parsed JSON object; and
- arguments satisfying the compiled schema for that tool.

Schema validation occurs even when no tool policy is configured. Tool policy
controls authorization; schema validation protects the protocol boundary.

A malformed, unoffered, duplicate, or schema-invalid call produces
`INVALID_MODEL_RESPONSE` with status 502. It is not reported as a policy block,
because the provider did not return a valid invocation to authorize.

## Post-provider policy filtering

After structural validation, each call is evaluated independently:

1. Parse the validated argument object.
2. Match tool name and all argument conditions.
3. Apply block-over-allow precedence and then the default.
4. Remove blocked calls from the response.
5. Keep allowed calls in original order.

For parallel calls, a mixed result is returned with only the allowed calls. If
a choice loses all its calls, that choice is removed. If no allowed call remains
in the whole response, the gateway blocks the response.

The possible outcomes are:

- `allow`: all valid calls are allowed;
- `filter`: at least one call is blocked and at least one remains; or
- `block`: no call remains.

The public `GatewayExecutionResult.toolGuardrails` summary is present for a
returned tool-call response and contains:

```ts
interface ToolGuardrailSummary {
  decision: "allow" | "filter";
  allowedCallCount: number;
  blockedCallCount: number;
  ruleIds: string[];
}
```

A full block throws instead of returning a summary:

```text
code: TOOL_GUARDRAIL_BLOCKED
status: 502
message: The model tool calls did not satisfy the tool policy.
```

## Consumer execution contract

The gateway's responsibility ends after returning sanitized calls. A correct
consumer loop is:

1. Send messages and current tool definitions through the gateway.
2. Read only `result.response.choices[*].message.toolCalls`.
3. Apply any application-specific identity, tenant, quota, or approval checks.
4. Execute each allowed call in the appropriate restricted environment.
5. Create one `tool` message for each completed call.
6. Send full conversation history and the definitions again for the next model
   turn.

The consumer should preserve call IDs exactly. It should not execute a blocked
call reconstructed from guardrail counts or logs.

Parallel calls require an application decision about atomicity. The gateway
filters calls independently and does not guarantee that the remaining batch is
transactional.

## Interaction with other guardrails

### Input guardrails

PII and prompt-injection guardrails inspect request messages before tool
definitions are filtered. They do not inspect tool names, descriptions, or
parameter schemas.

### Output guardrail

A provider tool-call response takes the tool path and bypasses the textual
output JSON Schema. Tool arguments use their own per-definition schemas.

If a tool-enabled provider turn returns normal assistant text, the configured
output guardrail validates that text as usual.

### Runtime failure mode

Tool protocol validation and policy matching are direct mandatory checks. They
are not wrapped in the input/output `runtime_failure_mode` fail-open behavior.
Invalid calls cannot be allowed because a tool evaluator encounters malformed
data.

## Lifecycle and logging

Definition filtering adds:

```text
tool_definitions_guardrails_started
tool_definitions_guardrails_completed
```

Call validation and filtering add:

```text
tool_calls_guardrails_started
tool_calls_guardrails_completed
```

Sanitized metadata can include:

- `decision`;
- `allowedDefinitionCount`;
- `blockedDefinitionCount`;
- `allowedCallCount`;
- `blockedCallCount`; and
- `ruleIds`.

The logger emits `gateway.guardrail_decision` records for
`tool_definitions` and `tool_calls`. Tool arguments, schemas, call IDs, and tool
result content are not included in these records.

## Security properties

The important invariants are:

- name-blocked definitions do not reach the provider;
- a provider cannot invoke a definition it was not offered;
- argument JSON must satisfy the consumer-supplied strict schema;
- block rules win over allow rules;
- blocked calls are absent from the returned response;
- an all-blocked response fails closed; and
- no tool is executed inside the gateway.

Argument substring rules are defense-in-depth, not a secure shell parser.
Equivalent commands, encoding, aliases, environment expansion, interpreters,
scripts, and indirect execution can bypass a blacklist. High-risk tools should
prefer narrow structured operations over a general-purpose command string.

## Testing

From `apps/gateway`:

```bash
bun test tests/tool-call-evaluator.test.ts
bun test tests/tool-guardrail-pipeline.test.ts
bun test tests/openai-compatible-provider.test.ts
bun test tests/policy-loader.test.ts
bun run smoke:tool-guardrail
```

Coverage should include:

- request normalization and history validation;
- strict schema compilation and argument validation;
- name-level filtering before provider execution;
- forced and required tool-choice conflicts;
- exact and nested argument matching;
- missing paths and multiple matcher semantics;
- block-over-allow precedence;
- mixed allowed and blocked parallel calls;
- all-blocked behavior;
- duplicate IDs, unoffered names, and malformed provider responses;
- provider snake-case and camel-case mapping;
- continuation requests with sanitized calls and tool results; and
- text output from a tool-enabled request.

The smoke script uses a deterministic provider response, prints calls before and
after filtering, and never executes a tool. Its final assertions describe the
specific checked-in policy. If that policy is intentionally changed, the smoke
expectations must be updated to assert the new allowed and blocked set.

## Main implementation files

- `src/domain/chat.ts`: public function-tool and message types.
- `src/domain/chat-normalizer.ts`: request, definition, call, and history
  validation.
- `src/guardrails/tools/tool-schema-validator.ts`: strict schema registry and
  argument validation.
- `src/guardrails/tools/tool-call-evaluator.ts`: definition and returned-call
  filtering.
- `src/guardrails/config/policy-loader.ts`: strict tool-policy parsing.
- `src/providers/openai-compatible-provider.ts`: provider wire mapping.
- `src/pipeline/gateway-pipeline.ts`: ordering, errors, summaries, and
  lifecycle behavior.
- `src/pipeline/lifecycle.ts`: tool-stage metadata.

Research and implementation rationale are recorded in
`specs/19_tool_guardrail_research.md` and
`specs/20_tool_guardrail_implement.md`.

## Known limitations

- Only function tools are supported.
- The gateway does not execute or sandbox tools.
- Argument matchers support literal scalar equality and string containment,
  not arrays, regexes, numeric ranges, or semantic parsing.
- Policy names are exact; aliases and versioned tool names need explicit rules.
- Filtering a parallel batch is not transactional.
- Tool-result content is not inspected by a dedicated guardrail.
- Provider-hosted tools that execute before returning a call are outside this
  enforcement boundary.
- The consumer must resend definitions because the gateway stores no tool
  registry or conversation state.
- A strict argument schema validates shape, not whether a requested operation is
  safe or authorized for the current user.

For sensitive operations, combine this guardrail with application identity,
capability checks, approval workflows, idempotency, audit logging, and an
execution sandbox close to the side effect.
