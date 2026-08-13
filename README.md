# LLM Gateway

This Bun workspace contains:

- `apps/gateway`: an in-process TypeScript SDK with PII, prompt-injection, and
  JSON Schema guardrails;
- `apps/model`: the sealed local ONNX prompt-injection artifact; and
- `apps/frontend`: the frontend application.

Install dependencies from the repository root:

```bash
bun install
```

Run repository checks:

```bash
bun run build
bun run lint
bun run check-types
```

Gateway-specific setup, policy configuration, tests, and smoke commands are
documented in [`apps/gateway/README.md`](apps/gateway/README.md).
