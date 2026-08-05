# LLM Gateway

A Bun and TypeScript service that accepts chat-completion requests, runs them
through a fixed lifecycle, forwards them to an OpenAI-compatible model API, and
returns a normalized response.

This is the gateway's initial milestone. It deliberately does not implement
guardrails, policy enforcement, prompt or response transformation, retries,
streaming, tool calls, or multi-provider routing yet.

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

Set `GATEWAY_URL` if the gateway is not running at `http://localhost:3001`.

## Current limitations

- Chat completions are text-only and non-streaming.
- Only an OpenAI-compatible upstream adapter is included.
- There are no guardrails or policy decisions in this version.
- The gateway does not retry or route failed requests.
- Requests and lifecycle events are not persisted.
