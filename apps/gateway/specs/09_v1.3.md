# Model Gateway v1.3: As-Built SDK-Only Cleanup

## 1. Document Purpose

This document records the implementation of the SDK-only cleanup specified in
`08_remove_http_implement.md`.

It is an as-built specification. The gateway package no longer contains an
inbound HTTP server, Elysia adapter, listener runtime, server export, HTTP smoke
client, or HTTP test suite. The supported execution path is the in-process
`ModelGateway` API.

The cleanup preserves outbound HTTP inside `OpenAICompatibleProvider`, which is
required to call an external model API.

## 2. Release Identity

The package is now:

```json
{
  "name": "@llm-gateway/sdk",
  "version": "0.3.0",
  "private": true,
  "sideEffects": false
}
```

The package remains unpublished. Version `0.3.0` records removal of the former
`./server` package subpath.

## 3. Final Architecture

The production path is:

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

There is no listener, route layer, request schema, HTTP response mapper, or
server runtime around this path.

The file-backed construction path is:

```text
ModelGateway.create()
        |
        +--> optional YAML policy load and schema compilation
        +--> optional ConfiguredGuardrailHub
        |
        v
new ModelGateway(...)
```

## 4. Removed Production Code

The following production files were deleted:

- root `index.ts` listener;
- `src/app.ts`;
- `src/runtime.ts`;
- `src/server.ts`;
- `src/config/env.ts`;
- `src/transport/http/error-response.ts`; and
- `src/transport/http/schemas.ts`.

The package has no `src/config/` or `src/transport/` production module tree.

## 5. Removed HTTP Scripts

The following scripts were deleted:

- `scripts/smoke-client.ts`;
- `scripts/smoke.ts`; and
- `scripts/smoke-guardrails.ts`.

No remaining script calls `GATEWAY_URL`, localhost, `/health`, or the former
completion route.

## 6. Retained SDK Testing Scripts

The initial cleanup plan proposed deleting the two deterministic testing
scripts. The final user instruction explicitly requested that testing scripts be
updated to the latest SDK instead.

They were retained and migrated:

| Command                   | SDK construction path                       |
| ------------------------- | ------------------------------------------- |
| `bun run test:pipeline`   | `new ModelGateway(...)`                     |
| `bun run test:guardrails` | `await ModelGateway.create({ policyPath })` |

Both scripts import `ModelGateway` and their public types exclusively from
`src/index.ts`. They do not construct `GatewayPipeline` or
`ConfiguredGuardrailHub` directly.

`test:pipeline` verifies:

- synchronous class construction;
- default model resolution;
- normalized provider input;
- a deterministic provider result;
- request ID propagation; and
- the provider-only lifecycle.

`test:guardrails` verifies:

- asynchronous class construction;
- YAML policy loading;
- email redaction before provider access;
- invalid-output repair;
- two provider attempts;
- usage aggregation;
- final schema-compatible output; and
- the complete guardrail lifecycle.

Neither script requires a network connection, listener, or API key.

## 7. Removed HTTP Tests

The following test files were deleted:

- `tests/app.test.ts`;
- `tests/guardrail-app.test.ts`;
- `tests/runtime.test.ts`; and
- `tests/env.test.ts`.

Before deleting them, direct pipeline coverage was expanded for retained SDK
validation behavior.

## 8. Expanded Direct Validation Coverage

`gateway-pipeline.test.ts` now has table-driven rejection tests for:

- missing messages;
- empty messages;
- unsupported runtime message roles;
- empty message content;
- empty explicit model;
- negative temperature;
- temperature above the supported range;
- non-finite temperature;
- zero `maxTokens`; and
- fractional `maxTokens`.

Every case verifies `INVALID_REQUEST`, status `400`, and zero provider calls.

The existing streaming test continues verifying `UNSUPPORTED_FEATURE`, zero
provider calls, and the failed lifecycle.

The guardrail input-block test now also verifies that the public error does not
contain the raw email or private rule ID.

## 9. Current Automated Test Suite

The remaining focused test files are:

- `gateway-pipeline.test.ts`;
- `guardrail-hub.test.ts`;
- `guardrail-pipeline.test.ts`;
- `model-gateway.test.ts`;
- `openai-compatible-provider.test.ts`;
- `pii-detector.test.ts`;
- `policy-loader.test.ts`; and
- `sdk-entry.test.ts`.

The verified result is:

```text
63 tests passed
0 tests failed
156 expectations
8 test files
```

The lower test count reflects deletion of transport and server tests, not
removal of direct SDK behavior coverage.

## 10. `ModelGateway.create()` Simplification

The former internal `composeModelGateway()` helper existed to return:

```ts
{
  (gateway, guardrails, policy);
}
```

for the server runtime.

With `createRuntime()` removed, `ModelGateway.create()` now performs policy
composition directly and returns `ModelGateway` without an intermediate
composition result.

The public factory signature remains unchanged.

It still:

1. loads an optional YAML policy;
2. compiles referenced schema once;
3. attaches `ConfiguredGuardrailHub` only when enabled;
4. logs sanitized policy metadata through the injected logger; and
5. constructs the gateway with the provider, default model, hub, logger, and
   lifecycle listener.

## 11. `ConfigurationError` Relocation

`ConfigurationError` moved from deleted `src/config/env.ts` into
`src/domain/errors.ts` beside `GatewayError`.

The public consumer import is unchanged:

```ts
import { ConfigurationError } from "@llm-gateway/sdk";
```

It remains used for:

- invalid gateway construction options;
- invalid YAML policy documents;
- missing or unsafe policy and schema paths; and
- invalid real-provider smoke configuration.

`GatewayError.code`, `status`, and `retryAfter` remain unchanged.

## 12. Chat Domain Cleanup

`src/domain/chat.ts` now contains provider-neutral chat types and role constants
only.

The HTTP response mapper was deleted.

The OpenAI-compatible request mapper moved into
`openai-compatible-provider.ts` as the private `toProviderRequest()` helper,
because that provider is now its only caller.

Provider tests confirm the upstream request remains:

```json
{
  "model": "provider-model",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false,
  "temperature": 0.25,
  "max_tokens": 80
}
```

## 13. Public Package Entry

The package exposes one subpath:

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

`@llm-gateway/sdk/server` no longer resolves.

The main entry continues exporting:

- `ModelGateway`;
- `ChatResource`;
- `ChatCompletionsResource`;
- `OpenAICompatibleProvider`;
- `GatewayError`;
- `ConfigurationError`;
- `ConsoleLogger`;
- `silentLogger`; and
- the documented chat, provider, guardrail, logger, lifecycle, request, result,
  and option types.

## 14. Dependency Cleanup

Elysia was removed from `package.json` and `bun.lock`.

The runtime dependencies are now:

```json
{
  "ajv": "^8.20.0",
  "ajv-formats": "^3.0.1",
  "yaml": "^2.9.0"
}
```

Ajv and YAML remain required for local policy compilation and output
validation.

The OpenAI-compatible provider continues using the runtime's standard `fetch`,
`Headers`, `Response`, and `AbortSignal` APIs for outbound model requests.

## 15. Package Scripts

The active package scripts are:

```json
{
  "test": "bun test",
  "test:pipeline": "bun scripts/test-pipeline.ts",
  "test:guardrails": "bun scripts/test-guardrails.ts",
  "smoke:sdk": "bun scripts/smoke-sdk.ts",
  "check-types": "bun x tsc --noEmit",
  "build": "clean dist, then emit TypeScript",
  "check:package": "bun run build && bun scripts/check-package.ts"
}
```

There is no `dev`, `start`, `smoke`, or `smoke:guardrails` command.

## 16. Clean Build

The build now resolves and deletes only the package-local `dist` directory
before TypeScript emit.

This prevents files emitted by the removed server source from surviving into a
new package build.

After a clean build, `dist` contains only:

- the main SDK entry;
- domain modules;
- `model-gateway`;
- guardrail modules;
- observability modules;
- pipeline modules; and
- provider modules.

No app, runtime, server, environment configuration, or transport artifact is
present.

The built directory decreased from approximately `348 KB` before cleanup to
`264 KB` after cleanup in the implementation environment.

## 17. Package Verification

`scripts/check-package.ts` now verifies:

- `dist/index.js` exists;
- `dist/index.d.ts` exists;
- the manifest exposes only `.`;
- Elysia is not a dependency;
- no app, runtime, server, environment, or HTTP transport artifact remains;
- the public import is side-effect-free under Bun;
- the public import exits successfully under Node;
- generated declarations type-check in a temporary external consumer;
- a deterministic linked package consumer runs under Bun;
- the same deterministic consumer runs under Node; and
- temporary consumer files are removed in `finally`.

No real provider or network request is used by this verification.

## 18. Environment Example

`.env.example` contains only values used by the direct SDK smoke:

```dotenv
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_DEFAULT=gpt-4.1-mini
MODEL_TIMEOUT_MS=30000

GUARDRAIL_POLICY_PATH=policies/example-policy.yaml
```

The following server variables were removed:

- `GATEWAY_HOST`;
- `GATEWAY_PORT`;
- `GATEWAY_URL`;
- `GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST`; and
- `MODEL_PROVIDER`.

The SDK itself does not implicitly read `.env`.

## 19. Direct SDK Smoke

`smoke-sdk.ts` no longer imports a server configuration helper.

It reads and minimally validates only:

- model base URL;
- optional API key;
- default model;
- positive integer timeout; and
- optional guardrail policy path.

It then constructs `OpenAICompatibleProvider` and calls
`ModelGateway.create()` through `src/index.ts`.

The script prints:

- the first provider request after input guardrails;
- the assistant response;
- request ID; and
- duration.

No listener or gateway URL is involved.

## 20. Active Documentation

The README now documents only:

- package setup and build;
- in-process SDK quick start;
- synchronous and asynchronous construction;
- result and error contracts;
- YAML enable and disable behavior;
- lifecycle behavior;
- automated tests;
- SDK-based deterministic scripts;
- external package verification;
- direct real-provider smoke; and
- current SDK limitations.

`CLAUDE.md` was replaced with concise SDK-specific guidance. It prohibits
inbound server code, requires side-effect-free imports, and preserves Node 20+
compatibility in production modules.

Historical specifications remain unchanged.

## 21. Manual Verification

Configure `.env`, then run:

```bash
bun run smoke:sdk
```

With the example policy enabled, the printed provider request contains
`<EMAIL>`.

Compare the no-policy behavior with:

```bash
GUARDRAIL_POLICY_PATH= bun run smoke:sdk
```

The printed provider request then contains the original synthetic email.

No server should be started for either command.

## 22. Verified Commands

The implementation passed:

```bash
bun run check-types
bun test
bun run test:pipeline
bun run test:guardrails
bun run build
bun run check:package
```

The workspace-wide command also passed:

```bash
bun run check-types
```

Package verification succeeded under Bun and Node using a deterministic fake
provider.

The real-provider smoke was not run automatically because it requires user
credentials and external provider access.

## 23. Preserved SDK Behavior

The cleanup preserves:

- main package imports;
- class construction;
- YAML-backed factory construction;
- chat input and result types;
- provider and guardrail injection;
- silent default logging;
- request ID handling;
- immutable request normalization;
- provider errors;
- PII detection and redaction;
- input and output block decisions;
- fail-open and fail-closed behavior;
- output retries;
- usage aggregation;
- lifecycle events;
- concurrent request isolation; and
- Bun and Node package consumption.

## 24. Intentionally Removed Behavior

The package no longer provides:

- an inbound HTTP listener;
- health or completion routes;
- HTTP request validation;
- HTTP response serialization;
- HTTP headers or error bodies;
- server runtime construction;
- a server package subpath;
- listener environment configuration;
- HTTP smoke clients; or
- HTTP test coverage.

## 25. Current Limitations

The SDK remains private and unpublished.

It does not include:

- streaming;
- tool calls;
- multimodal input;
- a remote HTTP client;
- provider routing or fallback;
- policy hot reload;
- browser or edge-runtime support;
- persistence;
- telemetry integration; or
- a stable `1.0.0` compatibility guarantee.

## 26. Completion State

`apps/gateway` is now an in-process SDK package with one public entry and no
inbound HTTP server dependency.

The retained deterministic scripts, automated tests, clean build, and external
consumer checks all exercise the latest `ModelGateway` implementation.
