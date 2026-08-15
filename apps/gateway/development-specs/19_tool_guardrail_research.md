# Tool Guardrails: Research and Feasibility Specification

## 1. Purpose and Status

This document researches the tool-call guardrail requested in
`18_tool_guardrail.md` and maps it to the current gateway architecture. It
answers four questions:

1. What is a tool guardrail, and where must it run?
2. Can this gateway prevent selected tools or dangerous commands from being
   executed?
3. How does that differ from existing input and output guardrails around
   `chat.completions`?
4. What architectural foundation is required before an implementation plan is
   written?

This is a research and feasibility specification. It does not implement tool
calling, command execution, approvals, or a new policy version.

Research date: August 14, 2026.

## 2. Executive Conclusion

Tool guardrails are feasible, but not as another text detector attached to the
current one-shot chat pipeline.

The current gateway can inspect text before a model call and text after a model
call. It cannot currently receive structured tool calls or execute tools. Its
public and provider-neutral types contain only text messages, and its
OpenAI-compatible provider rejects any assistant message whose `content` is not
a string. Consequently, there is no current execution boundary at which the
gateway can truthfully guarantee that a command was not run.

The required security invariant is:

> Every client-executed tool invocation must be evaluated by local policy
> immediately before the gateway-controlled executor performs any side effect.

The model may propose a tool call. It must never be the component that
authorizes or directly executes the call.

The research supports the following conclusions:

- Blocking an entire tool by canonical tool name is straightforward.
- Restricting structured function arguments is feasible when the tool has a
  strict JSON Schema and the gateway owns the executor.
- Blocking arbitrary unsafe shell behavior with a blacklist or regular
  expression is not reliable. Shell syntax has too many equivalent and
  indirect forms.
- Shell access should use an allowlisted structured `argv` interface without a
  shell whenever possible. If raw shell syntax is accepted, it requires a
  dialect-aware parser, fail-closed handling for unsupported syntax, and a
  sandbox with independent resource limits.
- The fork-bomb example in `18_tool_guardrail.md` should be stopped both by
  policy and by an operating-system process limit. Either control alone is
  insufficient for a production security boundary.
- Provider-side controls such as `tool_choice.allowed_tools` reduce which calls
  the model can generate, but local authorization remains authoritative.
- Provider-hosted tools are a different trust boundary. A local gateway cannot
  interpose immediately before a provider executes a hosted tool during the
  API request. Such tools must be omitted, restricted through provider-native
  controls, or treated as provider-trusted execution.

The recommended direction is a gateway-managed tool execution broker with:

- a trusted tool registry;
- strict argument parsing and validation;
- local allow, block, and later approval decisions;
- an immutable invocation passed from evaluation to execution;
- execution isolation and resource limits; and
- lifecycle events that prove policy evaluation completed before execution.

## 3. Research Findings from Current Tool-Calling APIs

### 3.1 A model returns a request to call a tool

Tool calling does not mean that a normal function tool is automatically run by
the model. The application supplies tool definitions, the model can return a
structured tool-call request, and application code decides whether and how to
execute it.

The official OpenAI function-calling documentation describes a tool call as a
request from the model and shows application code parsing its arguments before
executing the function. It also states that a response can contain zero, one,
or multiple calls:

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)

This separation creates the correct enforcement point:

```text
model proposes call
        |
        v
parse and validate call
        |
        v
tool guardrail decision
        |
        +---- block/approval ----> no execution
        |
        v
gateway-owned executor
```

No tool implementation may run before the guardrail decision is complete.

### 3.2 Provider tool selection is useful but not sufficient authorization

The model API can restrict tool selection using `tool_choice`, including an
`allowed_tools` subset. It can also disable parallel calls. These controls are
useful defense in depth and can reduce irrelevant or disallowed proposals.

They are not the final security boundary because:

- a provider or adapter can return a malformed or unexpected call;
- a future provider may implement the option differently;
- an application can accidentally execute a call outside the intended list;
- provider-side selection cannot enforce local filesystem, tenant, identity,
  or command constraints; and
- allowed tool names do not determine whether a particular argument value is
  safe.

The gateway must therefore validate every returned call locally even when it
also filters tools in the provider request.

### 3.3 Function argument schema validation is necessary but not authorization

Strict function schemas make arguments structurally predictable. The official
documentation recommends strict mode and requires all properties to be
required and every object to set `additionalProperties: false`.

A schema can prove that an argument is a string, number, enum, array, or object.
It cannot by itself prove that:

- the target account belongs to the current tenant;
- deleting the target is authorized;
- a filesystem path stays inside an allowed workspace after symlink
  resolution;
- a URL is safe after DNS resolution and redirects;
- a shell string is non-destructive; or
- the caller has permission to perform the action now.

Tool argument schemas and tool guardrails solve different problems. Both are
required.

### 3.4 Tool guardrails belong next to the side effect

Official OpenAI guidance distinguishes input, output, and tool controls:

- input guardrails check the incoming request;
- output guardrails check the final response;
- tool guardrails check arguments or results around a function call; and
- human review pauses sensitive actions before execution.

It explicitly recommends placing validation next to the tool that creates the
side effect and failing closed when review cannot complete:

- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)

This supports an execution-broker design rather than trying to infer future
tool behavior from the original chat prompt.

### 3.5 Shell execution requires controls below the policy matcher

The shell documentation warns that arbitrary commands are dangerous and
recommends sandboxing, allowlists or denylists, and audit logging. It also
separates hosted shell execution from a locally hosted runtime:

- [Shell](https://developers.openai.com/api/docs/guides/tools-shell)
- [Local shell](https://developers.openai.com/api/docs/guides/tools-local-shell)

A command policy is therefore one layer. It does not replace operating-system
isolation, process limits, filesystem restrictions, network policy, identity
controls, timeouts, or output bounds.

## 4. Audited Gateway Baseline

### 4.1 Current public API

The only model operation is:

```ts
gateway.chat.completions.create(input, options);
```

`ChatInput` supports:

- `messages`;
- an optional model;
- temperature;
- a maximum token count; and
- a non-streaming flag.

It does not support:

- tool definitions;
- tool choice;
- parallel tool-call configuration;
- tool-result messages;
- tool callbacks;
- approval callbacks; or
- an agent/tool loop.

### 4.2 Current chat domain cannot represent tool calls

`src/domain/chat.ts` permits only `system`, `user`, and `assistant` message
roles. Every message has string content.

`ChatResponse` requires every assistant choice to contain string content. It
does not represent OpenAI Chat Completions fields such as:

```ts
message.tool_calls;
message.content === null;
finish_reason === "tool_calls";
```

It also cannot represent a `tool` role message carrying `tool_call_id` and a
tool result.

### 4.3 Current provider drops all tool functionality

`OpenAICompatibleProvider` sends only:

- `model`;
- `messages`;
- `stream`;
- optional `temperature`;
- optional `max_tokens`; and
- optional structured-output `response_format`.

It never sends `tools`, `tool_choice`, or `parallel_tool_calls`.

Its response parser requires `message.content` to be a string. A valid tool
call normally has structured `tool_calls` and may have null content, so it
would currently be reported as `INVALID_MODEL_RESPONSE`.

### 4.4 Current pipeline has no execution boundary

The pipeline is:

```text
normalize input
  -> input guardrail
  -> provider
  -> output guardrail
  -> return result
```

No registry maps a tool name to trusted code. No executor performs a tool call.
No loop returns tool results to the model. No state prevents a call from being
executed twice.

This means a tool guardrail cannot be added only as a new method on the current
`GuardrailHub`. Foundational tool representation and execution ownership are
required first.

### 4.5 Current policy has no tool section

`guardrails/v1` accepts only:

- top-level `input` rules; and
- zero or one top-level `output` rule.

The strict loader rejects unknown fields. Adding `tools` is therefore an
explicit policy-contract change. It must preserve existing policies while
validating all tool-specific fields strictly.

### 4.6 Existing failure-mode behavior is unsafe for tool execution

The existing `defaults.runtime_failure_mode` can be `open` or `closed`.
Fail-open is sometimes defensible for non-side-effecting text evaluation.

It is not a safe default at an execution boundary. If tool authorization
throws, times out, or encounters unsupported syntax, the tool must not run.
Tool evaluation should be fail-closed regardless of the current general
runtime failure mode, or it should have a separate tool-specific mode that is
fixed to `closed` in the first release.

## 5. How Tool Guardrails Differ from Chat Guardrails

| Property              | Input guardrail                               | Output guardrail                                 | Tool guardrail                                                |
| --------------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Evaluated value       | User/system/assistant text sent to the model  | Final assistant text returned by the model       | Canonical tool name and parsed invocation arguments           |
| Timing                | Before provider call                          | After provider call, before returning final text | After model proposes a call and immediately before execution  |
| Primary risk          | Sensitive or adversarial prompt reaches model | Invalid or disallowed text reaches caller        | A real side effect occurs                                     |
| Existing actions      | Allow, redact, block                          | Allow, retry, block                              | Must support allow/block; approval is a later stateful action |
| Safe failure default  | Policy-dependent                              | Policy-dependent                                 | Fail closed                                                   |
| Retry meaning         | Usually no retry                              | Ask model to repair output                       | Dangerous by default; repeated calls can repeat side effects  |
| Atomicity concern     | One normalized request                        | One or more response choices                     | Multiple calls may form a batch with partial side effects     |
| Enforcement authority | Gateway owns provider dispatch                | Gateway owns response release                    | Gateway must own or wrap execution                            |

The most important difference is side effects. A blocked output is merely not
returned. A tool invocation may delete data, spend money, send a message, leak
a secret, or consume system resources. The authorization decision must occur
at the last reliable point before that effect.

## 6. Required Trust Boundaries

### 6.1 Trusted components

The security design may trust:

- policy files supplied by an administrator or deployment owner;
- the gateway's policy loader and evaluator;
- the gateway's canonical tool registry;
- a correctly isolated executor; and
- authenticated runtime context supplied by the host application.

### 6.2 Untrusted inputs

The design must treat all of the following as untrusted:

- user messages;
- model-selected tool names;
- model-generated arguments;
- tool descriptions that originated outside trusted code;
- tool outputs returned from external systems;
- remote MCP metadata and results;
- shell command strings;
- URLs, paths, identifiers, and code embedded in arguments; and
- provider responses, including malformed or duplicate tool-call IDs.

### 6.3 Policy authors are not chat users

The phrase “specified by the user” must mean a trusted SDK/deployment policy
author, not the end user sending the chat prompt.

End-user text must never be able to add an allow rule, remove a deny rule,
change the sandbox, or approve its own action. Per-request business context may
narrow permissions, but it must be authenticated and supplied out of band from
the prompt.

### 6.4 Client-executed and provider-executed tools are different

There are three important tool locations:

| Tool location               | Example                                                    | Can local gateway block immediately before execution?          |
| --------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Gateway/application runtime | Function callback, local database client                   | Yes, if all execution goes through the broker                  |
| User/local shell runtime    | A shell executor hosted beside the gateway                 | Yes, if the broker controls the executor                       |
| Provider-hosted runtime     | Hosted shell, provider web search, hosted code interpreter | No local pre-execution interposition after the request is sent |

For provider-hosted tools, the gateway can filter or reject the tool definition
before the provider call and validate returned evidence afterward. It cannot
claim that it checked each internal action immediately before the provider
performed it.

The first implementation milestone should therefore target client-executed
function tools. Provider-hosted tool enforcement should be a separate feature
with explicitly weaker guarantees.

## 7. Threat Model

### 7.1 Protected assets

Tool policies may need to protect:

- filesystem contents;
- source repositories;
- credentials and environment variables;
- databases and tenant records;
- cloud accounts and infrastructure;
- network-reachable internal services;
- email, messaging, payment, and other external accounts;
- compute, memory, process, disk, and network capacity; and
- audit integrity and idempotency records.

### 7.2 Threats in scope

The research assumes attackers may attempt to:

- ask directly for a blocked tool;
- inject instructions through retrieved data or tool output;
- use an allowed tool as a confused deputy;
- encode a dangerous action using alternate whitespace, quoting, variables,
  nested shells, interpreters, scripts, aliases, or equivalent utilities;
- split one forbidden action across several allowed calls;
- exploit path traversal or symbolic links;
- reach private networks through allowed URL-fetching tools;
- exfiltrate data to an allowed destination;
- replay a previously approved call;
- exploit parallel calls so an allowed side effect happens before a sibling
  call is blocked;
- exhaust processes, CPU, memory, disk, or output capacity; or
- place secrets in arguments that are later logged.

### 7.3 Non-goals for a first tool-guardrail milestone

A first milestone should not claim to:

- determine whether every possible program is safe;
- semantically classify arbitrary shell programs with perfect accuracy;
- replace an operating-system sandbox;
- secure tool calls executed entirely outside the gateway;
- enforce provider-internal actions that the API does not expose before
  execution;
- provide a complete human-approval persistence service;
- authorize based on natural-language tool descriptions;
- inspect encrypted payloads unavailable to the gateway; or
- make arbitrary third-party MCP servers trustworthy.

## 8. Feasibility by Control Type

### 8.1 Block an entire tool

Feasibility: high.

Match the canonical tool registry name using exact ASCII comparison. If a tool
is denied, omit it from the provider request where possible and reject any
returned call using that name.

The local returned-call check is mandatory even if the tool was omitted
upstream.

### 8.2 Allow only selected tools

Feasibility: high.

An allowlist is safer than a denylist because newly registered tools are not
automatically executable. The policy should have an explicit default action.
For an execution-capable deployment, the recommended default is `block`.

Provider `allowed_tools` can mirror the local allowlist when supported, while
the local registry remains authoritative.

### 8.3 Validate structured function arguments

Feasibility: high for structural constraints and medium for authorization.

The gateway can:

- parse JSON arguments once;
- reject malformed JSON and duplicate object keys;
- enforce a strict JSON Schema owned by the registered tool;
- enforce maximum serialized and nesting sizes;
- resolve trusted runtime values outside model arguments; and
- apply tool-specific authorization predicates.

Business authorization needs trusted context. For example, a model-generated
`account_id` cannot prove that the caller owns that account.

### 8.4 Block selected commands inside a shell tool

Feasibility: low with raw blacklist matching; medium with a restricted command
language; high when raw shell is removed and commands are registered as
separate structured tools.

Preferred order:

1. Do not expose a general shell tool.
2. Replace common operations with narrow typed tools.
3. If command execution is necessary, accept an executable plus an argument
   array and launch with `shell: false`.
4. Allowlist executables and validate arguments structurally.
5. Use a sandbox and resource limits even after policy allows the command.
6. Treat raw shell strings as an advanced, higher-risk mode.

### 8.5 Require approval for risky calls

Feasibility: medium, but stateful.

Approval requires the run to pause before execution, return a stable pending
invocation identifier, preserve the exact invocation, and later resume without
asking the model to regenerate the call.

An approval token must be bound to:

- the policy version;
- the tool name;
- the exact canonical arguments;
- the authenticated actor and tenant;
- an expiry time; and
- a single execution attempt.

The first implementation may defer approval and support only allow/block. It
must not represent approval-required calls as ordinary blocks if callers need
to distinguish the states later.

### 8.6 Inspect tool results

Feasibility: high for size/schema checks and targeted secret filtering.

Tool output is another untrusted input to the model. A complete tool boundary
eventually needs post-execution checks for:

- output size;
- declared result schema;
- secrets or credentials;
- prompt-injection content from remote systems; and
- safe truncation before returning the result to the model.

Post-execution checking cannot undo a side effect. It is separate from the
pre-execution authorization required by `18_tool_guardrail.md`.

## 9. Why Arbitrary Command Blacklists Are Insufficient

### 9.1 Equivalent spellings

Shells allow whitespace changes, quoting, variables, command substitution,
subshells, pipelines, redirection, functions, aliases, globbing, and nested
interpreter invocations. The same behavior can have many textual forms.

A rule that looks for one literal fork-bomb string can be bypassed by changing
spacing, defining the function over multiple commands, sourcing a file, or
using another resource-exhaustion mechanism.

### 9.2 Indirect execution

Even if one executable is denied, a general-purpose interpreter can reproduce
the behavior:

- `sh -c` and other shells;
- `python`, `node`, `perl`, or similar interpreters;
- `eval` or sourced scripts;
- build tools with command hooks; and
- an allowed binary that loads plugins or runs subprocesses.

Executable-name matching is useful only inside a deliberately restricted tool
surface.

### 9.3 Parsing and execution must agree

If the policy parser interprets a command differently from the actual shell,
an attacker can exploit the mismatch. The safest design avoids a shell and
passes an immutable executable/argument array directly to process creation.

If a raw shell mode exists, it must declare one supported dialect. The same
dialect must be used for:

- parsing;
- policy evaluation; and
- execution.

Unsupported constructs must block. Falling back to string execution after a
parser error would negate the guardrail.

### 9.4 Resource controls stop classes of bypasses

The fork-bomb example is fundamentally process exhaustion. A process-count
limit prevents the damage class even when a novel syntax bypasses a text rule.

A shell sandbox should independently constrain:

- maximum processes and threads;
- CPU time;
- wall-clock time;
- memory;
- writable disk and file size;
- output size;
- open files;
- network access;
- user and group identity;
- Linux capabilities or equivalent privileges;
- visible filesystem roots; and
- environment variables and secrets.

Policy answers “is this requested action allowed?” Isolation answers “what is
the maximum damage if policy or code is wrong?” Both are required.

## 10. Recommended Architectural Boundary

### 10.1 Gateway-managed execution broker

The recommended architecture is:

```text
Chat/agent request
       |
       v
input guardrails
       |
       v
provider call with policy-filtered tool definitions
       |
       v
parse structured tool calls
       |
       v
validate all calls in the proposed batch
       |
       v
tool guardrails and authorization
       |
       +---- block ----------> stop with generic tool-policy error
       |
       +---- approval -------> return paused state; execute nothing
       |
       v
gateway-managed tool executor
       |
       v
tool-result guardrails
       |
       v
return results to model
       |
       v
repeat within bounded tool-round/call budgets
       |
       v
final assistant output guardrails
```

This creates a real enforcement point. The tool implementation is unreachable
from the model except through the broker.

### 10.2 Tool registry

Tool definitions must come from trusted application code, not from the model.
A registry entry should bind together:

- a canonical name;
- a description exposed to the model;
- a strict argument schema;
- optional result schema;
- trusted capability metadata;
- whether the tool is read-only or side-effecting;
- whether approval may be required;
- an executor callback; and
- execution limits appropriate to the tool.

The registry must reject duplicate names and names that are not valid in every
configured provider.

### 10.3 Canonical invocation

The model response should be transformed once into an immutable internal
invocation:

```ts
interface ToolInvocation {
  callId: string;
  toolName: string;
  arguments: Readonly<Record<string, unknown>>;
}
```

The actual design may need recursive read-only values, but the invariant is
that the executor receives exactly the invocation the guardrail evaluated.
Reparsing or reinterpolating a raw string after authorization creates a
time-of-check/time-of-use risk.

### 10.4 Preflight an entire parallel batch

If one model response contains several calls, the gateway should parse,
validate, and authorize every call before executing any of them.

For the first release, if any call is blocked or requires approval:

- execute none of the calls in that batch;
- do not partially commit allowed siblings; and
- return one deterministic decision for the batch with per-call internal
  metadata.

This avoids partial side effects and order-dependent policy bypasses. A later
release can introduce explicit non-atomic execution only with a documented
contract.

### 10.5 Bounded loop and replay protection

The broker needs limits independent of model token limits:

- maximum tool rounds;
- maximum calls per round;
- maximum calls per run;
- maximum parallel executions;
- per-tool timeout;
- maximum argument and result sizes; and
- maximum total tool-result bytes sent back to the model.

It must also track call IDs and execution state so provider retries, client
retries, or resumed approvals do not execute a side effect twice.

## 11. Alternative Architectures

### 11.1 Inspect and return tool calls to the application

The gateway could add `tool_calls` to `ChatResponse`, block disallowed calls,
and return allowed calls for the consuming application to execute.

Advantages:

- smaller change;
- closely matches raw Chat Completions semantics; and
- does not require tool callbacks in the gateway.

Limitation:

The gateway can guarantee only that a disallowed call was not returned through
that response. It cannot guarantee that the application did not execute an
equivalent action elsewhere or bypass the gateway. This does not fully satisfy
“block a command from being run.”

### 11.2 Standalone guarded executor

The SDK could expose a separate operation such as a guarded tool executor. The
application would pass each invocation through it.

Advantages:

- separates tool authorization from the model API;
- supports more than one model/provider workflow; and
- can be adopted without a full agent loop.

Limitation:

The guarantee holds only if every caller uses the executor and cannot call the
underlying tool directly. Encapsulation and dependency design become part of
the security boundary.

### 11.3 Gateway-managed agent loop

The gateway owns tool definitions, authorization, execution, results, and the
model continuation loop.

Advantages:

- strongest enforceable guarantee;
- consistent lifecycle and audit trail;
- central call budgets and idempotency; and
- the final output guardrail can run only after tools finish.

Costs:

- largest API expansion;
- requires resumable state for approval;
- requires provider-neutral tool-call types; and
- changes the current one-provider-call mental model.

This is the recommended long-term architecture. A standalone guarded executor
can be an intermediate milestone if the full loop is too large.

## 12. Candidate Policy Semantics for Later Design

This section records a possible direction for the next implementation plan. It
is not a finalized YAML contract.

### 12.1 Prefer explicit allowlists and capabilities

A tool policy should be able to express:

- the default action for unmentioned tools;
- exact canonical tool names;
- trusted capability labels such as `filesystem.read`, `filesystem.write`,
  `network`, `message.send`, or `shell`;
- argument-specific constraints; and
- allow, block, or approval-required outcomes.

Capability labels must be assigned by trusted registry code. The model must not
be able to label its own tool as read-only.

### 12.2 Candidate shape

An illustrative policy could look like:

```yaml
tools:
  default_action: block
  maximum_rounds: 4
  maximum_calls: 8
  rules:
    - id: allow-customer-lookup
      tool_names: [get_customer]
      action: allow

    - id: block-general-shell
      capabilities: [shell]
      action: block

    - id: review-account-mutation
      capabilities: [account.write]
      action: require_approval
```

This example intentionally avoids arbitrary user-supplied command regexes.
Tool-specific constraints should be typed and validated rather than embedded
as an unrestricted expression language.

### 12.3 Decision precedence

The existing input policy uses ordered rule resolution. Tool authorization has
higher side-effect risk and should avoid an accidental broad allow overriding
a narrow deny.

Recommended precedence:

```text
block > require_approval > allow > default_action
```

All matching rules should be evaluated. A block always wins. This is easier to
audit than first-match wins for side-effect authorization.

### 12.4 Command-specific policy

If a command tool is introduced, its safe form should resemble:

```ts
interface CommandInvocation {
  executable: string;
  args: string[];
  workingDirectoryId?: string;
}
```

The model should not supply:

- an absolute working directory;
- environment variables;
- an operating-system user;
- network credentials;
- a sandbox escape switch; or
- an unbounded timeout.

Those values belong to trusted registry and deployment configuration.

### 12.5 Policy validation requirements

A future strict loader should reject:

- unknown tool-policy fields;
- duplicate rule IDs across input, output, and tool rules;
- duplicate tool names in one selector;
- invalid or non-canonical tool names;
- an empty rule selector;
- an allow rule with no trusted selector;
- approval actions when no approval handler is configured;
- command constraints on non-command tools;
- unsafe numeric limits; and
- policy combinations that make a registered side-effecting tool executable
  without an allow or approval path.

## 13. Provider-Neutral Contract Changes Required

Before tool guardrails can run, the gateway needs provider-neutral types for:

### 13.1 Tool definitions

```ts
interface FunctionToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
    strict: true;
  };
}
```

The exact public shape is a later design decision. The important requirement
is a strict trusted schema for every function tool.

### 13.2 Tool calls

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

The provider parser must preserve the opaque call ID and raw argument string
until canonical parsing succeeds.

### 13.3 Tool-result messages

Chat Completions requires a tool result to reference the model call ID. The
current `ChatMessage` union cannot represent that message and must become a
discriminated union rather than adding optional fields to every role.

### 13.4 Guardrail result

The internal decision needs at least:

```ts
type ToolGuardrailResult =
  | { decision: "allow"; invocation: ToolInvocation }
  | { decision: "block"; ruleIds: string[]; reasonCode: ToolViolationType }
  | {
      decision: "require_approval";
      ruleIds: string[];
      pendingInvocation: PendingToolInvocation;
    };
```

Approval may be deferred from the first implementation, but the research
should not collapse it into allow or block semantically.

## 14. OpenAI-Compatible Provider Mapping

### 14.1 Chat Completions

For function tools, the adapter would eventually map trusted definitions to
`tools`, map the local permitted subset to `tool_choice.allowed_tools` when the
configured provider supports it, and parse `message.tool_calls`.

The gateway must not assume every “OpenAI-compatible” endpoint supports the
same tool-choice features. Provider capability configuration should be
explicit, as it already is for structured output.

### 14.2 Responses API

Responses represents function calls as output items and also exposes hosted
tools that do not map cleanly to Chat Completions. A future Responses adapter
should use the same canonical internal invocation for client-executed function
calls.

Hosted tool actions require a separate policy model because execution can
happen inside the provider request. They must not silently inherit the stronger
guarantee of gateway-managed functions.

### 14.3 Tool filtering and prompt caching

Provider-native `allowed_tools` can retain a stable tool-definition list while
narrowing callable tools. This may help prompt caching, but it is an
optimization. Policy correctness must not depend on it.

## 15. Interaction with Existing Guardrails

### 15.1 Input guardrails

Input guardrails still run once before the first model call. They cannot decide
whether a later tool argument is safe because the argument does not exist yet.

PII redaction remains useful because it prevents sensitive prompt values from
reaching both the model and model-generated tool arguments.

### 15.2 Prompt-injection guardrails

Prompt-injection checks on the original request are not enough. Tool results,
retrieved pages, files, and MCP content can introduce instructions after the
first model call.

A later tool-output guardrail should evaluate untrusted textual tool results
before feeding them back to the model. That is defense in depth; tool
authorization must still enforce scope even if prompt-injection detection
misses something.

### 15.3 Output guardrails

A tool-call turn is not the final assistant answer. The existing JSON output
guardrail should not try to parse a tool-call response as final JSON content.

The tool/agent loop should run first. Output guardrails should evaluate only
the final assistant response, after all allowed tool calls and tool results are
complete.

### 15.4 Repair and retry behavior

Output repair retries are safe because they regenerate text before release.
Tool-call retries are different: a retry can duplicate a side effect.

The gateway must never ask the model to “repair” a blocked call and then
execute a replacement automatically in the same security context. A blocked
call should stop the run in the first release. Any future alternative-planning
flow needs a fresh policy evaluation and strict call budget, while preserving
the fact that no previous blocked call executed.

## 16. Error and Decision Semantics

### 16.1 Public block error

A blocked tool call should produce a generic error such as:

```text
TOOL_GUARDRAIL_BLOCKED
The requested tool action was blocked by policy.
```

The public error must not include:

- raw command text;
- secret-bearing arguments;
- filesystem paths;
- full URLs with credentials or query data;
- policy internals that help bypass matching; or
- underlying parser or authorization exceptions.

### 16.2 Invalid model tool call

Malformed call IDs, unknown tools, invalid JSON arguments, schema violations,
duplicate IDs, and excessive call counts should be distinguished internally.

Unknown tools and malformed invocations must never reach an executor. Whether
they become `INVALID_MODEL_RESPONSE` or a dedicated tool-call error is a later
public-contract decision.

### 16.3 Tool runtime failure

An authorized tool that fails during execution is different from a policy
block. Its result may be returned to the model in a sanitized structured form
when that is safe, or it may terminate the run.

The tool guardrail must not be blamed for executor failures, and executor
failures must not trigger blind side-effect retries.

## 17. Lifecycle and Audit Requirements

A tool-capable lifecycle needs evidence that policy evaluation preceded every
execution. Candidate stages are:

```text
tool_calls_received
tool_guardrails_started
tool_guardrails_completed
tool_approval_pending
tool_execution_started
tool_execution_completed
tool_result_guardrails_started
tool_result_guardrails_completed
```

The ordering invariant is:

```text
tool_guardrails_completed(decision=allow)
    occurs before
tool_execution_started
```

Safe lifecycle metadata may include:

- request ID;
- model;
- policy name and version;
- call ID;
- canonical tool name;
- trusted capability labels;
- decision;
- matched rule IDs;
- violation category;
- round and call counts;
- approval state; and
- execution duration and sanitized outcome.

Logs must not include raw arguments or tool results by default. Specific tools
may define safe metadata extractors in trusted code, but model-provided values
must never be logged automatically.

## 18. Security Invariants for an Implementation Plan

The next implementation plan should preserve these invariants:

1. A model response is a proposal, never authorization.
2. Every executable client-side call resolves to one trusted registry entry.
3. Arguments are parsed and validated before policy evaluation.
4. Policy failure, parser failure, timeout, or unsupported syntax blocks
   execution.
5. The executor receives exactly the canonical invocation that was approved.
6. No call in a parallel batch executes until all calls in the batch pass
   preflight.
7. No policy block triggers an automatic side-effect retry.
8. The same call ID cannot execute twice within one run.
9. Tool arguments and results are absent from default logs and public errors.
10. Provider-side tool filtering is defense in depth; local policy is
    authoritative.
11. A command allow decision does not bypass sandbox and resource limits.
12. Provider-hosted tools are never described as locally pre-execution guarded.
13. End-user prompt content cannot weaken the policy or self-approve a call.
14. Final output guardrails run only on final assistant output, not tool-call
    turns.
15. Existing text-only chat calls retain their current behavior when no tools
    are configured.

## 19. Verification Strategy Derived from the Research

The future implementation plan should require tests in these groups.

### 19.1 Policy loader

- valid default-deny tool policy;
- exact allow and block selectors;
- capability selectors;
- duplicate and unknown fields;
- duplicate IDs across every guardrail phase;
- invalid numeric budgets;
- approval without an approval provider; and
- backward compatibility for existing `guardrails/v1` policies.

### 19.2 Provider adapter

- tool definitions mapped correctly;
- permitted subset mapped only when supported;
- tool calls with null content parsed correctly;
- multiple calls preserved in order;
- malformed arguments preserved for local rejection, not executed;
- unknown and duplicate call IDs rejected; and
- text-only responses unchanged.

### 19.3 Local authorization

- blocked tool name makes zero executor calls;
- unmentioned tool obeys default action;
- deny precedence wins over broad allow;
- authenticated tenant/resource checks use trusted context;
- malformed or oversized arguments fail closed;
- guardrail exceptions fail closed; and
- raw arguments never appear in logs or errors.

### 19.4 Batch behavior

- all allowed calls execute only after full preflight;
- one blocked sibling causes zero calls for the entire batch;
- repeated call IDs do not execute twice;
- maximum calls and rounds are enforced before execution; and
- execution concurrency respects the configured limit.

### 19.5 Command security

- exact known dangerous samples block;
- whitespace, quoting, and multiline variants do not bypass restricted mode;
- unsupported shell syntax blocks;
- nested shell/interpreter invocations block unless explicitly allowed;
- path traversal and symlink escapes block;
- timeout terminates the process tree;
- process, memory, disk, and output limits are effective; and
- network-denied mode cannot reach external or internal network targets.

The command suite must include mutation testing or bypass-oriented fixtures.
Passing a handful of literal denylist examples is not sufficient evidence.

### 19.6 Lifecycle

- allow decision recorded before execution start;
- block produces no execution lifecycle event;
- no raw argument or result values in events;
- approval pause executes nothing;
- resume uses the same immutable invocation; and
- failure events identify the correct stage without leaking private data.

## 20. Phased Feasibility Recommendation

### Phase A: Provider-neutral function-call representation

Add tool definitions, calls, results, and provider parsing without executing
tools. Preserve text-only behavior.

Exit criterion: a valid function call can round-trip through the provider
adapter without being mistaken for invalid text output.

### Phase B: Guarded execution broker with allow/block

Add the trusted registry, strict argument validation, local policy evaluation,
zero-execution block guarantees, batch preflight, call budgets, and lifecycle
events.

Exit criterion: every client-executed function call has a recorded local allow
decision before exactly one executor invocation.

### Phase C: Bounded model/tool loop

Return sanitized tool results to the model and continue until final output or a
strict round/call budget is reached. Run existing output guardrails only on the
final assistant response.

Exit criterion: tool rounds are bounded, replay-safe, and compatible with
existing input/output guardrails.

### Phase D: Approval and resumable state

Add `require_approval`, immutable pending calls, expiry, actor binding, and
single-use resume semantics.

Exit criterion: a pending call cannot execute before approval and cannot be
changed or replayed after approval.

### Phase E: Restricted command executor

Prefer a structured executable/argument interface, an allowlist, and a sandbox.
Raw shell syntax should remain disabled until its parser and isolation model
have separate security review.

Exit criterion: command policy bypasses remain bounded by verified operating-
system resource and access controls.

### Phase F: Provider-hosted and remote tools

Define explicitly weaker guarantees for hosted tools, MCP, computer use, and
other remote execution surfaces. Add provider-native filtering and tool-result
inspection without claiming local pre-execution interposition.

## 21. Design Decisions Required Before the Implementation Plan

The following decisions materially change scope and should be confirmed:

1. **Execution ownership:** Must the gateway execute registered tools, or only
   inspect tool calls before returning them to the application?
2. **First provider surface:** Is the first milestone Chat Completions function
   tools only, or must it include the Responses API?
3. **Hosted tools:** Are provider-hosted shell, web, computer-use, code-
   interpreter, or MCP tools in scope?
4. **Initial actions:** Should the first release support only allow/block, or
   must it include stateful human approval?
5. **Policy compatibility:** Should tool rules extend `guardrails/v1` or require
   a `guardrails/v2` contract?
6. **Default:** Should unmentioned tools default to block? This document
   recommends yes.
7. **Batch semantics:** Should one denied call block the entire proposed batch?
   This document recommends yes for the first release.
8. **Shell surface:** Can raw shell strings be excluded initially in favor of
   registered typed operations or structured `argv` execution? This document
   strongly recommends yes.
9. **Sandbox ownership:** Will the SDK provide a sandbox adapter, or require the
   host application to supply a compliant executor?
10. **Business authorization:** What trusted request context is available for
    tenant, actor, role, resource, and environment checks?
11. **Approval persistence:** If approval is required, which component stores
    resumable state and authenticates the approver?
12. **Tool output:** Are result schema, PII, and prompt-injection checks part of
    the same milestone or deferred?

## 22. Recommended Answers

Unless product requirements say otherwise, the implementation plan should use
these defaults:

- gateway-managed execution for client-side function tools;
- Chat Completions function tools first, with provider-neutral internal types;
- provider-hosted tools out of the first milestone;
- allow and block first; approvals in a second milestone;
- strict policy loading with default deny;
- deny precedence over approval and allow;
- atomic preflight for every proposed batch;
- no raw general-purpose shell in the first milestone;
- a host-supplied executor interface with documented isolation requirements,
  followed by a separate sandbox adapter if needed;
- authenticated authorization context outside model arguments;
- final-output validation only after the bounded tool loop; and
- tool-result size/schema checks in the first execution milestone, with richer
  PII and prompt-injection evaluation added afterward.

These choices produce an enforceable security claim without pretending that a
command denylist can safely classify arbitrary programs.

## 23. Source Summary

The research used the following current official OpenAI documentation:

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling):
  tool-call lifecycle, multiple calls, strict arguments, `tool_choice`, allowed
  tools, and parallel-call behavior.
- [Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals):
  distinction between input/output/tool guardrails, approval pauses, and the
  requirement to put checks next to side-effecting tools.
- [Shell](https://developers.openai.com/api/docs/guides/tools-shell): hosted and
  local execution boundaries, sandboxing, allow/deny lists, logging, network
  controls, and bounded local executors.
- [Local shell](https://developers.openai.com/api/docs/guides/tools-local-shell):
  application-controlled execution and the need for strict command safeguards.

## 24. Final Feasibility Statement

The requested feature is feasible for tools executed by code that the gateway
owns or wraps. The gateway can reliably block a selected tool, reject malformed
arguments, enforce resource/tenant constraints, and prevent execution when
policy evaluation fails.

It is not feasible to provide the same guarantee by scanning chat text or by
matching a short list of dangerous command strings. Reliable command safety
requires a smaller structured tool surface, local pre-execution authorization,
and an independent sandbox.

The next document should be an implementation plan only after the execution
ownership, first provider surface, approval scope, and raw-shell decisions in
Section 21 are settled.
