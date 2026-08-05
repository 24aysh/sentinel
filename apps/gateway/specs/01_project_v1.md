# Project Initialization: As-Built Implementation

## 1. Document Purpose

This document records what was actually implemented for the project
initialization milestone defined in `01_project_init.md`.

It is an as-built specification rather than a future implementation plan. It
describes the current gateway behavior, source layout, runtime contracts,
verification coverage, and known limitations as of gateway version `0.1.0`.

## 2. Implementation Status

The initial gateway lifecycle is implemented end to end.

| Capability                              | Status                        |
| --------------------------------------- | ----------------------------- |
| Bun and TypeScript backend              | Implemented                   |
| Elysia HTTP application                 | Implemented                   |
| Health endpoint                         | Implemented                   |
| Non-streaming chat-completions endpoint | Implemented                   |
| Request validation                      | Implemented                   |
| Provider-neutral domain contracts       | Implemented                   |
| Fixed gateway lifecycle                 | Implemented                   |
| OpenAI-compatible provider adapter      | Implemented                   |
| Environment validation                  | Implemented                   |
| Request IDs and duration headers        | Implemented                   |
| Structured lifecycle logging            | Implemented                   |
| Sanitized public errors                 | Implemented                   |
| Unit and in-process integration tests   | Implemented                   |
| Deterministic pipeline test script      | Implemented                   |
| One-request gateway smoke script        | Implemented                   |
| Guardrails and policy enforcement       | Intentionally not implemented |
| Streaming and tool calls                | Intentionally not implemented |

## 3. Current Source Layout

```text
apps/gateway/
|-- index.ts
|-- src/
|   |-- app.ts
|   |-- runtime.ts
|   |-- config/
|   |   `-- env.ts
|   |-- domain/
|   |   |-- chat.ts
|   |   |-- errors.ts
|   |   `-- request-context.ts
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
|-- tests/
|   |-- app.test.ts
|   |-- env.test.ts
|   |-- gateway-pipeline.test.ts
|   |-- openai-compatible-provider.test.ts
|   `-- helpers/
|       `-- fake-provider.ts
|-- scripts/
|   |-- smoke.ts
|   `-- test-pipeline.ts
|-- specs/
|   |-- 00_project.md
|   |-- 01_project_init.md
|   `-- 02_project_init_implementation.md
|-- .env.example
|-- package.json
|-- README.md
`-- tsconfig.json
```

## 4. Runtime Composition

### 4.1 Executable entry point

`index.ts` is limited to runtime construction and server startup. It:

1. Calls `createRuntime()`.
2. Starts the Elysia application on the configured host and port.
3. Emits a structured `gateway.started` log containing the host, port, and
   provider name.

Provider credentials are not logged.

### 4.2 Dependency construction

`src/runtime.ts` constructs the concrete runtime dependencies:

```text
GatewayConfig
    +
ConsoleLogger
    |
    v
OpenAICompatibleProvider
    |
    v
GatewayPipeline
    |
    v
Elysia application
```

The application and pipeline can also be constructed directly with test
dependencies. This is used by the automated tests to avoid opening ports or
calling a real provider.

### 4.3 HTTP application

`src/app.ts` exports `createApp()`. Creating an application does not start a
network listener.

The application is configured with Elysia normalization disabled. This ensures
that unsupported request properties fail validation rather than being removed
silently before the handler sees them.

## 5. Configuration

Configuration is read from `process.env`. Bun loads `.env` automatically, so
the gateway has no `dotenv` dependency.

### 5.1 Supported variables

| Variable           | Default                     | Validation                                             |
| ------------------ | --------------------------- | ------------------------------------------------------ |
| `GATEWAY_HOST`     | `0.0.0.0`                   | Must be non-empty.                                     |
| `GATEWAY_PORT`     | `3001`                      | Integer from `1` through `65535`.                      |
| `MODEL_PROVIDER`   | `openai-compatible`         | Only the implemented provider is accepted.             |
| `MODEL_BASE_URL`   | `https://api.openai.com/v1` | Must be an HTTP or HTTPS URL.                          |
| `MODEL_API_KEY`    | None                        | Optional; omitted for unauthenticated local providers. |
| `MODEL_DEFAULT`    | `gpt-4.1-mini`              | Must be non-empty.                                     |
| `MODEL_TIMEOUT_MS` | `30000`                     | Integer from `1` through `600000`.                     |
| `GATEWAY_URL`      | `http://localhost:3001`     | Used by `scripts/smoke.ts` only.                       |

Invalid runtime configuration throws a `ConfigurationError` during startup.
Error messages identify the invalid variable without including secrets.

The checked-in `.env.example` contains every supported variable. A real `.env`
is ignored by Git.

## 6. Domain Model

### 6.1 Supported roles

The current chat domain supports:

- `system`
- `user`
- `assistant`

### 6.2 Pipeline input

The public HTTP request is mapped to the provider-neutral `ChatInput` type:

```ts
interface ChatInput {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}
```

The pipeline validates the input and produces a `ChatRequest` with a resolved,
required model name. Message objects and the message array are copied so the
caller-owned request is not mutated.

### 6.3 Provider response

Provider output is normalized into `ChatResponse`. The public HTTP layer then
converts the internal camelCase fields back to the supported OpenAI-compatible
snake_case response fields.

Raw upstream provider response objects do not leave the provider adapter.

## 7. Request Context and Identifiers

Every pipeline execution receives a `RequestContext` containing:

```ts
interface RequestContext {
  requestId: string;
  startedAt: number;
  model: string;
}
```

The gateway preserves an incoming `x-request-id` only when it matches the
implemented conservative format:

```text
1 through 128 characters
first character: letter or number
remaining characters: letters, numbers, dot, underscore, colon, or hyphen
```

If the header is absent or invalid, the gateway generates a UUID with
`crypto.randomUUID()`.

## 8. Implemented Gateway Lifecycle

`GatewayPipeline.execute()` owns the fixed lifecycle.

A successful request records:

```text
received
  -> validated
  -> provider_started
  -> provider_completed
  -> completed
```

Stage behavior:

1. `received`
   - Request context has been created.
   - Gateway timing has started.

2. `validated`
   - Streaming has been rejected when requested.
   - Messages and optional parameters have been validated.
   - The default model has been resolved when necessary.
   - A new normalized domain request has been created.

3. `provider_started`
   - `ModelProvider.complete()` is about to be called.

4. `provider_completed`
   - The provider returned a valid normalized response.

5. `completed`
   - The result and duration are ready for the HTTP layer.

Any thrown error is normalized into a `GatewayError`, and one `failed` event is
recorded. The failure event includes the stable error code and the last
successful lifecycle stage.

Lifecycle events are observational only. They do not inspect, transform, or
block prompt or completion content.

## 9. Provider Boundary

The pipeline depends on the following interface:

```ts
interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse>;
}
```

This keeps Elysia and OpenAI-compatible HTTP details outside the pipeline.

### 9.1 OpenAI-compatible adapter

`OpenAICompatibleProvider` is the only concrete provider currently included.
It uses native `fetch` and sends one request to:

```text
{MODEL_BASE_URL}/chat/completions
```

The adapter:

- Sends `POST` with a JSON body.
- Adds `Authorization: Bearer <MODEL_API_KEY>` when a key is configured.
- Always sends `stream: false` upstream.
- Maps `maxTokens` to `max_tokens`.
- Preserves message order and contents.
- Uses `AbortSignal.timeout()` with `MODEL_TIMEOUT_MS`.
- Requires at least one structurally valid assistant choice.
- Normalizes optional token usage.
- Does not expose raw provider error bodies publicly.

The fetch implementation is injectable for deterministic tests.

## 10. HTTP API

### 10.1 `GET /health`

Returns:

```json
{
  "status": "ok",
  "service": "llm-gateway",
  "version": "0.1.0"
}
```

This is a liveness check only. It does not validate credentials or call the
model provider.

### 10.2 `POST /v1/chat/completions`

Implemented request fields:

| Field         | Required | Behavior                                      |
| ------------- | -------- | --------------------------------------------- |
| `model`       | No       | Uses `MODEL_DEFAULT` when absent.             |
| `messages`    | Yes      | Non-empty array of supported text messages.   |
| `temperature` | No       | Number from `0` through `2`.                  |
| `max_tokens`  | No       | Positive integer.                             |
| `stream`      | No       | May be absent or `false`; `true` is rejected. |

Unknown properties are rejected by the HTTP schema.

Successful responses use the `chat.completion` object shape and contain:

- Provider completion ID.
- Provider creation timestamp.
- Provider model name.
- Normalized assistant choices.
- Optional normalized token usage.

Every chat response includes:

- `x-request-id`
- `x-gateway-duration-ms`

## 11. Error Handling

Public errors use:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request body failed validation.",
    "request_id": "gateway-request-id"
  }
}
```

Implemented mappings:

| Condition                                 | Status | Code                          |
| ----------------------------------------- | -----: | ----------------------------- |
| Malformed JSON or invalid schema          |    400 | `INVALID_REQUEST`             |
| `stream: true`                            |    400 | `UNSUPPORTED_FEATURE`         |
| Upstream HTTP `429`                       |    429 | `MODEL_RATE_LIMITED`          |
| Upstream timeout                          |    504 | `MODEL_TIMEOUT`               |
| Upstream HTTP `401` or `403`              |    502 | `MODEL_AUTHENTICATION_FAILED` |
| Invalid upstream JSON or shape            |    502 | `INVALID_MODEL_RESPONSE`      |
| Network error or other non-success status |    502 | `MODEL_UPSTREAM_ERROR`        |
| Unexpected internal exception             |    500 | `INTERNAL_ERROR`              |

A safe upstream `Retry-After` header is preserved for rate-limit responses.

The current adapter intentionally sanitizes other upstream failure bodies. As
a result, provider-specific details for `400`, `404`, or `5xx` responses are
reported publicly as the generic `MODEL_UPSTREAM_ERROR` message.

## 12. Logging

The implemented logger writes one JSON object per line through `console.info`
or `console.error`.

Lifecycle logs contain operational fields such as:

- Event name.
- Timestamp.
- Request ID.
- Model name.
- Lifecycle stage.
- Elapsed duration.
- Stable error code for failures.

The implementation does not log:

- Prompt contents.
- Completion contents.
- API keys.
- Authorization headers.
- Complete request or response bodies.

A `silentLogger` is supplied for tests and scripts that should not emit
operational logs.

## 13. Verification Scripts

### 13.1 Deterministic pipeline script

`scripts/test-pipeline.ts` creates the production `GatewayPipeline` with a
deterministic in-memory provider.

It verifies:

- The configured default model is used.
- Messages pass through unchanged.
- A known response is returned.
- The successful lifecycle order is correct.

It performs no network call and consumes no provider quota.

Run it with:

```bash
bun run test:pipeline
```

### 13.2 Gateway smoke script

`scripts/smoke.ts` is intentionally minimal. It:

1. Sends exactly one HTTP request through the running gateway.
2. Sends one user message whose content is `hi`.
3. Uses the gateway's configured default model.
4. Prints only the first assistant response on success.
5. Prints the stable gateway error code and message on failure.

It does not separately call the provider, retry a failure, or make a second
request. One invocation of this script consumes at most one model request.

Run it after starting the gateway:

```bash
bun scripts/smoke.ts
```

## 14. Automated Test Coverage

The Bun test suite currently contains 34 passing tests across four areas.

### 14.1 Configuration tests

- Documented defaults.
- Explicit local-provider values.
- Missing optional API key.
- Invalid port.
- Invalid timeout.
- Invalid base URL protocol.
- Unsupported provider name.

### 14.2 Provider tests

- URL and request-body mapping.
- Bearer authorization.
- Optional authorization omission.
- Successful response normalization.
- Authentication failure mapping.
- Rate-limit mapping and `Retry-After` preservation.
- Upstream server failure mapping.
- Invalid JSON.
- Invalid successful response shape.
- Network failure.
- Timeout failure.

### 14.3 Pipeline tests

- One provider call per successful execution.
- Default and explicit models.
- Message and parameter forwarding.
- Input immutability.
- Request ID generation and preservation.
- Successful lifecycle order.
- Streaming rejection.
- Failure lifecycle behavior.
- Unexpected-error sanitization.
- Whitespace-only message rejection.

### 14.4 HTTP application tests

- Health response without a provider call.
- Successful end-to-end in-process request.
- Default model behavior.
- Request ID and duration headers.
- Missing, empty, or structurally invalid messages.
- Unknown property rejection.
- Malformed JSON.
- Streaming rejection.
- Timeout response.
- Unexpected provider-error sanitization.

All automated provider and HTTP tests use fakes. They do not consume API quota.

## 15. Package Commands

The gateway package exposes:

```json
{
  "dev": "bun --watch index.ts",
  "start": "bun index.ts",
  "test": "bun test",
  "test:pipeline": "bun scripts/test-pipeline.ts",
  "smoke": "bun scripts/smoke.ts",
  "check-types": "bunx tsc --noEmit",
  "build": "bun build index.ts --outdir dist --target bun"
}
```

The unused Express-oriented `cors` dependency was removed. Elysia is the only
runtime dependency declared by the gateway package.

## 16. Verification Completed During Implementation

The implementation was verified with:

```text
bun test                         34 passing tests
bun scripts/test-pipeline.ts     passed
bunx tsc --noEmit                passed
bun build ... --target bun       passed
prettier --check                 passed
git diff --check                 passed
```

The real-provider smoke script is not part of the automated test suite because
its result depends on the user's endpoint, API key, model access, quota, and
rate limits.

## 17. Known Limitations

- Only non-streaming text chat completions are supported.
- Only the OpenAI-compatible provider adapter exists.
- There is no policy engine or guardrail enforcement.
- There is no request or response transformation.
- There are no retries, fallbacks, or routing decisions.
- Tool calls and multimodal messages are rejected or unsupported.
- Provider-specific `400`, `404`, and `5xx` response details are sanitized into
  `MODEL_UPSTREAM_ERROR`.
- `/health` checks process liveness, not provider credentials or readiness.
- Requests, responses, lifecycle events, and usage are not persisted.
- The gateway does not authenticate its own callers.
- Browser CORS support is not configured in this milestone.

## 18. Guardrail Boundary for Future Work

No guardrail behavior has been added implicitly. The current extension points
for later milestones are:

- Validated and normalized `ChatRequest` before `provider_started`.
- Normalized `ChatResponse` after `provider_completed`.
- The provider-neutral `ModelProvider` boundary for routing or fallback.
- Lifecycle events for policy-decision observability.

Future policy stages should be added explicitly and versioned without changing
the behavior documented here for requests that are allowed unchanged.
