# Model Gateway v1.2: As-Built In-Process SDK

## 1. Document Purpose

This document records what was actually implemented from the SDK architecture
specified in `05_sdk_implement.md`.

It is an as-built specification, not a future implementation plan. It describes
the class-based SDK surface, construction modes, request and result contracts,
YAML policy composition, provider and guardrail extension points, retained HTTP
compatibility adapter, package entry points, build output, smoke workflow,
automated verification, and current limitations.

The primary result of this milestone is that an application can now instantiate
and invoke the model gateway directly inside its own process:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});
```

No HTTP listener is required for this path.

The existing Elysia server was intentionally retained for this milestone. It is
now a compatibility adapter over the same `ModelGateway` execution path rather
than a separate gateway implementation. Removing the HTTP layer is a later,
separately scoped cleanup.

## 2. Versioning and Publication Status

The SDK milestone uses the following package identity:

```json
{
  "name": "@llm-gateway/sdk",
  "version": "0.2.0",
  "private": true
}
```

The `v1.2` name in this document identifies the project milestone. The package
uses semantic version `0.2.0` because it now has a reusable public SDK surface
but is not claiming a stable `1.0.0` package contract.

The package name remains provisional. The package is private and has not been
published to npm or another registry.

The retained HTTP health endpoint still defaults to version `0.1.0`. This was
left unchanged to preserve the existing HTTP response contract:

```json
{
  "status": "ok",
  "service": "llm-gateway",
  "version": "0.1.0"
}
```

The YAML guardrail policy version remains independently identified as
`guardrails/v1`.

## 3. Implementation Summary

| Capability                                      | Status          | Main implementation                      |
| ----------------------------------------------- | --------------- | ---------------------------------------- |
| In-process `ModelGateway` class                 | Implemented     | `src/model-gateway.ts`                   |
| Class-based chat resource API                   | Implemented     | `src/model-gateway.ts`                   |
| Synchronous dependency-injection constructor    | Implemented     | `src/model-gateway.ts`                   |
| Asynchronous YAML-backed factory                | Implemented     | `src/model-gateway.ts`                   |
| Optional no-policy SDK construction             | Implemented     | `ModelGateway.create()`                  |
| Enabled and disabled YAML behavior              | Implemented     | Factory and existing policy loader       |
| Custom provider injection                       | Implemented     | `ModelProvider`                          |
| Custom guardrail-hub injection                  | Implemented     | `GuardrailHub`                           |
| Custom logger injection                         | Implemented     | `Logger`                                 |
| Lifecycle-listener injection                    | Implemented     | `LifecycleListener`                      |
| Silent default SDK logging                      | Implemented     | `silentLogger`                           |
| Public request, result, and lifecycle types     | Implemented     | `src/index.ts`                           |
| Public stable SDK errors                        | Implemented     | `src/index.ts` and existing error domain |
| Post-input provider request in SDK result       | Implemented     | `GatewayExecutionResult`                 |
| Side-effect-free main SDK entry                 | Implemented     | `src/index.ts`                           |
| Side-effect-free server helper entry            | Implemented     | `src/server.ts`                          |
| Shared SDK and HTTP execution path              | Implemented     | `src/app.ts` and `src/runtime.ts`        |
| Node-compatible policy file reads               | Implemented     | `guardrails/config/policy-loader.ts`     |
| ESM JavaScript output                           | Implemented     | `tsconfig.build.json`                    |
| TypeScript declaration output                   | Implemented     | `tsconfig.build.json`                    |
| Source-map output                               | Implemented     | `tsconfig.build.json`                    |
| Package export map                              | Implemented     | `package.json`                           |
| Direct real-provider SDK smoke                  | Implemented     | `scripts/smoke-sdk.ts`                   |
| External declaration consumer check             | Implemented     | `scripts/check-package.ts`               |
| Side-effect import checks                       | Implemented     | `scripts/check-package.ts`               |
| Deterministic Bun package consumer              | Implemented     | `scripts/check-package.ts`               |
| Deterministic Node package consumer             | Implemented     | `scripts/check-package.ts`               |
| SDK construction and concurrency tests          | Implemented     | `tests/model-gateway.test.ts`            |
| Public entry-point test                         | Implemented     | `tests/sdk-entry.test.ts`                |
| Registry publication                            | Not implemented | Explicitly outside this milestone        |
| Remote HTTP client SDK                          | Not implemented | Deferred                                 |
| HTTP implementation removal                     | Not implemented | Intentionally retained for later cleanup |
| Streaming, tools, and multimodal SDK operations | Not implemented | Existing gateway limitation remains      |

## 4. As-Built Architecture

### 4.1 Direct SDK path

The direct SDK is a facade over the existing gateway pipeline:

```text
Consuming application
        |
        v
ModelGateway
        |
        v
ChatResource
        |
        v
ChatCompletionsResource.create()
        |
        v
GatewayPipeline.execute()
   |                    |
   v                    v
GuardrailHub        ModelProvider
```

`ModelGateway` does not reimplement request normalization, guardrails, retries,
usage aggregation, lifecycle tracking, provider calls, or error normalization.
It owns and reuses one `GatewayPipeline` instance.

### 4.2 Retained HTTP path

The HTTP adapter uses the same facade:

```text
HTTP request
    |
    v
Elysia request validation and field mapping
    |
    v
gateway.chat.completions.create()
    |
    v
GatewayPipeline
    |
    v
Guardrails and provider
```

There is no longer a direct `GatewayPipeline` dependency in `createApp()`.
The HTTP application accepts a narrow `GatewayExecutor` interface that matches
the SDK resource shape.

### 4.3 Executable path

The root `index.ts` remains the only entry point that starts a listener:

```text
root index.ts
    |
    v
createRuntime()
    |
    +--> OpenAICompatibleProvider
    +--> composeModelGateway()
    +--> createApp()
    |
    v
app.listen()
```

Importing either public package entry point does not import or execute this root
listener file.

## 5. Current SDK-Oriented Source Layout

```text
apps/gateway/
|-- index.ts                         # executable HTTP listener
|-- package.json
|-- tsconfig.json
|-- tsconfig.build.json              # ESM, source maps, declarations
|-- README.md
|-- policies/
|   |-- example-policy.yaml
|   `-- schemas/
|       `-- gateway-check-response.json
|-- scripts/
|   |-- check-package.ts             # external package consumer checks
|   |-- smoke-sdk.ts                 # direct real-provider SDK smoke
|   |-- smoke.ts                     # retained HTTP smoke
|   |-- smoke-guardrails.ts          # retained HTTP guardrail smoke
|   |-- smoke-client.ts
|   |-- test-pipeline.ts
|   `-- test-guardrails.ts
|-- src/
|   |-- index.ts                     # public SDK entry
|   |-- server.ts                    # public server-helper entry
|   |-- model-gateway.ts             # SDK facade and resources
|   |-- app.ts                       # retained Elysia adapter
|   |-- runtime.ts                   # retained environment composition
|   |-- config/
|   |-- domain/
|   |-- guardrails/
|   |-- observability/
|   |-- pipeline/
|   |-- providers/
|   `-- transport/
`-- tests/
    |-- model-gateway.test.ts
    |-- sdk-entry.test.ts
    |-- existing pipeline, guardrail, provider, policy, and HTTP tests
    |-- fixtures/
    |   |-- disabled-policy.yaml
    |   `-- sdk-enabled-policy.yaml
    `-- helpers/
```

The resource classes remain together in `model-gateway.ts`. No one-function or
one-property modules were introduced for `ChatResource` and
`ChatCompletionsResource`.

## 6. Public `ModelGateway` API

### 6.1 Construction option types

The public SDK exports these two distinct option contracts:

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

The synchronous constructor accepts an already-created `GuardrailHub`.

The asynchronous factory accepts a `policyPath` instead. It does not accept both
a custom hub and a policy path, so there is no ambiguous guardrail precedence.

### 6.2 Synchronous constructor

Applications use the constructor when all dependencies are already available:

```ts
const gateway = new ModelGateway({
  provider: customProvider,
  defaultModel: "custom-model",
  guardrails: customGuardrailHub,
  logger: applicationLogger,
  lifecycleListener: applicationListener,
});
```

The constructor:

1. verifies that `defaultModel` is a non-empty string;
2. trims leading and trailing whitespace from `defaultModel`;
3. defaults the logger to `silentLogger`;
4. creates one `GatewayPipeline`;
5. creates one `ChatResource`;
6. creates one `ChatCompletionsResource`; and
7. performs no file or network I/O.

An empty or whitespace-only default model throws `ConfigurationError` during
construction.

The `chat` and `chat.completions` resource objects are stable for the lifetime
of the gateway. They are not recreated for each request.

### 6.3 Asynchronous factory

Applications use the factory for a file-backed YAML policy:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "gpt-4.1-mini",
  policyPath: "policies/example-policy.yaml",
  policyWorkingDirectory: process.cwd(),
  logger,
});
```

The factory delegates composition to the internal `composeModelGateway()`
helper. That helper is available to the server runtime module but is not
exported from the public package entry point.

When `policyPath` is present, composition:

1. resolves and reads the policy;
2. strictly validates the YAML contract;
3. loads and compiles any referenced JSON Schema;
4. creates `ConfiguredGuardrailHub` only when `enabled: true`;
5. emits one sanitized policy-loaded record through the supplied logger; and
6. constructs `ModelGateway` with the resulting dependencies.

When `policyPath` is absent:

- no policy file is accessed;
- no guardrail hub is attached; and
- requests use the original provider-only lifecycle.

When a valid policy has `enabled: false`:

- the policy and schema are still read, validated, and compiled;
- one sanitized policy-loaded record is emitted when a logger is supplied;
- no guardrail hub is attached; and
- prompts reach the provider unchanged by guardrails.

`policyWorkingDirectory` is forwarded to the existing policy loader. When it is
omitted, the loader uses `process.cwd()`.

Policy load and compile failures reject with `ConfigurationError`.

## 7. Resource Object Model

The public operation is deliberately singular:

```ts
gateway.chat.completions.create(input, options);
```

The implementation did not add redundant aliases such as:

- `gateway.complete()`;
- `gateway.chat()`;
- `gateway.run()`; or
- `gateway.execute()`.

The class graph is:

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
}
```

`ChatCompletionsResource.create()` is a thin delegation to
`GatewayPipeline.execute()`. It adds no second validation, retry, serialization,
or logging layer.

## 8. SDK Request Contract

### 8.1 Chat input

The direct SDK accepts the provider-neutral `ChatInput` contract:

```ts
interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}
```

SDK field names use camel case. In particular, the direct SDK uses `maxTokens`.
The retained HTTP adapter continues accepting and returning OpenAI-compatible
snake-case fields such as `max_tokens` and `finish_reason`.

The supported message roles remain:

- `system`;
- `user`; and
- `assistant`.

The existing pipeline validation remains authoritative:

- `messages` must be a non-empty array;
- each message must use a supported role;
- each message must contain non-empty string content;
- an explicit model must not be empty;
- temperature must be finite and between `0` and `2`;
- `maxTokens` must be a positive integer; and
- `stream: true` is rejected as unsupported.

Input objects and message arrays are normalized into new request objects. The
pipeline does not mutate the caller's input.

### 8.2 Per-request options

The request option contract is:

```ts
interface ChatCompletionRequestOptions {
  requestId?: string;
}
```

A valid supplied request ID is preserved. If it is absent or does not satisfy
the existing request-ID pattern, the gateway generates a UUID.

Request options do not currently include per-call providers, policies, timeout
overrides, loggers, or retry settings.

## 9. SDK Result Contract

The pipeline result is now a named public SDK contract:

```ts
interface GatewayExecutionResult {
  response: ChatResponse;
  providerRequest: ChatRequest;
  context: RequestContext;
  durationMs: number;
  lifecycle: readonly LifecycleEvent[];
}
```

### 9.1 `response`

`response` is the provider-neutral, camel-case `ChatResponse` returned after
output policy enforcement and any bounded repair attempts.

When multiple attempts contain usage data, usage is aggregated across attempts.
If any attempt omits usage, the final SDK response omits aggregated usage rather
than returning an incomplete total.

### 9.2 `providerRequest`

`providerRequest` is the normalized request sent to the first provider call
after input guardrails.

It allows a direct SDK consumer to observe whether input guardrails allowed,
redacted, or otherwise transformed the prompt before provider access. It does
not contain provider credentials, authorization headers, base URLs, or timeout
configuration.

For an output repair retry, `providerRequest` remains the original first
provider request. Repair prompts used by later attempts are not substituted into
this field.

`providerRequest` can contain prompt content and therefore may contain sensitive
data when no redaction rule applies. The implementation and README explicitly
warn consumers not to log it indiscriminately in production.

### 9.3 `context`

`context` contains:

- the resolved request ID;
- the request start timestamp; and
- the resolved model.

The context does not contain credentials or complete prompts.

### 9.4 `durationMs`

`durationMs` is a non-negative elapsed duration measured from request-context
creation until the successful result is created.

### 9.5 `lifecycle`

`lifecycle` exposes the complete ordered request lifecycle captured by the
existing `LifecycleTracker`.

A no-policy successful request normally returns:

```text
received
validated
provider_started
provider_completed
completed
```

Policy-backed calls add input and output guardrail stages and may add
`retry_started` plus another provider attempt.

## 10. Provider Modularity

The public SDK exports `ModelProvider`:

```ts
interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse>;
}
```

Consumers may inject any object that implements this interface. There is no
provider registry, global provider singleton, string-based lookup, decorator,
or dependency-injection container.

The existing `OpenAICompatibleProvider` remains included and is exported from
the SDK entry point together with:

- `OpenAICompatibleProviderOptions`; and
- `FetchImplementation`.

The provider continues to own:

- base URL and `/chat/completions` endpoint construction;
- optional bearer authorization;
- timeout signaling;
- OpenAI-compatible request serialization;
- provider response validation; and
- provider-specific error mapping.

Provider credentials are not stored in the gateway result.

## 11. Guardrail Modularity

The public SDK exports the `GuardrailHub` interface and its supporting result
types. A consumer may inject a custom hub through the synchronous constructor.

The public guardrail-related types are:

- `GuardrailHub`;
- `InputGuardrailResult`;
- `OutputGuardrailResult`;
- `PolicyIdentity`; and
- `RuntimeFailureMode`.

The file-backed convenience path uses the existing configured implementation.
No guardrail registry or automatic plugin discovery was introduced.

The SDK preserves all v1.1 guardrail semantics:

- deterministic PII detection;
- ordered first-match input rules;
- allow, immutable redact, and block decisions;
- block precedence;
- strict whole-output JSON parsing;
- every-choice JSON Schema validation;
- bounded repair requests;
- retry-bound enforcement;
- multi-attempt usage aggregation; and
- configured fail-open or fail-closed evaluator behavior.

## 12. Error Contract

Direct SDK calls reject with error objects. They do not return HTTP error bodies.

The main package exports:

- `GatewayError`;
- `GatewayErrorCode`; and
- `ConfigurationError`.

Example handling:

```ts
try {
  await gateway.chat.completions.create(input);
} catch (error) {
  if (error instanceof GatewayError) {
    console.error(error.code, error.message);
  }
}
```

The existing stable gateway codes remain unchanged:

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

Known gateway and provider errors remain `GatewayError` instances. Unexpected
errors are normalized to a sanitized `INTERNAL_ERROR` without exposing the
original private message.

The retained HTTP adapter continues translating these errors to the existing
status codes, sanitized response bodies, headers, and retry-after behavior.

## 13. Logging Behavior

### 13.1 SDK default

The SDK constructor and factory default to `silentLogger`.

Therefore, direct SDK usage does not write lifecycle records, policy records, or
errors to application stdout or stderr unless the consumer explicitly injects a
logger.

### 13.2 Opt-in logging

Consumers may inject:

- the included `ConsoleLogger`; or
- any custom object implementing `Logger`.

The public SDK also exports the `Logger` and `LogRecord` types.

### 13.3 Retained server default

`createRuntime()` continues defaulting to `ConsoleLogger`. This preserves the
current server's structured operational logging.

### 13.4 Policy-loaded record

When a YAML policy is loaded, the factory logs only:

- `event: gateway.guardrail_policy_loaded`;
- policy name;
- policy version;
- enabled status;
- input-rule count; and
- output-rule count.

The record does not include prompt content, detected values, policy file paths,
schema contents, or credentials.

## 14. Lifecycle and Concurrency

Each call to `chat.completions.create()` creates its own:

- request ID resolution;
- `RequestContext`;
- `LifecycleTracker`;
- lifecycle event array;
- provider response accumulator; and
- retry attempt counter.

`ModelGateway` stores the reusable resource objects and pipeline dependencies,
but it stores no request-specific mutable state.

The implementation test suite runs two calls concurrently and verifies that:

- each result preserves its own supplied request ID; and
- every lifecycle event in each result contains the matching request ID.

One gateway instance can therefore coordinate concurrent calls as long as the
injected provider, guardrail hub, logger, and lifecycle listener are themselves
safe for concurrent use.

The SDK does not serialize calls through a queue and does not add a concurrency
limit.

## 15. Side-Effect-Free Public Imports

### 15.1 Main entry

`src/index.ts` is the public SDK barrel. Importing it does not:

- read environment variables;
- load `.env` explicitly;
- read a YAML policy;
- call a provider;
- create a runtime;
- open a port;
- start Elysia; or
- emit a log record.

### 15.2 Server helper entry

`src/server.ts` exports server construction helpers but does not start them:

```ts
export { createApp } from "./app.ts";
export { ConfigurationError, loadConfig } from "./config/env.ts";
export { createRuntime } from "./runtime.ts";
```

Importing the server helper entry is also side-effect-free. Environment access
happens only when `loadConfig()` or the default `createRuntime()` path is called.

### 15.3 Executable entry

The root `index.ts` remains executable-only. It calls `createRuntime()`, starts
the listener, and emits the `gateway.started` record.

It is not imported by either package entry point.

## 16. Public Package Exports

The package exposes two supported import paths:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./server": {
      "types": "./dist/server.d.ts",
      "import": "./dist/server.js"
    }
  }
}
```

### 16.1 Main SDK values

The main entry exports these runtime values:

- `ModelGateway`;
- `ChatResource`;
- `ChatCompletionsResource`;
- `OpenAICompatibleProvider`;
- `GatewayError`;
- `ConfigurationError`;
- `ConsoleLogger`; and
- `silentLogger`.

### 16.2 Main SDK types

The main entry exports the supported public type families:

- chat input, message, request, response, and role types;
- request context;
- gateway error codes;
- model provider and provider options;
- guardrail hub and decision types;
- logger and log-record types;
- lifecycle stage, decision, event, metadata, and listener types;
- model gateway constructor and factory options;
- per-request completion options; and
- `GatewayExecutionResult`.

### 16.3 Server subpath

The `./server` entry exports:

- `createApp`;
- `createRuntime`;
- `loadConfig`;
- `ConfigurationError`;
- `AppDependencies`;
- `GatewayExecutor`; and
- `GatewayConfig`.

Internal emitted files are not supported package subpaths because the package
export map does not expose them.

## 17. Runtime Portability Change

The guardrail policy loader previously used:

```ts
Bun.file(path).text();
```

It now uses:

```ts
readFile(path, "utf8");
```

from `node:fs/promises`.

The existing `realpath()`, `stat()`, regular-file check, one-mebibyte limit,
schema containment check, and error sanitization remain in place.

This removes the Bun-only file-read dependency from the SDK core. Bun supports
the Node filesystem API, while Node can now execute the same policy-loading
path.

The SDK build targets ES2022 and is intended for:

- Bun 1.3 or later; and
- Node.js 20 or later.

The completed package verification ran under Bun `1.3.14` and the environment's
installed Node `26.1.0`. The build target is compatible with Node 20 APIs, but a
Node 20 binary was not separately available in the verification environment.

Browser, edge-worker, and Deno support were not added because YAML policy
loading depends on filesystem APIs.

## 18. Retained HTTP Compatibility Adapter

### 18.1 Narrow executor dependency

`createApp()` now receives:

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

This removes the Elysia adapter's dependency on the concrete
`GatewayPipeline` class.

### 18.2 HTTP-to-SDK field mapping

The HTTP adapter maps:

- `max_tokens` to SDK `maxTokens`;
- the HTTP request ID header to `ChatCompletionRequestOptions.requestId`; and
- the SDK's camel-case response back to the existing OpenAI-compatible public
  response.

### 18.3 Preserved HTTP behavior

The following existing behavior remains covered and unchanged:

- `GET /health`;
- `POST /v1/chat/completions`;
- request-body validation;
- malformed JSON handling;
- unknown field rejection;
- explicit streaming rejection;
- snake-case HTTP request and response fields;
- `x-request-id` behavior;
- `x-gateway-duration-ms` behavior;
- public error shape and statuses;
- retry-after propagation;
- provider-request debug gate;
- guardrail lifecycle behavior; and
- provider-call counts.

### 18.4 Runtime composition

`createRuntime()` now:

1. creates `OpenAICompatibleProvider` from `GatewayConfig`;
2. composes `ModelGateway` and any file-backed policy;
3. passes the gateway to `createApp()`; and
4. returns `gateway` along with the existing runtime data.

The return value is:

```ts
{
  app,
  config,
  gateway,
  guardrails,
  logger,
  policy,
}
```

Returning `guardrails` and `policy` preserves the existing enabled, disabled,
and unconfigured runtime inspection used by tests.

## 19. Package and Build Contract

### 19.1 Package metadata

The package declares:

```json
{
  "type": "module",
  "sideEffects": false,
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist", "README.md"]
}
```

Only built output and the README are intended package contents. Tests, local
fixtures, `.env`, source-only scripts, and specifications are outside the
declared publishable file list.

The workspace lockfile now recognizes the package as
`@llm-gateway/sdk@workspace:apps/gateway`.

TypeScript is not declared as a runtime or peer dependency. Consumers use the
generated JavaScript at runtime and the declaration files only when their own
tooling performs type checking.

### 19.2 Build configuration

`tsconfig.build.json` extends the development configuration and enables:

- `target: ES2022`;
- `module: ESNext`;
- bundler-compatible module resolution;
- JavaScript emit;
- declaration emit;
- source maps;
- `.ts` to `.js` relative import rewriting;
- `src` as the root directory; and
- `dist` as the output directory.

The build command is:

```bash
bun run build
```

which executes:

```bash
bun x tsc --project tsconfig.build.json
```

### 19.3 Build output

The build emits:

- `dist/index.js` and `dist/index.d.ts`;
- `dist/server.js` and `dist/server.d.ts`;
- source maps;
- JavaScript for the internal runtime module graph; and
- declarations for the internal type graph referenced by the public entries.

Only `.` and `./server` are public through the export map even though supporting
modules exist inside `dist`.

Dependencies such as YAML, Ajv, and Elysia remain external package dependencies.
They are not embedded into one bundle.

## 20. Direct SDK Smoke Script

The new command is:

```bash
bun run smoke:sdk
```

It runs `scripts/smoke-sdk.ts` directly and does not start Elysia or call a
gateway URL.

The script:

1. explicitly calls the existing `loadConfig()` helper;
2. constructs `OpenAICompatibleProvider` from the model environment values;
3. calls `ModelGateway.create()`;
4. passes the optional `GUARDRAIL_POLICY_PATH` into the SDK factory;
5. submits one synthetic email prompt;
6. supplies the stable request ID `sdk-e2e-smoke`;
7. prints the first provider request after input guardrails;
8. prints the final assistant response;
9. prints request ID and duration; and
10. exits non-zero with a concise error on failure.

The synthetic prompt asks for JSON compatible with the checked-in example
output policy:

```text
Return only JSON with status "ok", a short message, and contact exactly as
provided: smoke.sdk@gmail.com
```

With the example policy loaded and `enabled: true`, the printed provider request
contains `<EMAIL>`.

With no policy path, or with a loaded policy using `enabled: false`, the printed
provider request contains `smoke.sdk@gmail.com` unchanged.

The error path preserves `GatewayError.code` in the console output. The script
does not print an API key or authorization header.

The real-provider smoke requires user-supplied model configuration and was not
run automatically during implementation verification.

## 21. Existing Smoke Scripts

The existing HTTP scripts remain because the HTTP compatibility adapter remains
in this milestone:

| Script                | Current boundary verified                                 |
| --------------------- | --------------------------------------------------------- |
| `smoke.ts`            | Running HTTP server and debug provider-request response   |
| `smoke-guardrails.ts` | Running HTTP server with input and output guardrails      |
| `smoke-sdk.ts`        | Direct in-process class API with no gateway HTTP listener |

The direct SDK smoke does not use `GATEWAY_URL` or `smoke-client.ts`.

## 22. Package Consumer Verification

The new package check command is:

```bash
bun run check:package
```

It first builds the package and then runs `scripts/check-package.ts`.

The checker creates a temporary external consumer directory and:

1. verifies that `index.js`, `index.d.ts`, `server.js`, and `server.d.ts` exist;
2. links the gateway package under
   `node_modules/@llm-gateway/sdk` in the temporary consumer;
3. creates an external TypeScript consumer using only documented package
   imports;
4. implements a deterministic fake `ModelProvider`;
5. type-checks the consumer against the generated declarations;
6. imports both public entries under Bun and asserts that the imports write no
   output;
7. imports both public entries under Node and asserts that the process exits;
8. executes a deterministic completion under Bun;
9. executes the same deterministic completion under Node;
10. verifies both consumers receive `package works`; and
11. removes the temporary consumer in a `finally` block.

No real provider or network request is used by this check.

The checker validates a linked built package. It does not create or publish a
registry tarball.

## 23. Automated SDK Test Coverage

### 23.1 `model-gateway.test.ts`

The dedicated SDK tests cover:

- synchronous construction with an injected fake provider;
- stable `chat` and `chat.completions` resource identity;
- default model whitespace normalization;
- direct completion and result access;
- supplied request ID preservation;
- empty default-model rejection;
- custom guardrail-hub injection;
- observable input redaction through `providerRequest`;
- asynchronous construction without a policy;
- absence of guardrail lifecycle stages without a policy;
- enabled relative YAML policy loading;
- policy reuse across multiple requests;
- exactly one sanitized policy-loaded record;
- disabled YAML policy validation without enforcement;
- invalid policy rejection as `ConfigurationError`; and
- concurrent request-context and lifecycle isolation.

### 23.2 `sdk-entry.test.ts`

The entry-point test verifies that:

- the SDK exports `ModelGateway`;
- the SDK exports `OpenAICompatibleProvider`;
- the SDK exports `GatewayError`;
- the server entry exports `createApp`;
- the server entry exports `createRuntime`; and
- a gateway imported from the public SDK entry completes a deterministic call.

### 23.3 Updated HTTP tests

The HTTP application and guardrail application tests now construct
`ModelGateway` and pass it to `createApp()`.

They continue covering:

- health checks without provider calls;
- valid HTTP completion mapping;
- debug-provider-request gating;
- validation and parse failures;
- streaming rejection;
- provider timeout mapping;
- unexpected error sanitization;
- input guardrail block responses;
- output guardrail failure responses; and
- redacted provider-request debug output.

### 23.4 Updated runtime tests

Runtime tests verify that:

- the returned runtime exposes `gateway.chat.completions.create`;
- no-policy runtime construction attaches no policy or hub;
- enabled policy construction returns the policy and guardrail hub; and
- disabled policy construction returns the validated policy without a hub.

### 23.5 Existing regression coverage

The existing pipeline, provider, policy-loader, PII detector, guardrail hub,
guardrail pipeline, environment, and HTTP tests remain active.

The implementation verification completed with:

```text
79 tests passed
0 tests failed
216 expectations
12 test files
```

## 24. Verification Commands and Results

The following commands passed after implementation:

```bash
cd apps/gateway

bun run check-types
bun test
bun run test:pipeline
bun run test:guardrails
bun run check:package
```

The workspace-wide type check also passed:

```bash
cd ../..
bun run check-types
```

That check recognized the renamed workspace package as `@llm-gateway/sdk`.

Formatting and patch validation also passed:

```bash
prettier --check <gateway implementation and documentation files>
git diff --check
```

The automated verification used synthetic prompts and deterministic fake
providers. It did not require a real API key.

## 25. Manual SDK Verification

### 25.1 Configure a provider

From `apps/gateway`, configure `.env` with the model endpoint:

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_DEFAULT=gpt-4.1-mini
MODEL_TIMEOUT_MS=30000
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

### 25.2 Verify enabled guardrails

Ensure the checked-in YAML contains:

```yaml
enabled: true
```

Run:

```bash
bun run smoke:sdk
```

No server needs to be running.

The `Provider request after input guardrails` section should contain `<EMAIL>`
instead of `smoke.sdk@gmail.com`.

### 25.3 Verify no configured policy

Override the policy path with an empty value:

```bash
GUARDRAIL_POLICY_PATH= bun run smoke:sdk
```

The printed provider request should contain the original synthetic email.

### 25.4 Verify a loaded but disabled policy

Temporarily change the YAML to:

```yaml
enabled: false
```

Then run:

```bash
bun run smoke:sdk
```

The YAML is loaded and validated, but the provider request contains the original
email because no guardrail hub is attached.

### 25.5 Verify without credentials

The deterministic local checks are:

```bash
bun test tests/model-gateway.test.ts
bun run check:package
```

These checks require no listener, provider endpoint, API key, or network access.

## 26. Security and Privacy Properties

The implemented SDK maintains these properties:

- importing the package does not read `.env`;
- importing the package does not read a policy file;
- importing the package does not open a listener;
- the SDK logger is silent by default;
- provider API keys are not included in gateway results;
- authorization headers are not included in gateway results;
- policy-loaded logs contain metadata only;
- evaluator failures are sanitized before public exposure;
- input and output content are not persisted by the SDK;
- lifecycle records do not contain complete prompts or model responses;
- policy and schema size and path-containment checks remain active; and
- package verification uses only synthetic data.

`providerRequest` is intentionally observable for diagnostics and manual
guardrail verification. It is the main privacy-sensitive result field because
it contains prompt content after the configured input guardrails. Consumers are
responsible for deciding whether it is safe to log or retain.

## 27. Performance Properties

The SDK facade adds no additional provider or guardrail attempt.

The implemented performance characteristics are:

- resource objects are created once per gateway;
- one pipeline is created per gateway;
- YAML and JSON Schema loading occurs once during factory construction;
- compiled policy objects are reused across requests;
- request-specific lifecycle state remains local to each call;
- direct SDK calls do not serialize their input through HTTP JSON;
- the facade does not add a second retry layer;
- the HTTP adapter alone performs HTTP field mapping; and
- direct SDK calls avoid HTTP listener, socket, and request-parsing overhead.

No benchmark suite or explicit concurrency limiter was added in this milestone.

## 28. Differences From the Preliminary Plan

### 28.1 Build implementation

The plan proposed using Bun to build two bundled JavaScript entry points and
TypeScript separately for declarations.

During implementation, Bun `1.3.14` produced an invalid side-effect-free
re-export bundle containing export names without their definitions. The build
was changed to TypeScript's native ESM emit.

The final build therefore:

- emits ESM JavaScript and declarations together;
- rewrites relative `.ts` imports to `.js`;
- emits the supporting internal module tree;
- leaves dependencies external naturally; and
- exposes only the documented root and server entries through `exports`.

This difference is also recorded in the implementation-status section of
`05_sdk_implement.md`.

### 28.2 External consumer fixture

The plan described a package consumer fixture. The final implementation creates
that consumer dynamically inside a temporary directory instead of retaining a
permanent fixture project in the repository.

This keeps the repository smaller while still type-checking and executing the
built package from outside the gateway source directory.

### 28.3 HTTP removal

The HTTP server was not removed. The user explicitly deferred that cleanup until
after the in-process SDK existed.

The Elysia adapter, HTTP schemas, error responses, executable entry, HTTP smoke
scripts, and HTTP regression tests therefore remain in v1.2.

### 28.4 Package publication

The implementation prepares the package structure but keeps `private: true`.
No registry naming, authentication, release automation, tarball publication, or
semantic-version compatibility tooling was added.

## 29. Known Limitations

The v1.2 SDK does not provide:

- registry installation from npm;
- a remote HTTP client;
- streaming or async iterators;
- tool calls;
- multimodal messages;
- retrieval or vector-store integration;
- provider routing or fallback providers;
- policy hot reload;
- per-request policy selection;
- browser or edge-runtime support;
- Deno-specific support;
- Express, Fastify, Hono, or serverless adapters;
- OpenTelemetry integration;
- persisted prompts, responses, or lifecycle events;
- generated API reference documentation;
- explicit rate limiting or concurrency limiting; or
- a stable `1.0.0` compatibility guarantee.

The included OpenAI-compatible provider retains the existing token-parameter
compatibility behavior. Model-specific differences such as alternative output
token parameter names were not changed in this milestone.

## 30. v1.2 Completion State

The v1.2 milestone is complete as an in-process SDK foundation:

- consumers can instantiate a class-based gateway;
- consumers can inject providers and guardrail hubs;
- consumers can load enabled or disabled YAML policies once;
- consumers can call chat completions without an HTTP server;
- consumers receive typed responses, provider requests, request context,
  duration, and lifecycle events;
- SDK imports are side-effect-free;
- SDK logging is silent by default;
- the built package works through its public entries under Bun and Node;
- generated declarations are consumable externally;
- the retained HTTP server uses the same execution path; and
- existing gateway and guardrail behavior remains covered by regression tests.

Future HTTP removal can now operate around the stable `ModelGateway` facade
without changing direct SDK usage.
