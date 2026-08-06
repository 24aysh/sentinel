# Gateway SDK Development

- Use Bun for repository commands, scripts, and tests.
- Keep `src/index.ts` side-effect-free.
- Do not add a listener, inbound HTTP transport, or server framework.
- Keep production SDK modules compatible with Node.js 20+.
- Prefer cross-runtime Node standard-library APIs in production code.
- Keep model providers, guardrails, loggers, and lifecycle listeners injectable.
- Keep domain request and response types provider-neutral.
- Preserve the single `gateway.chat.completions.create()` operation.
- Do not duplicate pipeline, retry, policy, or provider logic in the facade.
- Run `bun test`, `bun run check-types`, and `bun run check:package` before completion.
