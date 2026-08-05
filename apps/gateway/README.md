# LLM Gateway

A Bun and TypeScript service that accepts chat-completion requests, applies an
optional YAML guardrail policy, forwards allowed requests to an
OpenAI-compatible model API, validates model output, and returns a normalized
response.

The current policy version supports deterministic email, phone-number, and
credit-card input handling plus JSON Schema output validation and bounded
repair retries. Streaming, tool calls, multimodal content, external detectors,
and multi-provider routing are not implemented yet.

## Requirements

- Bun 1.3 or newer.
- An OpenAI-compatible model endpoint for real model requests.
- An API key if the configured endpoint requires one.

## Setup

Install workspace dependencies from the repository root:

```bash
bun install
```

Create the gateway environment file:

```bash
cd apps/gateway
cp .env.example .env
```

Configure the model endpoint and credentials in `.env`:

```dotenv
GATEWAY_HOST=0.0.0.0
GATEWAY_PORT=3001

MODEL_PROVIDER=openai-compatible
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_DEFAULT=gpt-4.1-mini
MODEL_TIMEOUT_MS=30000

# Optional. Remove this line to run without guardrails.
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml

# Local debugging only. Normal API responses remain unchanged when false.
GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=false
```

`MODEL_API_KEY` may be blank for a local service that does not require bearer
authentication. Do not commit the real `.env` file.

## Running the gateway

Development mode with file watching:

```bash
bun run dev
```

Run without file watching:

```bash
bun run start
```

The default address is `http://localhost:3001`.

The checked-in `policies/example-policy.yaml` redacts supported PII and requires
the model response to match
`policies/schemas/gateway-check-response.json`. Policy and schema files are
loaded and validated once during startup.

### Turn guardrails on or off

The sample policy has one top-level switch:

```yaml
enabled: true
```

Set it to `false` and restart the gateway to load and validate the YAML without
attaching any guardrails. Requests then use the original single-provider-call
lifecycle. Set it back to `true` and restart to enforce the configured input and
output rules.

The `smoke:guardrails` command succeeds when the sample policy is enabled. With
the policy disabled, its synthetic email is not redacted by the gateway, so the
script reports that the guardrail behavior was not observed.

### Inspect the post-guardrail provider request

For local debugging, set this in `.env` and restart the gateway:

```dotenv
GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true
```

The standard `smoke.ts` script sends the required
`x-gateway-debug-provider-request: true` header. Its output shows the normalized
request that reached the first provider call after input guardrails, followed by
the assistant response. This makes the difference visible: with guardrails on,
the message contains `<EMAIL>`; with guardrails off, it contains the original
email.

Both the server setting and request header are required. Keep the server setting
disabled outside local development because the debug response contains prompt
content.

## API

### Health

```bash
curl http://localhost:3001/health
```

Example response:

```json
{
  "status": "ok",
  "service": "llm-gateway",
  "version": "0.1.0"
}
```

### Chat completion

```bash
curl --request POST http://localhost:3001/v1/chat/completions \
  --header 'content-type: application/json' \
  --header 'x-request-id: local-example' \
  --data '{
    "messages": [
      {"role": "system", "content": "Be concise."},
      {"role": "user", "content": "What is dependency injection?"}
    ],
    "temperature": 0.2,
    "max_tokens": 200,
    "stream": false
  }'
```

Supported message roles are `system`, `user`, and `assistant`. The optional
request fields are `model`, `temperature`, `max_tokens`, and `stream: false`.
Streaming and unknown feature fields are rejected.

Successful chat responses include `x-request-id` and
`x-gateway-duration-ms` headers.

Errors use a stable JSON shape:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Request body failed validation.",
    "request_id": "..."
  }
}
```

## Lifecycle

Every successful chat request follows these stages:

```text
received
  -> validated
  -> provider_started
  -> provider_completed
  -> completed
```

A request that fails after being accepted records `failed`, along with the
stage at which it stopped. Lifecycle records contain operational metadata only;
prompts and model responses are not logged.

When a policy is configured, input and output guardrail stages are inserted
around provider calls. An invalid output may add a bounded repair attempt.
Policy logs include rule IDs and decisions but never include detected values,
prompt content, or completion content.

The HTTP layer, gateway pipeline, and provider adapter are separate. The
pipeline depends on the provider-neutral `ModelProvider` interface rather than
the OpenAI-compatible implementation.

## Tests and verification

Run the automated test suite:

```bash
bun test
```

Run the production pipeline with a deterministic fake provider. This needs no
server, network connection, `.env`, or API key:

```bash
bun run test:pipeline
```

Run the deterministic PII-redaction and output-retry check:

```bash
bun run test:guardrails
```

Check TypeScript and build the Bun executable bundle:

```bash
bun run check-types
bun run build
```

After configuring `.env` and starting the gateway, run the real-provider smoke
test in a second terminal:

```bash
bun run smoke
```

When provider-request debugging is enabled, this prints the post-input-guardrail
provider request before printing the assistant response.

Set `GATEWAY_URL` if the gateway is not running at `http://localhost:3001`.

To run the one-request end-to-end guardrail check, start the gateway with the
sample policy configured and then invoke the guardrail smoke script:

```bash
GUARDRAIL_POLICY_PATH=policies/example-policy.yaml bun run start
```

In a second terminal:

```bash
bun run smoke:guardrails
```

The script sends a synthetic email address, verifies that the returned JSON
contains the redacted `<EMAIL>` value required by the sample schema, and prints
the assistant JSON response. The client makes exactly one gateway request.

## Current limitations

- Chat completions are text-only and non-streaming.
- Only an OpenAI-compatible upstream adapter is included.
- Guardrails are limited to local PII detection and JSON Schema output
  validation.
- Policies are loaded at startup and do not hot reload.
- The gateway does not route requests to fallback providers.
- Requests and lifecycle events are not persisted.
