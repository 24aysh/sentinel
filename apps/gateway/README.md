# LLM Gateway SDK

A TypeScript-first, in-process model gateway. Applications instantiate
`ModelGateway`, optionally load YAML guardrails, and call a provider-neutral
chat-completion API directly. The package does not start or expose an HTTP
server.

The input guardrail detects emails, phone numbers, IP addresses, API keys,
JWTs, private keys, AWS/Google/Azure credentials, credit cards, and database
connection strings. It combines bounded patterns with structural validation;
cards use Luhn checks and generic secrets require contextual labels and entropy.
IBANs and national identifiers are not included yet. Output guardrails provide
strict JSON Schema validation and bounded repair retries.

## Requirements

- Bun 1.3+ or Node.js 20+ for the built SDK.
- Bun 1.3+ for repository scripts and tests.
- An OpenAI-compatible model endpoint for real-provider requests.
- An API key when the configured endpoint requires one.

## Setup

Install workspace dependencies from the repository root:

```bash
bun install
```

The package is currently private and unpublished. Build and validate it before
linking it into another project:

```bash
cd apps/gateway
bun run build
bun run check:package
```

The supported package entry is `@llm-gateway/sdk`.

## Quick start

```ts
import { ModelGateway, OpenAICompatibleProvider } from "@llm-gateway/sdk";

const gateway = await ModelGateway.create({
  provider: new OpenAICompatibleProvider({
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.MODEL_API_KEY,
    timeoutMs: 30_000,
  }),
  defaultModel: "gpt-4.1-mini",
  policyPath: "./policies/example-policy.yaml",
});

const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.response.choices[0]?.message.content);
```

The canonical operation is:

```ts
gateway.chat.completions.create(input, options);
```

SDK inputs use camel case, including `maxTokens`.

## Construction modes

Use `ModelGateway.create()` to load an optional YAML policy once:

```ts
const gateway = await ModelGateway.create({
  provider,
  defaultModel: "model-name",
  policyPath: "policies/example-policy.yaml",
  policyWorkingDirectory: process.cwd(),
});
```

Omit `policyPath` to run without guardrails. A policy with `enabled: false` is
loaded and validated but is not attached to the gateway.

Use the synchronous constructor when dependencies are already created:

```ts
const gateway = new ModelGateway({
  provider: customProvider,
  defaultModel: "custom-model",
  guardrails: customGuardrailHub,
  logger: applicationLogger,
  lifecycleListener: applicationListener,
});
```

The constructor performs no file or network I/O.

## Result and errors

Each successful call returns:

```ts
interface GatewayExecutionResult {
  response: ChatResponse;
  providerRequest: ChatRequest;
  context: RequestContext;
  durationMs: number;
  lifecycle: readonly LifecycleEvent[];
}
```

`providerRequest` is the request sent to the first provider call after input
guardrails. It may contain prompt data, so do not log or persist it in production
without an explicit privacy decision.

Direct failures reject with `GatewayError`:

```ts
try {
  await gateway.chat.completions.create(input);
} catch (error) {
  if (error instanceof GatewayError) {
    console.error(error.code, error.message);
  }
}
```

Configuration and policy-loading failures use `ConfigurationError`. SDK logging
is silent by default; inject `ConsoleLogger` or a custom `Logger` to opt in.

## Guardrail policy switch

The example policy has one top-level switch:

```yaml
enabled: true
```

- Omitted or `true`: configured guardrails are enforced.
- `false`: the policy is validated but prompts and responses bypass guardrails.
- No `policyPath`: no policy file is loaded.

The checked-in policy redacts all supported input entities. Its optional output
schema rule is included as a commented example.

Input rules use these entity names:

```yaml
entities:
  - EMAIL
  - PHONE_NUMBER
  - IP_ADDRESS
  - API_KEY
  - JWT
  - PRIVATE_KEY
  - CLOUD_CREDENTIAL
  - CREDIT_CARD
  - DATABASE_CONNECTION_STRING
```

Detection is local and structural; it does not verify whether a credential is
active, validate JWT signatures, or classify output. Credential formats are
intentionally bounded to distinctive API-key prefixes, contextual generic
secrets, AWS access keys, Google API keys/service-account key IDs, Azure Storage
keys/SAS tokens, supported PEM keys, and common database URI/SQL Server DSNs.

## Lifecycle

A successful call without guardrails records:

```text
received
validated
provider_started
provider_completed
completed
```

Policy-backed calls add input and output guardrail stages. An invalid output can
add a bounded repair attempt. Lifecycle records contain operational metadata,
not complete prompt or response content.

## Tests and verification

Run the automated suite and type checker:

```bash
bun test
bun run check-types
```

The retained deterministic testing scripts now use `ModelGateway` through the
public SDK entry:

```bash
bun run test:pipeline
bun run test:guardrails
```

`test:pipeline` verifies the no-policy class path. `test:guardrails` verifies
YAML loading, expanded PII redaction, usage, and lifecycle events through
`ModelGateway.create()`.

Build the package and run external TypeScript, Bun, Node, clean-artifact, and
side-effect checks:

```bash
bun run check:package
```

No deterministic test requires a listener, API key, or network connection.

## Real-provider SDK smoke

Copy and configure the example environment:

```bash
cp .env.example .env
```

Then run:

```bash
bun run smoke:sdk
```

The script constructs `ModelGateway` directly, prints the original prompt,
sends one request, prints the first provider request after input guardrails,
prints the assistant response, and reports request ID and duration.

With `GUARDRAIL_POLICY_PATH=policies/example-policy.yaml` and `enabled: true`,
the provider request contains `<EMAIL>`. Compare it with the no-policy path:

```bash
GUARDRAIL_POLICY_PATH= bun run smoke:sdk
```

The second request contains the original synthetic email. No local gateway
server should be started for either command.

## Current limitations

- The package is private and not published to a registry.
- Chat completions are text-only and non-streaming.
- Only an OpenAI-compatible provider adapter is included.
- Guardrails are limited to local PII detection and JSON Schema validation.
- Policies are loaded during construction and do not hot reload.
- There is no provider routing or fallback.
- Browser and edge runtimes are not supported.
- Prompts, responses, and lifecycle events are not persisted.
- The package does not include an HTTP server or remote HTTP client.
