# Model Gateway SDK: Implementation Specification

## 1. Document Purpose

This document converts the SDK requirements in `04_sdk.md` into an
implementation-ready architecture and delivery plan.

The milestone turns the existing gateway into a reusable, class-based
TypeScript SDK while preserving the current HTTP service, guardrail behavior,
provider behavior, lifecycle ordering, error contracts, configuration, and
smoke-test coverage.

This is a design specification. It does not implement the SDK.

## 2. Requirements Interpretation

The phrase “make this gateway like an SDK” is interpreted as an **in-process
gateway SDK**:

- a consuming application installs or imports the gateway package;
- it constructs a `ModelGateway` object;
- it supplies a model provider and optional guardrail policy;
- it invokes a typed chat-completion method directly; and
- no local HTTP listener is required for SDK use.

The existing Elysia service remains available. It becomes one adapter over the
same `ModelGateway` execution path rather than a separate implementation.

The milestone does not add a client for calling a remotely hosted gateway.
That would be a separate “remote client SDK” concern.

## 3. Assumptions and Provisional Decisions

The following decisions keep the implementation concrete without blocking on
product naming:

1. The SDK is TypeScript-first and ESM-only.
2. The SDK supports Bun 1.3+ and Node.js 20+.
3. The package name used in examples is provisionally `@llm-gateway/sdk`.
4. The implementation prepares a publishable package but does not publish it
   to a registry.
5. The current `apps/gateway` package remains the implementation location for
   this milestone. A later repository cleanup may extract it to `packages/`
   without changing the public API.
6. SDK configuration is explicit. Importing the SDK does not read environment
   variables, load a policy, start a listener, or write logs.
7. The current HTTP API remains byte-for-byte compatible at the contract level.

The package name can be changed before publication without changing the class
or method design.

## 4. Goals

The SDK milestone must:

1. Add a public `ModelGateway` class.
2. Provide an elegant typed chat-completion API on the gateway instance.
3. Preserve the existing `GatewayPipeline` as the single execution engine.
4. Allow custom `ModelProvider`, `GuardrailHub`, and `Logger` implementations.
5. Provide a convenience factory that loads an optional YAML policy once.
6. Keep the existing HTTP server behavior unchanged.
7. Ensure importing the SDK has no process-level side effects.
8. Expose stable request, response, result, lifecycle, and error types.
9. Produce ESM JavaScript and TypeScript declaration files.
10. Add a direct SDK smoke script that does not start an HTTP server.
11. Retain the existing HTTP smoke scripts for end-to-end server verification.
12. Verify the built package from an external consumer fixture.

## 5. Non-goals

This milestone must not:

- replace the existing HTTP endpoint;
- add an HTTP client for a remote gateway;
- add streaming, tool calls, multimodal input, or retrieval;
- change input or output guardrail semantics;
- change the YAML policy contract;
- change provider retry, timeout, or error mapping;
- add provider routing or fallback providers;
- add policy hot reload;
- read `.env` automatically when the SDK is imported;
- provide browser or edge-runtime support;
- publish a package to npm or another registry;
- introduce decorators, dependency-injection containers, or plugin discovery;
- add aliases for the same SDK operation; or
- expose every internal helper as public API.

## 6. Core Architectural Decision

The SDK is a facade over the existing pipeline:

```text
Consuming application
        |
        v
ModelGateway
        |
        v
ChatCompletionsResource
        |
        v
GatewayPipeline
   |             |
   v             v
GuardrailHub   ModelProvider
```

The HTTP service uses the same object:

```text
HTTP request
    |
    v
Elysia adapter
    |
    v
ModelGateway.chat.completions.create(...)
    |
    v
GatewayPipeline
```

There must not be one pipeline for SDK calls and another for HTTP calls.

## 7. Public SDK Shape

### 7.1 Canonical usage

```ts
import { ModelGateway, OpenAICompatibleProvider } from "@llm-gateway/sdk";

const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  timeoutMs: 30_000,
});

const gateway = await ModelGateway.create({
  provider,
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.response.choices[0]?.message.content);
```

The method path `gateway.chat.completions.create()` is the only high-level
chat-completion operation. The SDK must not also add redundant aliases such as
`gateway.complete()`, `gateway.chat()`, or `gateway.run()` in version 1.

### 7.2 Direct dependency injection

Applications that already construct their own guardrail hub use the synchronous
constructor:

```ts
const gateway = new ModelGateway({
  provider: customProvider,
  defaultModel: "custom-model",
  guardrails: customGuardrailHub,
  logger: applicationLogger,
});
```

The constructor performs no file or network I/O.

### 7.3 Policy convenience factory

`ModelGateway.create()` is asynchronous because it may load and compile a YAML
policy and JSON Schema:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "model-name",
  policyPath: "policies/example-policy.yaml",
  policyWorkingDirectory: process.cwd(),
  logger,
});
```

When `policyPath` is absent, the factory creates a gateway with no guardrails.

When the loaded policy has `enabled: false`, the policy is validated and
compiled, but no guardrail hub is attached. This preserves the current server
behavior.

## 8. Public Types

### 8.1 Construction options

```ts
export interface ModelGatewayOptions {
  provider: ModelProvider;
  defaultModel: string;
  guardrails?: GuardrailHub;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}

export interface ModelGatewayCreateOptions {
  provider: ModelProvider;
  defaultModel: string;
  policyPath?: string;
  policyWorkingDirectory?: string;
  logger?: Logger;
  lifecycleListener?: LifecycleListener;
}
```

`ModelGatewayCreateOptions` deliberately does not accept an already-created
`guardrails` value. Custom hubs use the constructor, while file-backed policy
composition uses `create()`. This prevents ambiguous precedence between a hub
and a policy path.

### 8.2 Request options

```ts
export interface ChatCompletionRequestOptions {
  requestId?: string;
}
```

The completion input reuses the existing provider-neutral `ChatInput`:

```ts
export interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}
```

SDK inputs use camelCase. The HTTP adapter continues accepting the existing
OpenAI-compatible `max_tokens` field.

### 8.3 Result type

The current pipeline result becomes a named public SDK contract:

```ts
export interface GatewayExecutionResult {
  response: ChatResponse;
  providerRequest: ChatRequest;
  context: RequestContext;
  durationMs: number;
  lifecycle: readonly LifecycleEvent[];
}
```

This preserves current diagnostics and avoids creating a second result model.

`providerRequest` is the normalized request used for the first provider call
after input guardrails. It may contain sensitive prompt content and must be
documented as unsafe to log indiscriminately.

The result does not include provider authorization headers or API keys.

### 8.4 Resource types

The public object graph is class-based:

```ts
export class ChatCompletionsResource {
  create(
    input: ChatInput,
    options?: ChatCompletionRequestOptions,
  ): Promise<GatewayExecutionResult>;
}

export class ChatResource {
  readonly completions: ChatCompletionsResource;
}

export class ModelGateway {
  readonly chat: ChatResource;

  constructor(options: ModelGatewayOptions);

  static create(options: ModelGatewayCreateOptions): Promise<ModelGateway>;
}
```

The resource classes remain small and live in the same implementation module.
Creating one file per trivial class would add structure without improving
maintainability.

## 9. ModelGateway Responsibilities

`ModelGateway` is responsible for:

- owning one `GatewayPipeline` instance;
- exposing stable resource objects;
- composing an optional configured policy in `create()`;
- passing dependencies to the pipeline;
- preserving one request ID and lifecycle per execution; and
- remaining safe for concurrent calls.

It is not responsible for:

- starting or stopping an HTTP server;
- reading process environment variables;
- managing provider credentials;
- serializing HTTP request or response objects;
- hot-reloading policies; or
- modifying provider or guardrail results.

## 10. Construction and Initialization

### 10.1 Synchronous constructor

The constructor must:

1. validate that `defaultModel` is non-empty;
2. retain the provided dependency instances;
3. create one `GatewayPipeline`;
4. create the resource objects once; and
5. perform no asynchronous work.

The pipeline remains the source of request-level validation. Constructor
validation only covers invalid object configuration.

### 10.2 Asynchronous factory

The factory must:

1. resolve and load `policyPath` when present;
2. validate and compile the policy exactly once;
3. create `ConfiguredGuardrailHub` only for `enabled: true`;
4. emit the existing sanitized policy-loaded record through the supplied
   logger;
5. call the constructor with the composed dependencies; and
6. reject with `ConfigurationError` if startup policy loading fails.

`policyWorkingDirectory` defaults to `process.cwd()` and is passed to the
existing policy loader. It exists mainly for applications whose process
working directory differs from their policy directory.

## 11. Default Logging Decision

The in-process SDK defaults to `silentLogger`.

Libraries should not write to application stdout or stderr unless explicitly
configured. Consumers opt in with `ConsoleLogger` or provide their own `Logger`.

The existing HTTP executable preserves its current structured console logging
by passing `ConsoleLogger` during runtime construction.

This means:

- SDK default: silent;
- server default: structured console logs; and
- custom application: injected logger.

## 12. Provider Modularity

The public root exports:

- `ModelProvider`;
- `OpenAICompatibleProvider`;
- `OpenAICompatibleProviderOptions`; and
- provider-neutral chat types.

Custom providers implement the existing interface:

```ts
export interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse>;
}
```

No registry or string-based provider lookup is added. Explicit object
construction keeps credentials, retries, and provider-specific options visible
to the consuming application.

The existing OpenAI-compatible request mapping remains unchanged, including
the current `max_tokens` compatibility limitation. Fixing model-specific token
parameter mapping is outside this SDK milestone.

## 13. Guardrail Modularity

The root package exports the `GuardrailHub` interface so applications may inject
custom implementations through the constructor.

The common YAML path uses `ModelGateway.create()` and the existing:

- policy loader;
- configured hub;
- PII evaluator;
- JSON Schema validator; and
- bounded retry behavior.

The SDK must preserve:

- policy `enabled` behavior;
- first-match input rule behavior;
- immutable redaction;
- block precedence;
- strict whole-output JSON parsing;
- every-choice validation;
- output repair construction;
- retry limits;
- usage aggregation; and
- fail-open and fail-closed behavior.

## 14. Error Contract

Direct SDK calls reject with `GatewayError` rather than returning an HTTP error
body.

The root package exports:

- `GatewayError`;
- `GatewayErrorCode`; and
- `ConfigurationError`.

Example:

```ts
try {
  await gateway.chat.completions.create(input);
} catch (error) {
  if (error instanceof GatewayError) {
    console.error(error.code, error.message);
  }
}
```

The existing stable codes remain unchanged:

- `INVALID_REQUEST`;
- `UNSUPPORTED_FEATURE`;
- `MODEL_RATE_LIMITED`;
- `MODEL_TIMEOUT`;
- `MODEL_AUTHENTICATION_FAILED`;
- `INVALID_MODEL_RESPONSE`;
- `MODEL_UPSTREAM_ERROR`;
- `INPUT_GUARDRAIL_BLOCKED`;
- `OUTPUT_GUARDRAIL_FAILED`;
- `GUARDRAIL_EVALUATION_FAILED`; and
- `INTERNAL_ERROR`.

The HTTP adapter continues converting these errors into the existing sanitized
JSON body and status code.

## 15. Lifecycle and Concurrency

Each call to `chat.completions.create()` creates an independent
`RequestContext`, `LifecycleTracker`, retry loop, and result.

The `ModelGateway` instance itself stores only immutable dependencies and
resource objects. It must not keep request-specific mutable state.

One instance may therefore serve concurrent calls safely as long as the
injected provider, guardrail hub, logger, and listener implementations are also
concurrency-safe.

Lifecycle stage names and order remain unchanged. The SDK returns lifecycle
events in the result and may also send them to the optional listener.

## 16. HTTP Server Integration

### 16.1 Runtime composition

`createRuntime()` changes from constructing `GatewayPipeline` directly to
constructing `ModelGateway`:

```text
GatewayConfig
    |
    +--> OpenAICompatibleProvider
    |
    +--> ModelGateway.create(...)
    |
    +--> createApp({ gateway, logger, ... })
    |
    v
Elysia application
```

The runtime return value adds `gateway` for tests and programmatic server use.

### 16.2 HTTP application dependency

`createApp()` accepts the SDK facade or a narrow executor interface instead of
the concrete `GatewayPipeline`:

```ts
interface GatewayExecutor {
  chat: {
    completions: {
      create(
        input: ChatInput,
        options?: ChatCompletionRequestOptions,
      ): Promise<GatewayExecutionResult>;
    };
  };
}
```

Tests may continue injecting a lightweight fake executor without constructing
a real provider.

### 16.3 Preserved HTTP contract

The following behavior must not change:

- `GET /health` response;
- `POST /v1/chat/completions` path;
- request fields and validation;
- `stream: true` rejection;
- snake_case HTTP fields;
- request ID preservation and generation;
- `x-request-id` response header;
- `x-gateway-duration-ms` response header;
- retry-after handling;
- public error shape and statuses;
- debug provider-request gate;
- guardrail lifecycle; and
- provider-call count.

## 17. Side-Effect-Free Imports

The public SDK entry point must not import the executable root `index.ts`.

Importing `@llm-gateway/sdk` must not:

- call `createRuntime()`;
- call `.listen()`;
- access `process.env`;
- load `.env`;
- open files;
- load a policy;
- make a provider request; or
- write a log record.

Only the executable entry point may start the Elysia listener.

The server helpers are exported through a separate `./server` package subpath.

## 18. Runtime Compatibility

### 18.1 Supported runtimes

The SDK core targets:

- Bun 1.3 or later; and
- Node.js 20 or later.

Node 20 provides the required global `fetch`, `Headers`, `Response`, and
`AbortSignal.timeout` APIs.

### 18.2 Remove Bun-only core file access

The policy loader currently reads files through `Bun.file()`. Before publishing
the SDK, core policy loading must use `node:fs/promises.readFile()` instead.

The existing `realpath()` and `stat()` security checks remain. Only the final
file-read mechanism changes.

Bun-specific test APIs and executable startup may remain outside the SDK core.

### 18.3 Unsupported runtimes

Browser, Cloudflare Worker, Deno, and other edge-runtime compatibility are not
part of version 1 because file-backed YAML policies use Node filesystem APIs.

## 19. Public Entry Points

### 19.1 Main SDK entry

Add `src/index.ts` as a side-effect-free public barrel exporting only supported
SDK contracts:

```ts
export { ModelGateway } from "./model-gateway.ts";
export { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.ts";
export { GatewayError } from "./domain/errors.ts";
export { ConfigurationError } from "./config/env.ts";
export { ConsoleLogger, silentLogger } from "./observability/logger.ts";

export type {
  ChatInput,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatRole,
} from "./domain/chat.ts";
export type { GatewayErrorCode } from "./domain/errors.ts";
export type { ModelProvider } from "./providers/model-provider.ts";
export type { Logger } from "./observability/logger.ts";
export type { GuardrailHub } from "./guardrails/types.ts";
```

The final barrel must also export the SDK option, resource, request-option, and
execution-result types.

### 19.2 Server entry

Add `src/server.ts`:

```ts
export { createApp } from "./app.ts";
export { createRuntime } from "./runtime.ts";
export { loadConfig } from "./config/env.ts";
```

Importing this subpath still must not start a listener.

### 19.3 Executable entry

The existing root `index.ts` remains the only entry that calls `.listen()`.
`bun run dev` and `bun run start` continue using it.

## 20. Package Contract

The target `package.json` shape is:

```json
{
  "name": "@llm-gateway/sdk",
  "version": "0.2.0",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server.d.ts",
      "import": "./dist/server.js"
    }
  },
  "files": ["dist", "README.md"]
}
```

The exact package name is provisional. The version changes from `0.1.0` to
`0.2.0` because this adds a public SDK surface without claiming stable `1.0`
compatibility.

The package remains unpublished until the name and registry scope are
confirmed.

## 21. Build and Declaration Output

Add a build-specific TypeScript configuration for declaration generation.

The build must produce:

```text
dist/
|-- index.js
|-- index.js.map
|-- index.d.ts
|-- server.js
|-- server.js.map
`-- server.d.ts
```

The JavaScript build should:

- use ESM format;
- target Node 20-compatible JavaScript;
- externalize declared dependencies instead of embedding Ajv, YAML, and
  Elysia into the SDK artifact;
- include source maps; and
- contain no executable listener side effect.

The declaration build must fail on unresolved or accidentally private types.

## 22. Planned Source Layout

```text
apps/gateway/
|-- index.ts                         # Bun executable; starts listener
|-- package.json
|-- tsconfig.json                    # development and tests
|-- tsconfig.build.json              # declarations
|-- src/
|   |-- index.ts                     # public SDK entry
|   |-- server.ts                    # side-effect-free server exports
|   |-- model-gateway.ts             # facade and resource classes
|   |-- app.ts                       # Elysia adapter over ModelGateway
|   |-- runtime.ts                   # environment-to-server composition
|   |-- config/
|   |-- domain/
|   |-- guardrails/
|   |-- observability/
|   |-- pipeline/
|   |-- providers/
|   `-- transport/
|-- scripts/
|   |-- smoke-client.ts
|   |-- smoke.ts                     # HTTP gateway smoke
|   |-- smoke-guardrails.ts          # HTTP guardrail smoke
|   |-- smoke-sdk.ts                 # direct real-provider SDK smoke
|   |-- test-pipeline.ts
|   `-- test-guardrails.ts
`-- tests/
    |-- model-gateway.test.ts
    |-- sdk-entry.test.ts
    |-- runtime.test.ts
    `-- existing tests
```

The resource classes remain in `model-gateway.ts` unless they grow enough to
justify separate modules.

## 23. SDK Smoke Script

Add `scripts/smoke-sdk.ts` and package command:

```json
{
  "scripts": {
    "smoke:sdk": "bun scripts/smoke-sdk.ts"
  }
}
```

The script must import from the public SDK entry point rather than internal
pipeline modules.

It must:

1. construct `OpenAICompatibleProvider` from the existing environment values;
2. instantiate the gateway through `ModelGateway.create()`;
3. optionally load `GUARDRAIL_POLICY_PATH`;
4. make one direct `chat.completions.create()` call;
5. print the first post-input-guardrail provider request;
6. print the final assistant response;
7. print request ID and duration; and
8. exit non-zero with a concise error on failure.

It must not:

- start an Elysia listener;
- call `GATEWAY_URL`;
- print an API key or authorization header; or
- hide a `GatewayError.code` when reporting failure.

Example shape:

```ts
const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl: config.modelBaseUrl,
    apiKey: config.modelApiKey,
    timeoutMs: config.modelTimeoutMs,
  }),
  defaultModel: config.defaultModel,
  policyPath: config.guardrailPolicyPath,
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Say hello." }],
});
```

## 24. Existing Smoke Scripts

The existing scripts retain separate responsibilities:

| Script                | Boundary verified                                          |
| --------------------- | ---------------------------------------------------------- |
| `smoke.ts`            | Running HTTP server, debug request exposure, provider call |
| `smoke-guardrails.ts` | Running HTTP server plus configured input/output policy    |
| `smoke-sdk.ts`        | Direct class construction and in-process SDK execution     |

The HTTP smoke scripts may reuse exported SDK request or error types, but they
must continue using HTTP. Replacing them with SDK calls would remove server
end-to-end coverage.

## 25. Automated Test Plan

### 25.1 ModelGateway construction

Cover:

- constructor with an injected fake provider;
- constructor with a custom guardrail hub;
- default silent logger;
- explicit logger and lifecycle listener;
- empty default-model rejection;
- resource objects created once; and
- constructor performs no file or network I/O.

### 25.2 Factory behavior

Cover:

- no policy path;
- enabled policy path;
- disabled policy path;
- relative path with explicit working directory;
- invalid policy rejection;
- policy compiled only once;
- sanitized policy-loaded log; and
- no guardrail hub for `enabled: false`.

### 25.3 Direct completion behavior

Cover:

- default model resolution;
- explicit model override;
- request ID preservation and generation;
- exactly one provider call without retry;
- redacted provider request in the result;
- input block before provider call;
- output retry and usage aggregation;
- provider errors remain `GatewayError` instances;
- lifecycle result equivalence with direct pipeline execution; and
- two concurrent calls do not share request state.

### 25.4 HTTP compatibility

Run all existing HTTP and pipeline tests unchanged in behavior.

Add assertions that:

- the HTTP app calls the SDK executor;
- HTTP response serialization remains snake_case;
- SDK response data remains provider-neutral camelCase;
- debug output still uses `providerRequest`;
- statuses and public errors remain unchanged; and
- health checks do not invoke the SDK.

### 25.5 Entry-point safety

Import the built main SDK entry in a fresh process and assert:

- the process exits without hanging;
- no port is opened;
- no log is written;
- no environment variable is required; and
- no policy or provider call occurs.

Perform the same side-effect check for `./server`.

### 25.6 Package consumer fixture

Create a temporary consumer project during verification that:

1. installs or links the packed SDK artifact;
2. imports only from documented entry points;
3. implements a fake `ModelProvider`;
4. constructs `ModelGateway`;
5. completes a deterministic request;
6. type-checks against generated declarations; and
7. runs under both Bun and Node 20 where available.

No consumer verification may call a real provider.

## 26. Documentation Plan

Update `README.md` with distinct sections:

1. SDK installation;
2. direct SDK quickstart;
3. SDK with YAML guardrails;
4. custom provider example;
5. custom logger and lifecycle listener;
6. result and error handling;
7. HTTP server setup;
8. difference between SDK and HTTP smoke tests;
9. runtime compatibility; and
10. current limitations.

The quickstart must use only public package imports.

The documentation must warn that `providerRequest` may contain prompt content
and should not be logged in production without an explicit privacy decision.

## 27. Security and Privacy Requirements

- SDK construction must never log credentials.
- Provider options must never appear in results.
- Importing the package must not read `.env`.
- Public errors remain sanitized.
- Policy loading retains path-containment and file-size checks.
- `providerRequest` contains no authorization data.
- The SDK does not persist prompts, responses, findings, or lifecycle events.
- The default logger is silent.
- Package contents must exclude `.env`, test fixtures containing secrets, and
  local build caches.
- The package consumer test must use synthetic data and a fake provider.

## 28. Performance Requirements

The facade must add negligible overhead:

- resource objects are created once per gateway instance;
- policy and schema compilation occurs once during `create()`;
- the pipeline is reused across requests;
- request-specific state remains local to each execution;
- the facade does not serialize requests to JSON for in-process calls; and
- the SDK does not add another retry layer around provider calls.

The HTTP adapter remains the only layer performing HTTP field mapping and JSON
serialization.

## 29. Implementation Sequence

### Phase 1: Public result and option types

1. Rename or export the current pipeline result as
   `GatewayExecutionResult`.
2. Export request options currently used by `GatewayPipeline.execute()`.
3. Confirm no public type references an unexported private declaration.
4. Add declaration-oriented type tests.

### Phase 2: Class facade

1. Implement `ModelGateway`.
2. Implement the chat and completion resource objects.
3. Add the synchronous dependency-injection constructor.
4. Add the asynchronous policy-backed factory.
5. Preserve default silent SDK logging.
6. Add direct class tests with fake providers.

### Phase 3: Server integration

1. Change `createRuntime()` to construct `ModelGateway`.
2. Change `createApp()` to depend on the SDK executor interface.
3. Preserve all HTTP transformations and debug behavior.
4. Run the complete existing test suite before packaging work.

### Phase 4: Runtime portability

1. Replace `Bun.file()` in the policy loader with Node filesystem APIs.
2. Verify Bun behavior remains unchanged.
3. Add a Node 20 fake-provider SDK test.

### Phase 5: Public entry points and package output

1. Add side-effect-free `src/index.ts`.
2. Add side-effect-free `src/server.ts`.
3. Add `tsconfig.build.json`.
4. Configure ESM build output and declarations.
5. Configure package exports and packed files.
6. Verify an external consumer fixture.

### Phase 6: Scripts and documentation

1. Add `scripts/smoke-sdk.ts`.
2. Retain both HTTP smoke scripts.
3. Update README usage and runtime support.
4. Update the as-built spec after implementation.

## 30. File Change Plan

### New files

- `src/model-gateway.ts`
- `src/index.ts`
- `src/server.ts`
- `scripts/smoke-sdk.ts`
- `tests/model-gateway.test.ts`
- `tests/sdk-entry.test.ts`
- `tsconfig.build.json`

### Modified files

- `src/pipeline/gateway-pipeline.ts`
- `src/app.ts`
- `src/runtime.ts`
- `src/config/env.ts`
- `src/guardrails/config/policy-loader.ts`
- `src/providers/openai-compatible-provider.ts`
- `package.json`
- `README.md`
- existing runtime and HTTP tests
- existing smoke scripts only where shared public types are useful

### Files that remain executable-only

- root `index.ts`

No existing policy or schema file needs a contract change.

## 31. Backward-Compatibility Checklist

Before accepting the SDK refactor, compare the pre- and post-refactor server for
the same deterministic inputs:

- identical successful HTTP response body;
- identical health response;
- identical response headers;
- identical public error body and status;
- identical provider request body;
- identical guardrail input transformation;
- identical repair request message ordering;
- identical provider attempt count;
- identical usage aggregation;
- identical lifecycle stages and metadata;
- identical policy enable/disable behavior; and
- identical debug provider-request behavior.

Any difference requires either a fix or an explicit separate specification.

## 32. Verification Commands

The completed milestone must pass:

```bash
bun test
bun run test:pipeline
bun run test:guardrails
bun run check-types
bun run build
bun run check:package
prettier --check apps/gateway
git diff --check
```

The package check should include declaration generation, packed-file
inspection, side-effect-free imports, and the external fake-provider consumer.

The real-provider commands are manual verification steps:

```bash
bun run smoke
bun run smoke:guardrails
bun run smoke:sdk
```

## 33. Acceptance Criteria

The SDK milestone is complete when:

1. A user can construct `ModelGateway` with a custom provider.
2. A user can create a policy-backed gateway through `ModelGateway.create()`.
3. A user can call `gateway.chat.completions.create()` with typed input.
4. The result exposes response, post-input provider request, context, duration,
   and lifecycle.
5. Direct SDK use requires no HTTP listener.
6. Importing the SDK or server helper entry has no side effects.
7. The existing HTTP server uses the same `ModelGateway` execution path.
8. All existing HTTP, pipeline, provider, policy, and guardrail tests pass.
9. Existing HTTP requests and responses remain compatible.
10. Enabled and disabled YAML policies behave exactly as before.
11. Custom providers and guardrail hubs remain injectable.
12. Direct SDK errors retain stable `GatewayError` codes.
13. SDK default logging is silent and server default logging is unchanged.
14. A direct SDK smoke script instantiates the class and reaches a real
    provider when configured.
15. A deterministic external consumer type-checks and runs using only public
    exports.
16. ESM JavaScript and TypeScript declarations are generated.
17. Core SDK use works under Bun 1.3+ and Node 20+.
18. The package contains no `.env`, credentials, test fixtures, or source-only
    executable side effects.
19. Full verification, formatting, and diff checks pass.
20. No package is published without a separate explicit release action.

## 34. Deferred SDK Extensions

Future SDK milestones may add:

- a remote HTTP client;
- streaming and async iterators;
- tool-call and multimodal request types;
- provider and guardrail plugin registries;
- policy hot reload;
- browser-safe and edge-runtime entry points;
- framework adapters for Express, Fastify, Hono, or serverless platforms;
- telemetry hooks and OpenTelemetry integration;
- generated API documentation;
- semantic-version compatibility tooling; and
- registry publication automation.

These additions must build on the `ModelGateway` facade and must not bypass the
pipeline or silently change the version 1 policy contract.

## 35. Implementation Status

Implemented on 2026-08-06.

The delivered milestone includes:

- the synchronous `ModelGateway` constructor and asynchronous YAML-backed
  `ModelGateway.create()` factory;
- the canonical `gateway.chat.completions.create()` resource API;
- side-effect-free SDK and server helper entry points;
- a shared SDK execution path used by the retained Elysia adapter;
- Node-compatible policy file loading;
- public SDK types, stable SDK errors, silent default logging, and injectable
  providers, guardrails, loggers, and lifecycle listeners;
- direct SDK, HTTP compatibility, factory, concurrency, entry-point, and package
  consumer coverage;
- `smoke:sdk` for direct real-provider verification; and
- package declarations plus deterministic external Bun and Node consumer
  checks.

One build detail differs from the preliminary plan: TypeScript performs the ESM
JavaScript, source-map, and declaration emit directly instead of Bun bundling
the two entry points. This avoids an invalid re-export bundle produced by the
repository's Bun version and naturally leaves package dependencies external.
Only `.` and `./server` are public package exports even though their internal
runtime modules are emitted into `dist`.

The package name remains provisional and the package remains private and
unpublished. The HTTP implementation is intentionally retained for this
milestone and may be removed in the separately planned cleanup.
