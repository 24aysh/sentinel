# Model Gateway SDK-Only Cleanup: Implementation Plan

## 1. Document Purpose

This document converts the HTTP-removal request in `07_remove_http.md` into an
implementation-ready cleanup plan.

The plan uses `06_v1.2.md` as the current as-built baseline. The v1.2 milestone
already established `ModelGateway` as the primary in-process API and retained
Elysia only as a compatibility adapter. This milestone removes that adapter and
all code whose only purpose is starting, configuring, testing, or calling the
local HTTP gateway.

This is a plan. It does not perform the cleanup.

## 2. Interpretation of the Request

The gateway will become an SDK-only package:

- consumers import `@llm-gateway/sdk`;
- consumers construct `ModelGateway` directly;
- consumers inject a provider and optional guardrails;
- consumers call `gateway.chat.completions.create()` in-process; and
- the package does not expose, start, configure, test, or document an HTTP
  server.

“Keep the gateway behavior intact” means preserving the direct SDK behavior
documented in `06_v1.2.md`:

- request validation and normalization;
- default and explicit model selection;
- request ID behavior;
- provider invocation and error normalization;
- YAML policy enable and disable behavior;
- PII allow, redact, and block behavior;
- output JSON Schema validation;
- bounded output repair retries;
- multi-attempt usage aggregation;
- fail-open and fail-closed guardrail behavior;
- lifecycle ordering and listener callbacks;
- silent default SDK logging;
- typed result contents; and
- Bun and Node package consumption.

The following HTTP behavior is intentionally not preserved because its removal
is the purpose of the milestone:

- `GET /health`;
- `POST /v1/chat/completions`;
- Elysia request schemas;
- HTTP request and response serialization;
- HTTP status and error-body translation;
- gateway response headers;
- HTTP debug headers;
- listener host and port configuration; and
- HTTP smoke-client behavior.

### 2.1 Inbound versus upstream HTTP

This cleanup removes the package's **inbound HTTP server**. It does not remove
HTTP used by `OpenAICompatibleProvider` to call an external model API.

The provider must continue using `fetch`, `Headers`, `Response`, the configured
model base URL, bearer authorization, timeout signals, and the upstream
`/chat/completions` endpoint. Those are provider-adapter responsibilities, not
gateway-server responsibilities.

Removing upstream provider HTTP would make the included provider unusable and
would not preserve gateway behavior.

## 3. Assumptions and Decisions

The plan proceeds with these decisions:

1. The main `@llm-gateway/sdk` import remains the supported package API.
2. The `@llm-gateway/sdk/server` export is removed, not deprecated.
3. The package remains private and unpublished during this cleanup.
4. The package version advances from `0.2.0` to `0.3.0` because removing the
   server subpath is a breaking package-surface change, even before `1.0.0`.
5. The `ModelGateway` class, its resource path, and its public option/result
   types remain source-compatible.
6. `GatewayError.code`, `GatewayError.status`, and `retryAfter` remain intact.
   Although `status` originated in the HTTP design, it is present in the
   generated public class declaration. Removing it would create an unrelated
   SDK breaking change for negligible code reduction.
7. `ConfigurationError` remains publicly exported but moves out of the deleted
   server environment module.
8. `ConsoleLogger` remains available as an opt-in SDK logger even though the
   server default logger is removed.
9. The checked-in YAML policy and schema remain SDK examples and smoke assets.
10. Historical specifications remain unchanged as records of earlier versions.
11. The single real-provider smoke becomes `smoke:sdk`.
12. Duplicate deterministic scripts are removed in favor of automated tests and
    the package consumer check.
13. No replacement HTTP framework, remote client, CLI server, or listener is
    introduced.

No clarification is required to implement these boundaries.

## 4. Goals

The cleanup must:

1. Remove Elysia and every HTTP transport module.
2. Remove the executable listener and runtime composition layer.
3. Remove the public `./server` package subpath.
4. Remove server-only environment configuration.
5. Make `smoke:sdk` independent of server configuration helpers.
6. Remove HTTP-only smoke scripts and their shared client.
7. Remove HTTP-only and server-runtime tests.
8. Migrate any lost SDK validation coverage before deleting HTTP tests.
9. Remove duplicated deterministic scripts whose behavior is already covered
   by the automated suite.
10. Collapse SDK composition code that exists only to support the server
    runtime.
11. Remove HTTP response mapping code from the domain layer.
12. Remove Elysia from package metadata and the workspace lockfile.
13. Ensure the built package contains no stale HTTP artifacts.
14. Rewrite documentation around the in-process SDK only.
15. Preserve SDK, provider, guardrail, lifecycle, security, and package behavior.
16. Leave the repository smaller and easier to navigate.

## 5. Non-goals

This milestone must not:

- add a different HTTP server;
- add a remote gateway client;
- change the public chat resource method;
- change the `ChatInput` or `GatewayExecutionResult` shape;
- change YAML policy syntax or semantics;
- add new detectors or output validators;
- add streaming, tool calls, multimodal input, or retrieval;
- change provider request or response compatibility;
- change retry budgets or lifecycle stages;
- publish the package;
- rename the package again;
- introduce a configuration framework;
- introduce a CLI framework;
- replace Bun tests; or
- rewrite historical specifications to pretend HTTP never existed.

## 6. Current HTTP and Redundancy Inventory

### 6.1 HTTP executable and application

The following files exist only to expose the gateway over HTTP:

| File                                   | Current purpose                                | Planned action  |
| -------------------------------------- | ---------------------------------------------- | --------------- |
| `index.ts`                             | Starts the Elysia listener                     | Delete          |
| `src/app.ts`                           | Defines health and completion HTTP routes      | Delete          |
| `src/runtime.ts`                       | Composes provider, SDK, logger, and Elysia app | Delete          |
| `src/server.ts`                        | Exports server helpers through `./server`      | Delete          |
| `src/transport/http/error-response.ts` | Maps SDK errors to HTTP responses and headers  | Delete          |
| `src/transport/http/schemas.ts`        | Defines Elysia request validation schema       | Delete          |
| `src/config/env.ts`                    | Parses listener and model environment settings | Delete/relocate |

The `src/transport/http/` and `src/config/` directories are removed after their
last files are deleted.

### 6.2 HTTP smoke scripts

| File                          | Current purpose                              | Planned action  |
| ----------------------------- | -------------------------------------------- | --------------- |
| `scripts/smoke-client.ts`     | Calls a local gateway URL                    | Delete          |
| `scripts/smoke.ts`            | Exercises HTTP debug provider-request output | Delete          |
| `scripts/smoke-guardrails.ts` | Exercises HTTP guardrail behavior            | Delete          |
| `scripts/smoke-sdk.ts`        | Exercises the in-process SDK                 | Keep and revise |

### 6.3 Redundant deterministic scripts

These scripts are in-process, but duplicate the automated test suite:

| File                         | Equivalent automated coverage                          | Planned action |
| ---------------------------- | ------------------------------------------------------ | -------------- |
| `scripts/test-pipeline.ts`   | `gateway-pipeline.test.ts` and `model-gateway.test.ts` | Delete         |
| `scripts/test-guardrails.ts` | Guardrail pipeline, hub, and SDK tests                 | Delete         |

Their package commands are removed. Deterministic verification remains
available through `bun test` and `bun run check:package`.

### 6.4 HTTP and server tests

| File                          | Current boundary                           | Planned action |
| ----------------------------- | ------------------------------------------ | -------------- |
| `tests/app.test.ts`           | Elysia routes, bodies, headers, and errors | Delete         |
| `tests/guardrail-app.test.ts` | Guardrail behavior through Elysia          | Delete         |
| `tests/runtime.test.ts`       | Environment-to-server composition          | Delete         |
| `tests/env.test.ts`           | Server and provider environment parsing    | Delete         |

Core assertions that are currently covered only incidentally through HTTP tests
must be migrated before these files are removed.

### 6.5 HTTP-specific package surface

The following package features are removed:

- dependency `elysia`;
- export subpath `./server`;
- scripts `dev` and `start`;
- scripts `smoke` and `smoke:guardrails`;
- scripts `test:pipeline` and `test:guardrails`;
- listener-related `.env.example` values; and
- HTTP-oriented README sections.

### 6.6 Current stale-build risk

The TypeScript compiler writes into `dist` but does not delete files emitted by
older builds. The current `dist` contains server modules such as:

- `app.js` and `app.d.ts`;
- `runtime.js` and `runtime.d.ts`;
- `server.js` and `server.d.ts`;
- `transport/http/*`; and
- `config/env.*`.

Deleting source files without cleaning `dist` would still package obsolete HTTP
code because `package.json` publishes the entire `dist` directory.

The build must therefore clean `apps/gateway/dist` before TypeScript emit.

## 7. Target SDK-Only Architecture

After cleanup, the production execution path is only:

```text
Consuming application
        |
        v
ModelGateway
        |
        v
ChatCompletionsResource.create()
        |
        v
GatewayPipeline
   |              |
   v              v
GuardrailHub    ModelProvider
```

There is no runtime wrapper, transport adapter, route schema, listener, or
server-specific dependency.

The file-backed factory path is:

```text
ModelGateway.create(options)
        |
        +--> optional loadGuardrailPolicy()
        |
        +--> optional ConfiguredGuardrailHub
        |
        v
new ModelGateway(...)
```

## 8. Target Source Layout

```text
apps/gateway/
|-- package.json
|-- tsconfig.json
|-- tsconfig.build.json
|-- .env.example                   # real-provider smoke values only
|-- README.md
|-- CLAUDE.md                      # SDK-aware repository guidance
|-- policies/
|   |-- example-policy.yaml
|   `-- schemas/
|       `-- gateway-check-response.json
|-- scripts/
|   |-- check-package.ts
|   `-- smoke-sdk.ts
|-- src/
|   |-- index.ts
|   |-- model-gateway.ts
|   |-- domain/
|   |   |-- chat.ts
|   |   |-- errors.ts
|   |   `-- request-context.ts
|   |-- guardrails/
|   |-- observability/
|   |-- pipeline/
|   `-- providers/
`-- tests/
    |-- gateway-pipeline.test.ts
    |-- guardrail-hub.test.ts
    |-- guardrail-pipeline.test.ts
    |-- model-gateway.test.ts
    |-- openai-compatible-provider.test.ts
    |-- pii-detector.test.ts
    |-- policy-loader.test.ts
    |-- sdk-entry.test.ts
    |-- fixtures/
    `-- helpers/
```

Historical files under `specs/` remain but are omitted from this operational
layout.

## 9. Preserve the Main SDK Contract

The following usage must remain unchanged:

```ts
import {
  GatewayError,
  ModelGateway,
  OpenAICompatibleProvider,
} from "@llm-gateway/sdk";

const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl,
    apiKey,
    timeoutMs: 30_000,
  }),
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});
```

The following public main-entry values remain:

- `ModelGateway`;
- `ChatResource`;
- `ChatCompletionsResource`;
- `OpenAICompatibleProvider`;
- `GatewayError`;
- `ConfigurationError`;
- `ConsoleLogger`; and
- `silentLogger`.

The main-entry public types documented in `06_v1.2.md` also remain.

The removed API is limited to the server subpath and its server-only values and
types.

## 10. Simplify `ModelGateway` Composition

### 10.1 Current redundancy

`ModelGateway.create()` currently calls an exported internal helper:

```ts
return (await composeModelGateway(options)).gateway;
```

`composeModelGateway()` returns `{ gateway, guardrails, policy }` because the
server runtime needs to inspect all three values.

Once `createRuntime()` is deleted, no production caller needs that composition
object.

### 10.2 Target factory

Inline policy composition into `ModelGateway.create()`:

1. default the logger to `silentLogger`;
2. load the optional policy;
3. construct `ConfiguredGuardrailHub` only when enabled;
4. emit the same sanitized policy-loaded metadata;
5. return `new ModelGateway(...)` directly.

Then remove:

- `ModelGatewayComposition`;
- exported `composeModelGateway()`; and
- its extra `{ gateway, guardrails, policy }` return allocation.

The public `ModelGateway.create()` signature and behavior do not change.

### 10.3 Required regression tests

Existing SDK tests must continue proving:

- no-policy construction performs no file access;
- enabled policy redacts across multiple calls;
- disabled policy validates without enforcing;
- policy load logging occurs once;
- invalid policy rejects with `ConfigurationError`; and
- concurrent calls remain isolated.

## 11. Relocate `ConfigurationError`

### 11.1 Reason

`ConfigurationError` currently lives in `src/config/env.ts`, but it is part of
the public SDK API and is also used by:

- `ModelGateway` default-model validation; and
- the YAML policy loader.

Deleting the server environment module must not delete this SDK error type.

### 11.2 Target location

Move `ConfigurationError` into `src/domain/errors.ts` beside `GatewayError`.

This avoids creating a one-class replacement module and removes the now-empty
`src/config/` directory.

Update imports in:

- `src/model-gateway.ts`;
- `src/guardrails/config/policy-loader.ts`;
- `src/index.ts`;
- `tests/model-gateway.test.ts`; and
- `tests/policy-loader.test.ts`.

The supported consumer import remains unchanged:

```ts
import { ConfigurationError } from "@llm-gateway/sdk";
```

Only unsupported internal source paths change.

## 12. Retain the Public SDK Error Shape

`GatewayError` currently exposes:

```ts
class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status: number;
  readonly retryAfter?: string;
}
```

The plan retains all three fields.

Removing `status` would require editing every error construction site and would
silently break consumers compiled against `0.2.0`. The field is small, already
tested, and can remain useful to applications mapping SDK errors into their own
transports.

The cleanup removes HTTP response conversion, not transport-neutral error
metadata.

Tests should stop describing `status` as an Elysia response concern, but provider
and pipeline error assertions continue protecting the public error object.

## 13. Remove HTTP Mapping From Chat Domain

### 13.1 Delete response mapping

`toPublicChatResponse()` exists only for the Elysia adapter and is deleted with
`src/app.ts`.

The SDK already returns the camel-case `ChatResponse` directly.

### 13.2 Localize provider request mapping

`toPublicChatRequest()` will have only one caller after the HTTP adapter is
removed: `OpenAICompatibleProvider`.

Move that mapping into `openai-compatible-provider.ts` as a private helper with
a provider-specific name such as `toProviderRequest()`.

This leaves `src/domain/chat.ts` responsible only for provider-neutral chat
types and role constants.

The OpenAI-compatible wire body must remain identical:

```json
{
  "model": "provider-model",
  "messages": [],
  "stream": false,
  "temperature": 0.25,
  "max_tokens": 80
}
```

Existing provider tests continue protecting this mapping.

## 14. Remove the Server Package Entry

Delete `src/server.ts` and remove `./server` from `package.json`.

The target export map is:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

The main entry remains side-effect-free.

The following imports intentionally stop resolving:

```ts
import { createApp } from "@llm-gateway/sdk/server";
import { createRuntime } from "@llm-gateway/sdk/server";
import { loadConfig } from "@llm-gateway/sdk/server";
```

No deprecation wrapper remains because that would preserve the unwanted HTTP
dependency graph.

## 15. Remove Elysia and HTTP Dependencies

Remove `elysia` from `apps/gateway/package.json`.

Run the workspace package manager after the manifest change so `bun.lock`
removes Elysia and dependencies that are no longer reachable from any other
workspace package.

Do not hand-delete arbitrary lockfile entries. Let Bun recalculate reachability.

After installation, verify:

```bash
bun pm ls --all
```

and repository searches contain no application import or manifest reference to
Elysia.

Ajv, Ajv Formats, and YAML remain required by SDK guardrails.

`@types/bun` remains a development dependency because repository tests and
verification scripts run under Bun.

## 16. Replace Server Environment Configuration in `smoke-sdk`

### 16.1 Current dependency

`smoke-sdk.ts` currently imports `loadConfig()` from `src/server.ts`. Keeping
that helper would retain listener fields and a server-oriented configuration
module for one script.

### 16.2 Target behavior

Make `smoke-sdk.ts` read only the environment values it needs:

- `MODEL_BASE_URL`;
- `MODEL_API_KEY`;
- `MODEL_DEFAULT`;
- `MODEL_TIMEOUT_MS`; and
- `GUARDRAIL_POLICY_PATH`.

Use the same practical defaults as v1.2:

| Variable                | Default                     |
| ----------------------- | --------------------------- |
| `MODEL_BASE_URL`        | `https://api.openai.com/v1` |
| `MODEL_API_KEY`         | Unset                       |
| `MODEL_DEFAULT`         | `gpt-4.1-mini`              |
| `MODEL_TIMEOUT_MS`      | `30000`                     |
| `GUARDRAIL_POLICY_PATH` | Unset                       |

Keep parsing local to the smoke script. Do not add a new production environment
configuration abstraction for a single development script.

The script should minimally validate:

- non-empty base URL and model;
- HTTP or HTTPS base URL; and
- a positive finite integer timeout.

It continues constructing `OpenAICompatibleProvider` and
`ModelGateway.create()` through public SDK imports.

### 16.3 Environment values removed

The SDK-only package no longer recognizes or documents:

- `GATEWAY_HOST`;
- `GATEWAY_PORT`;
- `GATEWAY_URL`;
- `GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST`; or
- `MODEL_PROVIDER`.

`MODEL_PROVIDER` is unnecessary because the smoke script directly constructs
the included `OpenAICompatibleProvider` class.

## 17. Simplify `.env.example`

The target example contains only direct smoke inputs:

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_DEFAULT=gpt-4.1-mini
MODEL_TIMEOUT_MS=30000

# Optional. Omit to run without guardrails.
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

Remove all listener, debug-header, remote gateway URL, and provider-discriminator
values.

The SDK itself still does not automatically read this file. Bun loads `.env`
when the repository smoke script runs; library consumers provide explicit
constructor values.

## 18. Package Script Cleanup

Remove these scripts:

- `dev`;
- `start`;
- `test:pipeline`;
- `test:guardrails`;
- `smoke`;
- `smoke:guardrails`.

Retain:

- `test`;
- `smoke:sdk`;
- `check-types`;
- `build`; and
- `check:package`.

The target script responsibilities are:

| Command                 | Responsibility                                       |
| ----------------------- | ---------------------------------------------------- |
| `bun test`              | Complete automated SDK behavior suite                |
| `bun run smoke:sdk`     | One direct real-provider request                     |
| `bun run check-types`   | Development source type checking                     |
| `bun run build`         | Clean SDK-only ESM/declaration emit                  |
| `bun run check:package` | External declarations, imports, Bun, and Node checks |

No script starts a listener or calls localhost.

## 19. Clean Build Before Emit

Update `build` so it removes only the package-local `dist` directory before
running TypeScript emit.

The cleanup must:

- resolve the explicit `apps/gateway/dist` target from the package working
  directory;
- use `node:fs/promises.rm()` through Bun for cross-platform behavior;
- use `{ recursive: true, force: true }` only for that resolved output
  directory; and
- run before `tsc`.

An inline package script is sufficient. Do not add a build framework or a
one-function `clean.ts` module.

The clean step ensures deleted server files cannot be included in the next
package build.

## 20. Update Package Consumer Verification

Revise `scripts/check-package.ts` for one public entry.

### 20.1 Artifact assertions

Require:

- `dist/index.js`; and
- `dist/index.d.ts`.

Remove requirements for:

- `dist/server.js`; and
- `dist/server.d.ts`.

### 20.2 Import checks

Import only `@llm-gateway/sdk` under Bun and Node.

Continue asserting that the Bun import writes no output and that both runtimes
exit successfully.

### 20.3 Consumer checks

Retain:

- temporary external project creation;
- package linking;
- fake `ModelProvider` implementation;
- generated declaration type checking;
- deterministic Bun execution;
- deterministic Node execution;
- exact `package works` result; and
- `finally` cleanup.

### 20.4 Manifest and stale-artifact checks

Add assertions that:

- the manifest exposes only the `.` package path;
- `elysia` is not a declared dependency; and
- the clean build did not emit `server`, `app`, `runtime`, `config/env`, or
  `transport/http` artifacts.

This turns stale HTTP output into a deterministic verification failure.

## 21. Test Migration Before Deletion

### 21.1 Core validation currently exercised through HTTP

Before deleting `app.test.ts`, add table-driven direct pipeline or SDK tests for
validation cases that do not already have explicit core coverage:

- missing or empty messages;
- unsupported message role at runtime;
- empty message content;
- empty explicit model;
- non-finite or out-of-range temperature;
- non-integer or non-positive `maxTokens`; and
- `stream: true` without a provider call.

The Elysia-only unknown-field rejection is not migrated because permissive
structural extras are not part of the current direct SDK runtime contract.

### 21.2 Guardrail behavior

Before deleting `guardrail-app.test.ts`, confirm existing direct tests cover:

- input block before provider access;
- output block after validation failure;
- redacted first provider request;
- fail-open and fail-closed evaluation; and
- no leakage of private evaluator details.

These are already primarily covered by `guardrail-pipeline.test.ts` and
`model-gateway.test.ts`; add only genuinely missing assertions.

### 21.3 Provider and error behavior

Retain provider tests for:

- upstream request body mapping;
- authorization behavior;
- authentication failures;
- rate limits and `retryAfter`;
- invalid responses;
- network errors; and
- timeouts.

Retain pipeline tests for normalized unexpected errors and failed lifecycle
events.

### 21.4 Entry-point test

Update `sdk-entry.test.ts` to:

- import only `src/index.ts`;
- remove `src/server.ts` assertions;
- retain public SDK value assertions; and
- retain one deterministic completion through the public entry.

## 22. Test Files Retained

The SDK-only automated suite retains these focused files:

| Test file                            | Responsibility                               |
| ------------------------------------ | -------------------------------------------- |
| `gateway-pipeline.test.ts`           | Validation, normalization, lifecycle, errors |
| `guardrail-hub.test.ts`              | Input decisions and output validation        |
| `guardrail-pipeline.test.ts`         | End-to-end guardrail pipeline and retries    |
| `model-gateway.test.ts`              | Public facade, YAML factory, concurrency     |
| `openai-compatible-provider.test.ts` | Included provider mapping and failures       |
| `pii-detector.test.ts`               | Deterministic PII findings                   |
| `policy-loader.test.ts`              | Strict policy and schema loading             |
| `sdk-entry.test.ts`                  | Public SDK entry and deterministic call      |

Fixtures and helpers used by these tests remain.

The target is fewer test files with no loss of production SDK behavior
coverage, not fewer meaningful assertions.

## 23. README Rewrite

Rewrite the README as an SDK-only document.

Keep and strengthen:

1. supported Bun and Node runtimes;
2. direct `ModelGateway` installation and import shape;
3. synchronous dependency-injection construction;
4. asynchronous YAML policy construction;
5. enabled, disabled, and absent policy behavior;
6. result and error handling;
7. provider-request privacy warning;
8. custom provider, guardrail, logger, and listener extension points;
9. build and package checks;
10. direct real-provider smoke instructions; and
11. current SDK limitations.

Remove:

- running the gateway server;
- host and port setup;
- health route documentation;
- chat HTTP request examples;
- HTTP response headers;
- HTTP public error bodies;
- gateway URL configuration;
- debug header configuration;
- server restart instructions;
- HTTP smoke commands; and
- statements describing Elysia as available.

The README should state explicitly that the package does not start or expose an
HTTP server.

## 24. Repository Guidance Update

`apps/gateway/CLAUDE.md` currently contains generic Bun-server guidance and says
to prefer `Bun.file()` over Node filesystem APIs.

That conflicts with the SDK's Node compatibility and the implemented secure
policy loader.

Replace it with concise gateway-specific guidance:

- use Bun for repository scripts and tests;
- keep production SDK imports side-effect-free;
- do not add listener or HTTP framework code;
- keep SDK core compatible with Node 20+;
- prefer cross-runtime Node standard APIs in production SDK modules;
- use explicit dependency injection;
- preserve provider-neutral domain types; and
- use `bun test`, `check-types`, and `check:package` before completion.

Remove generic frontend and `Bun.serve()` examples that are irrelevant to this
package.

## 25. Documentation History

Do not rewrite these historical specifications:

- `00_project.md`;
- `01_project_v1.md`;
- `02_model_gateway.md`;
- `03_v1.1.md`;
- `04_sdk.md`;
- `05_sdk_implement.md`;
- `06_v1.2.md`; or
- `07_remove_http.md`.

They describe requirements and as-built states at earlier milestones.

After implementation, create a new as-built document for the SDK-only release,
following the established pattern, rather than mutating `06_v1.2.md`.

## 26. Public Compatibility Boundary

### 26.1 Preserved

The implementation must preserve:

- `@llm-gateway/sdk` main imports;
- `ModelGateway` constructor options;
- `ModelGateway.create()` options;
- `gateway.chat.completions.create()`;
- camel-case SDK inputs and outputs;
- `GatewayExecutionResult` fields;
- custom provider and guardrail injection;
- custom logger and lifecycle listener injection;
- `GatewayError` codes and fields;
- `ConfigurationError` main-entry import;
- enabled, disabled, and absent policies;
- direct smoke output categories;
- default silent logging; and
- Bun and Node package consumption.

### 26.2 Intentionally removed

The implementation intentionally removes:

- `@llm-gateway/sdk/server`;
- server helper values and types;
- HTTP listener commands;
- local HTTP endpoints;
- HTTP client smoke commands;
- listener and HTTP debug environment variables; and
- Elysia as a dependency.

### 26.3 Unsupported internal imports

Imports from internal paths such as `src/config/env.ts` are not public package
contracts. Internal test imports will change when `ConfigurationError` moves.

## 27. Security and Privacy Requirements

The cleanup must preserve:

- silent default SDK logging;
- sanitized public errors;
- absence of API keys and headers in results;
- policy path containment and file-size validation;
- no prompt or response persistence;
- sanitized policy-loaded logs;
- sanitized guardrail runtime failure logs;
- no package import-time environment or file access; and
- the `providerRequest` privacy warning.

Removing the HTTP debug response reduces one prompt-exposure surface. The SDK
result still intentionally exposes `providerRequest` to the in-process caller.

The clean script must target only the package-local `dist` directory and must
not operate on a workspace root or unresolved environment variable.

## 28. Performance Requirements

The cleanup must not add runtime layers.

After implementation:

- direct calls still create one request context and lifecycle tracker;
- one `GatewayPipeline` remains reused per `ModelGateway`;
- policy and schema compilation still occurs once per factory call;
- no JSON serialization is added around SDK calls;
- no additional retry loop is introduced;
- no transport request parsing occurs; and
- package import no longer evaluates Elysia-related modules.

The resulting installation and build should also shrink after Elysia and its
unreachable dependencies are removed.

## 29. Implementation Sequence

### Phase 1: Establish the SDK-only regression boundary

1. Run the current full test suite and package check.
2. Record the baseline SDK test count and generated artifact list.
3. Add missing direct input-validation assertions.
4. Confirm all guardrail and provider behavior currently covered by HTTP tests
   also has direct coverage.

### Phase 2: Decouple the remaining SDK code

1. Move `ConfigurationError` into `domain/errors.ts`.
2. Update public and internal imports.
3. Inline `composeModelGateway()` into `ModelGateway.create()`.
4. Remove the composition-only return object and helper export.
5. Delete `toPublicChatResponse()`.
6. Move the remaining provider request mapper into the OpenAI provider module.
7. Run core tests and type checking.

### Phase 3: Remove HTTP production code

1. Delete root `index.ts`.
2. Delete `src/app.ts`.
3. Delete `src/runtime.ts`.
4. Delete `src/server.ts`.
5. Delete `src/transport/http/`.
6. Delete the remaining server environment module and empty directory.
7. Search for unresolved server imports.

### Phase 4: Remove HTTP and duplicate scripts

1. Make `smoke-sdk.ts` self-contained for model environment values.
2. Delete `smoke-client.ts`.
3. Delete `smoke.ts`.
4. Delete `smoke-guardrails.ts`.
5. Delete duplicated `test-pipeline.ts` and `test-guardrails.ts`.
6. Simplify `.env.example`.

### Phase 5: Remove obsolete tests

1. Delete `app.test.ts`.
2. Delete `guardrail-app.test.ts`.
3. Delete `runtime.test.ts`.
4. Delete `env.test.ts`.
5. Update `sdk-entry.test.ts`.
6. Run the remaining suite and confirm no core assertion was lost.

### Phase 6: Simplify package and build

1. Remove the `./server` export.
2. Remove Elysia.
3. Remove obsolete package commands.
4. Bump the private package to `0.3.0`.
5. Add the explicit clean-before-build step.
6. Update `check-package.ts` for one entry and stale-artifact checks.
7. Recalculate the workspace lockfile with Bun.

### Phase 7: Rewrite active documentation

1. Rewrite README sections around SDK-only usage.
2. Update `CLAUDE.md` for cross-runtime SDK guidance.
3. Preserve historical specs.
4. Create the post-implementation as-built document only after verification.

### Phase 8: Full verification

1. Run formatting.
2. Run SDK type checking.
3. Run the complete remaining automated suite.
4. Run a clean build.
5. Run the external package check.
6. Run workspace-wide type checking.
7. Search source, package metadata, scripts, tests, and built output for removed
   HTTP concepts.
8. Inspect the final diff and file list.
9. Leave the real-provider smoke as an explicit manual check unless credentials
   are available.

## 30. File Change Plan

### 30.1 Delete production files

- `index.ts`
- `src/app.ts`
- `src/runtime.ts`
- `src/server.ts`
- `src/config/env.ts`
- `src/transport/http/error-response.ts`
- `src/transport/http/schemas.ts`

### 30.2 Delete scripts

- `scripts/smoke-client.ts`
- `scripts/smoke.ts`
- `scripts/smoke-guardrails.ts`
- `scripts/test-pipeline.ts`
- `scripts/test-guardrails.ts`

### 30.3 Delete tests

- `tests/app.test.ts`
- `tests/guardrail-app.test.ts`
- `tests/runtime.test.ts`
- `tests/env.test.ts`

### 30.4 Modify production files

- `src/model-gateway.ts`
- `src/domain/errors.ts`
- `src/domain/chat.ts`
- `src/guardrails/config/policy-loader.ts`
- `src/providers/openai-compatible-provider.ts`
- `src/pipeline/gateway-pipeline.ts`, only if direct validation coverage exposes
  a core issue
- `src/index.ts`

### 30.5 Modify scripts and configuration

- `scripts/smoke-sdk.ts`
- `scripts/check-package.ts`
- `package.json`
- `bun.lock`
- `.env.example`
- `README.md`
- `CLAUDE.md`

### 30.6 Modify tests

- `tests/gateway-pipeline.test.ts`
- `tests/model-gateway.test.ts`
- `tests/openai-compatible-provider.test.ts`, only for terminology or preserved
  error-shape assertions
- `tests/policy-loader.test.ts`
- `tests/sdk-entry.test.ts`
- guardrail tests only where a missing direct assertion is identified

### 30.7 Keep unchanged unless verification finds a defect

- checked-in policy and schema;
- PII detector and evaluator;
- configured guardrail hub;
- JSON Schema validator;
- provider interface;
- request context;
- lifecycle tracker;
- logger implementation;
- TypeScript development settings; and
- build compiler settings other than the package clean command.

## 31. Redundancy Rules During Implementation

Use these rules to keep the cleanup from introducing replacement clutter:

1. Do not replace Elysia with another framework.
2. Do not retain deprecated server stubs.
3. Do not add a second SDK method alias.
4. Do not add a production environment loader for one smoke script.
5. Do not add a standalone `ConfigurationError` file when `domain/errors.ts`
   already owns public gateway errors.
6. Do not add a standalone build-clean source file for one package script.
7. Do not duplicate provider request mapping in the domain layer.
8. Do not keep deterministic scripts that duplicate automated tests.
9. Do not retain HTTP tests as commented code or skipped suites.
10. Do not expose internal modules merely because TypeScript emits them.
11. Do not weaken tests to make deletions pass.
12. Do not rewrite stable SDK behavior while removing transport code.

## 32. Verification Commands

The completed cleanup must pass:

```bash
cd apps/gateway

bun run check-types
bun test
bun run build
bun run check:package
```

Then from the workspace root:

```bash
bun run check-types
```

Formatting and diff checks:

```bash
prettier --check apps/gateway
git diff --check
```

Absence checks should cover active files and built output:

```bash
rg -n "Elysia|createApp|createRuntime|GatewayConfig|GATEWAY_URL|GATEWAY_HOST|GATEWAY_PORT" \
  apps/gateway/src apps/gateway/scripts apps/gateway/tests \
  apps/gateway/package.json apps/gateway/.env.example

find apps/gateway/dist -type f | sort
```

Expected search result: no active inbound HTTP-server matches. Historical specs
may still contain those terms by design, and the OpenAI-compatible provider
still contains outbound model-API HTTP behavior.

Dependency inspection:

```bash
bun pm ls --all
```

Expected result: `@llm-gateway/sdk` remains a workspace package and Elysia is
not in its reachable dependency tree.

The real-provider manual verification remains:

```bash
cd apps/gateway
bun run smoke:sdk
```

## 33. Manual Behavior Comparison

### 33.1 Guardrails enabled

With:

```dotenv
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

and:

```yaml
enabled: true
```

`bun run smoke:sdk` must show `<EMAIL>` in the first provider request.

### 33.2 No policy

With:

```bash
GUARDRAIL_POLICY_PATH= bun run smoke:sdk
```

the provider request must contain the original synthetic email.

### 33.3 Loaded but disabled policy

With the example path configured and YAML `enabled: false`, the policy must load
successfully while the provider request retains the original email.

None of these checks require or permit starting a local gateway server.

## 34. Acceptance Criteria

The SDK-only cleanup is complete when:

1. `apps/gateway/index.ts` no longer exists.
2. No Elysia application or HTTP transport source remains.
3. Elysia is absent from the package manifest and reachable dependency tree.
4. The `./server` package export no longer exists.
5. `@llm-gateway/sdk` remains importable through its main entry.
6. `ModelGateway` construction and factory signatures remain compatible.
7. `gateway.chat.completions.create()` behaves identically for direct callers.
8. Public request, result, lifecycle, provider, guardrail, logger, and error
   types remain available from the main entry.
9. `ConfigurationError` remains available from the main entry.
10. `GatewayError.code`, `status`, and `retryAfter` remain compatible.
11. Enabled, disabled, and absent YAML policies preserve v1.2 behavior.
12. PII redaction remains visible through `providerRequest`.
13. Input and output block behavior remains unchanged.
14. Output repair retries and usage aggregation remain unchanged.
15. Lifecycle events and concurrency isolation remain unchanged.
16. SDK imports remain side-effect-free.
17. `smoke:sdk` works without server helpers or a listener.
18. No HTTP smoke client or HTTP smoke command remains.
19. No duplicate deterministic pipeline script remains.
20. No HTTP or runtime test file remains.
21. Direct tests cover all retained core validation and guardrail behavior.
22. A clean build contains no stale server, app, runtime, config, or transport
    artifact.
23. The external TypeScript consumer type-checks against declarations.
24. Deterministic package consumers run under Bun and Node.
25. README and `.env.example` describe only SDK usage.
26. Active source and package searches contain no inbound HTTP server concepts.
27. Historical specs remain intact.
28. The package remains private and unpublished.
29. Formatting, type checking, tests, build, package check, and diff validation
    pass.
30. No replacement framework or redundant abstraction is introduced.

## 35. Expected Outcome

After implementation, `apps/gateway` will be a focused in-process SDK package.
Its production code will contain only:

- the `ModelGateway` facade;
- provider-neutral chat and error domains;
- request lifecycle and pipeline logic;
- guardrail loading and evaluation;
- observability interfaces;
- provider interfaces and the included OpenAI-compatible provider; and
- one side-effect-free public package entry.

All listener, route, transport serialization, server configuration, HTTP smoke,
HTTP test, and Elysia dependency code will be gone. The remaining tests and
package consumer checks will protect the same SDK behavior with a smaller and
clearer codebase.
