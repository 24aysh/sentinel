# Project Initialization: Basic LLM Gateway

## 1. Objective

Build the first working version of the model-agnostic LLM gateway described in
`00_project.md`.

This milestone establishes the gateway's foundational request pipeline. The
gateway must accept a chat-completion request, validate and normalize it, send
it to a configured model provider, normalize the provider response, and return
that response to the caller.

This milestone is concerned only with proving that the gateway and its fixed
lifecycle work correctly. It must not implement policy evaluation, guardrails,
prompt transformation, response transformation, retries, model routing, or
escalation.

The implementation must use TypeScript and Bun, and should use Elysia as the
HTTP framework already included in the gateway package.

## 2. Scope

### 2.1 In scope

- A health endpoint for checking whether the gateway is running.
- A non-streaming chat-completions endpoint.
- Runtime validation of incoming HTTP requests.
- Conversion from the public HTTP request into provider-neutral domain types.
- A fixed and observable request lifecycle.
- A provider-neutral `ModelProvider` interface.
- One OpenAI-compatible HTTP provider implementation using native `fetch`.
- Environment-based provider and server configuration.
- Request IDs, stage timings, and safe structured logs.
- Consistent, sanitized gateway error responses.
- Unit tests for the pipeline and provider adapter.
- In-process HTTP integration tests.
- A deterministic pipeline test script that needs no API key.
- A real-provider smoke-test script.
- A `.env.example` and updated gateway documentation.

### 2.2 Out of scope

Do not implement any of the following in this milestone:

- Guardrails or policy enforcement.
- Policy configuration or policy storage.
- Prompt or response modification.
- Automatic retries.
- Provider fallback or multi-model routing.
- Human escalation.
- Streaming responses.
- Tool or function calls.
- Image, audio, or other multimodal inputs.
- Embeddings or retrieval pipelines.
- Request, response, or lifecycle persistence.
- Authentication for callers of the gateway.
- Usage billing or quota enforcement.

Unsupported features must be rejected clearly rather than accepted and
silently ignored.

## 3. Public HTTP API

### 3.1 `GET /health`

This endpoint confirms that the gateway process is available. It must not call
the configured model provider.

Successful response:

```json
{
  "status": "ok",
  "service": "llm-gateway",
  "version": "0.1.0"
}
```

Response status: `200 OK`.

### 3.2 `POST /v1/chat/completions`

The initial public request format is a small, explicitly supported subset of
the OpenAI chat-completions contract. The gateway owns this contract even when
the configured upstream is also OpenAI-compatible.

Example request:

```json
{
  "model": "optional-model-name",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Explain dependency injection."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 500,
  "stream": false
}
```

#### Supported request fields

| Field                | Required | Rules                                               |
| -------------------- | -------- | --------------------------------------------------- |
| `model`              | No       | Non-empty string. Use `MODEL_DEFAULT` when omitted. |
| `messages`           | Yes      | Non-empty array of supported chat messages.         |
| `messages[].role`    | Yes      | One of `system`, `user`, or `assistant`.            |
| `messages[].content` | Yes      | Non-empty string.                                   |
| `temperature`        | No       | Number from `0` through `2`.                        |
| `max_tokens`         | No       | Positive integer.                                   |
| `stream`             | No       | May be absent or `false`; `true` is unsupported.    |

Tool-call fields, multimodal message content, and unknown features that alter
request semantics must not be forwarded as arbitrary pass-through data.

Example successful response:

```json
{
  "id": "chatcmpl-provider-id",
  "object": "chat.completion",
  "created": 1785900000,
  "model": "configured-model",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Dependency injection is..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 60,
    "total_tokens": 85
  }
}
```

Every response from this endpoint must include:

- `x-request-id`: the request identifier used by the gateway.
- `x-gateway-duration-ms`: total gateway processing time in milliseconds.

## 4. Internal Architecture

The transport, pipeline, and provider must be separate layers.

```text
HTTP request
    |
    v
Elysia route and request validation
    |
    v
HTTP-to-domain normalization
    |
    v
GatewayPipeline
    |-- RequestContext
    |-- LifecycleTracker
    |-- ModelProvider
    |
    v
OpenAI-compatible provider adapter
    |
    v
Configured upstream model API
```

The gateway pipeline must operate on provider-neutral domain types. It must not
import Elysia types or depend on OpenAI-specific request types.

The provider adapter is responsible for translating between gateway domain
types and the upstream API. A future provider should be addable by implementing
the same `ModelProvider` interface without changing the pipeline or routes.

## 5. Proposed File Structure

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
|   |-- pipeline/
|   |   |-- gateway-pipeline.ts
|   |   `-- lifecycle.ts
|   |-- providers/
|   |   |-- model-provider.ts
|   |   `-- openai-compatible-provider.ts
|   |-- transport/
|   |   `-- http/
|   |       |-- schemas.ts
|   |       `-- error-response.ts
|   `-- observability/
|       `-- logger.ts
|-- tests/
|   |-- gateway-pipeline.test.ts
|   |-- openai-compatible-provider.test.ts
|   |-- app.test.ts
|   `-- helpers/
|       `-- fake-provider.ts
|-- scripts/
|   |-- test-pipeline.ts
|   `-- smoke.ts
|-- .env.example
|-- package.json
|-- tsconfig.json
`-- README.md
```

### 5.1 Entry point and dependency composition

`index.ts` must remain a small executable entry point. Its responsibilities are
limited to loading the runtime configuration, composing the application, and
starting the server.

`src/runtime.ts` will construct the concrete logger, provider, pipeline, and
application. Dependency construction must not happen as hidden module-level
side effects.

`src/app.ts` will create the Elysia application without listening on a network
port. This makes it possible for integration tests to call `app.handle()` using
an injected fake provider.

## 6. Domain Contracts

### 6.1 Chat messages and requests

The transport request uses snake_case where required for API compatibility. It
must be normalized into an internal camelCase request before entering the
pipeline.

The internal types should be equivalent to:

```ts
type ChatRole = "system" | "user" | "assistant";

interface ChatMessage {
  role: ChatRole;
  content: string;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}
```

The internal response must represent the supported successful completion
contract, including completion choices and optional usage information. It must
not expose raw provider response objects to the pipeline.

### 6.2 Request context

Every pipeline execution must receive a context containing at least:

```ts
interface RequestContext {
  requestId: string;
  startedAt: number;
  model: string;
}
```

When an incoming request contains a valid `x-request-id`, it may be preserved.
Otherwise, the gateway must generate one using `crypto.randomUUID()`.

The accepted caller-provided request ID should have a conservative maximum
length and character set so arbitrary header content is not copied into logs.

### 6.3 Provider port

The pipeline must depend on an interface equivalent to:

```ts
interface ModelProvider {
  complete(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<ChatResponse>;
}
```

This interface is the boundary between the gateway lifecycle and concrete
model APIs.

## 7. Fixed Gateway Lifecycle

A successful request must move through the following lifecycle stages in
order:

1. `received`
   - The route accepted the request.
   - A request ID and start timestamp were established.

2. `validated`
   - The public request passed runtime validation.
   - The default model was applied when necessary.
   - The request was converted into its normalized domain form.

3. `provider_started`
   - The pipeline began the call to `ModelProvider.complete()`.
   - Provider timing began.

4. `provider_completed`
   - The upstream call succeeded.
   - The provider response was parsed and normalized.

5. `completed`
   - The final public response was ready to return.
   - Total gateway duration was recorded.

If processing fails after the request has been accepted, the lifecycle must
record `failed` once. The failure event should include the stable gateway error
code and the stage at which processing failed, but not prompt content or raw
provider data.

Lifecycle tracking must be observational in this milestone. It must not change
the request, block content, or perform a policy decision.

## 8. Configuration

Bun automatically loads `.env`; do not add `dotenv`.

Create `.env.example` with:

```dotenv
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=3001

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_DEFAULT=gpt-4.1-mini
MODEL_TIMEOUT_MS=30000
```

Configuration requirements:

- `GATEWAY_PORT` must be a valid TCP port.
- `MODEL_PROVIDER` must equal a supported provider identifier.
- `MODEL_BASE_URL` must be a valid HTTP or HTTPS URL.
- `MODEL_DEFAULT` must be a non-empty string.
- `MODEL_TIMEOUT_MS` must be a positive integer.
- `MODEL_API_KEY` may be empty for local OpenAI-compatible services.
- Invalid configuration must fail fast at application startup with a readable
  error that does not reveal secrets.

## 9. OpenAI-Compatible Provider

The first concrete provider must use native `fetch`; no provider SDK is needed.

Its responsibilities are:

1. Safely build the `/chat/completions` URL from `MODEL_BASE_URL`.
2. Set JSON request headers.
3. Add `Authorization: Bearer ...` only when `MODEL_API_KEY` exists.
4. Convert `maxTokens` into `max_tokens` and map other supported fields.
5. Send the normalized messages without changing their contents or order.
6. Apply `MODEL_TIMEOUT_MS` using an abort signal.
7. Parse successful JSON responses.
8. Validate the minimum response structure needed by the gateway.
9. Convert the upstream response into the gateway's `ChatResponse`.
10. Convert network, timeout, status, JSON, and response-shape failures into
    stable gateway errors.

The adapter should accept an injectable `fetch` implementation or equivalent
dependency so its tests never make real network requests.

## 10. Error Contract

All errors returned by the chat endpoint must use the same public shape:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "messages must contain at least one item",
    "request_id": "gateway-request-id"
  }
}
```

Use the following initial error mapping:

| Situation                        | HTTP status | Error code                    |
| -------------------------------- | ----------: | ----------------------------- |
| Invalid JSON or request schema   |         400 | `INVALID_REQUEST`             |
| Unsupported streaming or feature |         400 | `UNSUPPORTED_FEATURE`         |
| Upstream rate limit              |         429 | `MODEL_RATE_LIMITED`          |
| Upstream request timeout         |         504 | `MODEL_TIMEOUT`               |
| Upstream credential rejection    |         502 | `MODEL_AUTHENTICATION_FAILED` |
| Malformed successful response    |         502 | `INVALID_MODEL_RESPONSE`      |
| Network or upstream 5xx failure  |         502 | `MODEL_UPSTREAM_ERROR`        |
| Unexpected gateway failure       |         500 | `INTERNAL_ERROR`              |

Do not return provider authorization data, complete upstream error bodies,
stack traces, or internal exception messages to callers.

When the upstream returns `Retry-After` for a rate limit, the gateway may copy a
validated version of that header to its response.

## 11. Observability

Create a small logger abstraction so production uses structured console output
and tests can inject a silent or capturing logger.

Example lifecycle log:

```json
{
  "level": "info",
  "event": "gateway.lifecycle",
  "requestId": "gateway-request-id",
  "stage": "provider_completed",
  "model": "gpt-4.1-mini",
  "durationMs": 642
}
```

Logs may contain:

- Request ID.
- Lifecycle stage.
- Selected model name.
- HTTP status.
- Gateway and provider duration.
- Stable error code.

Logs must not contain:

- Prompt or message content.
- Model response content.
- API keys.
- Authorization headers.
- Complete request or response bodies.

## 12. Automated Tests

Use `bun test` and the APIs from `bun:test`.

### 12.1 Pipeline unit tests

Use an injected fake `ModelProvider` and verify that the pipeline:

- Calls the provider exactly once for a successful request.
- Forwards all messages in their original order.
- Forwards supported optional parameters correctly.
- Uses the resolved model.
- Returns the normalized provider response.
- Does not apply a policy decision or content transformation.
- Produces the expected lifecycle stage order.
- Generates a request ID when needed.
- Preserves a valid caller-provided request ID.
- Records `failed` when the provider throws.
- Does not mutate the caller's request object.

### 12.2 Provider adapter tests

Use an injected fake `fetch` and verify:

- Correct upstream URL construction.
- Correct JSON and authorization headers.
- Omission of authorization when no key is configured.
- Correct mapping of all supported request fields.
- Valid successful response normalization.
- Mapping of upstream `401` or `403` failures.
- Mapping of upstream `429` failures.
- Mapping of upstream `5xx` failures.
- Handling of invalid JSON.
- Handling of a structurally invalid successful response.
- Handling of network failure.
- Handling of timeout or abort.

### 12.3 HTTP integration tests

Construct the production Elysia application with a fake provider and call
`app.handle()` in memory. Verify:

- `GET /health` returns `200` and does not call the provider.
- A valid chat request traverses the HTTP and pipeline layers.
- The configured default model is used when `model` is absent.
- The response contains `x-request-id`.
- The response contains `x-gateway-duration-ms`.
- Missing or empty messages return `400`.
- Empty message content returns `400`.
- Unsupported roles return `400`.
- `stream: true` returns `400` with `UNSUPPORTED_FEATURE`.
- A provider timeout returns the documented `504` response.
- An unexpected provider failure returns a sanitized response.

No automated test may require a real API key or make a real provider request.

## 13. Verification Scripts

### 13.1 `scripts/test-pipeline.ts`

This script must import and execute the production `GatewayPipeline` with a
deterministic fake provider. It must not recreate the pipeline logic.

The script should:

1. Create a fake provider with a known response.
2. Submit a sample system and user message through the real pipeline.
3. Capture lifecycle events.
4. Check that stages occurred in the documented order.
5. Check that the provider received the expected request.
6. Check that the response returned unchanged from the normalized provider
   result.
7. Print a concise success summary.
8. Exit with a non-zero status when an assertion fails.

This script must work without a server, network connection, `.env`, or API key.

### 13.2 `scripts/smoke.ts`

This script performs a real end-to-end HTTP check against a running gateway.

It should:

1. Read `GATEWAY_URL`, defaulting to `http://localhost:3001`.
2. Send a small request to `/v1/chat/completions`.
3. Verify the HTTP status and minimum response structure.
4. Print the request ID, model, gateway duration, and assistant answer.
5. Print a useful sanitized error for failed responses.
6. Exit with a non-zero status on failure.

This is the only verification path expected to use the user's real provider
configuration.

## 14. Package Scripts

Add the following gateway package scripts:

```json
{
  "scripts": {
    "dev": "bun --watch index.ts",
    "start": "bun index.ts",
    "test": "bun test",
    "test:pipeline": "bun scripts/test-pipeline.ts",
    "smoke": "bun scripts/smoke.ts",
    "check-types": "bunx tsc --noEmit",
    "build": "bun build index.ts --outdir dist --target bun"
  }
}
```

Remove dependencies that are not usable by or required for the Elysia/Bun
implementation. In particular, do not use Express middleware in this backend.

## 15. Documentation

Update `apps/gateway/README.md` with:

- The purpose and current limitations of the gateway.
- Requirements and Bun installation expectations.
- Environment-variable documentation.
- Local development commands.
- Health and chat API examples using `curl`.
- Instructions for running automated tests.
- Instructions for running both verification scripts.
- A short architecture and lifecycle explanation.
- A clear statement that guardrails are not included yet.

## 16. Implementation Order

Implement this milestone in the following order:

1. Add domain request, response, context, and error types.
2. Add configuration parsing and validation.
3. Define the `ModelProvider` interface.
4. Implement the OpenAI-compatible provider and its tests.
5. Implement lifecycle tracking.
6. Implement `GatewayPipeline` and its unit tests.
7. Implement the Elysia application and error serialization.
8. Add HTTP integration tests.
9. Add `test-pipeline.ts` and `smoke.ts`.
10. Add package scripts and `.env.example`.
11. Update the gateway README.
12. Run all required verification commands.

## 17. Required Verification

Before considering the milestone complete, run:

```bash
bun test
bun run test:pipeline
bun run check-types
bun run build
```

The real-provider smoke test should be run after the user creates a local
`.env`:

```bash
bun run start
bun run smoke
```

## 18. Acceptance Criteria

This milestone is complete only when all of the following are true:

- The gateway starts successfully with valid configuration.
- `GET /health` returns the documented response.
- A valid chat request reaches an OpenAI-compatible model and returns a valid
  answer.
- The default model is used when a request does not specify one.
- Every accepted request follows the documented fixed lifecycle.
- The pipeline depends on `ModelProvider`, not on a concrete provider.
- The pipeline has no Elysia dependency.
- No guardrail, policy decision, or content transformation is applied.
- All public errors follow the documented sanitized format.
- Prompts, completions, and secrets do not appear in operational logs.
- Unit and integration tests require no network access or API key.
- The deterministic pipeline script passes locally.
- The real smoke script is ready for use with the user's `.env`.
- Tests, type checking, and the Bun build pass.
- Setup, usage, lifecycle, and limitations are documented.
