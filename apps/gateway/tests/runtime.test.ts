import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { GatewayConfig } from "../src/config/env.ts";
import { silentLogger } from "../src/observability/logger.ts";
import { createRuntime } from "../src/runtime.ts";

function config(guardrailPolicyPath?: string): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    modelProvider: "openai-compatible",
    modelBaseUrl: "http://models.example.test/v1",
    defaultModel: "test-model",
    modelTimeoutMs: 1_000,
    guardrailPolicyPath,
    debugExposeProviderRequest: false,
  };
}

describe("createRuntime", () => {
  test("preserves an unconfigured guardrail boundary", async () => {
    const runtime = await createRuntime(config(), silentLogger);

    expect(runtime.gateway.chat.completions.create).toBeFunction();
    expect(runtime.guardrails).toBeUndefined();
    expect(runtime.policy).toBeUndefined();
  });

  test("loads and composes the configured policy", async () => {
    const policyPath = resolve(
      import.meta.dir,
      "../policies/example-policy.yaml",
    );
    const runtime = await createRuntime(config(policyPath), silentLogger);

    expect(runtime.guardrails?.identity).toEqual({
      name: "gateway-e2e",
      version: 1,
    });
    expect(runtime.policy?.output?.id).toBe("require-gateway-check-response");
  });

  test("loads a disabled policy without composing guardrails", async () => {
    const policyPath = resolve(
      import.meta.dir,
      "fixtures/disabled-policy.yaml",
    );
    const runtime = await createRuntime(config(policyPath), silentLogger);

    expect(runtime.policy?.enabled).toBe(false);
    expect(runtime.policy?.identity.name).toBe("disabled-test-policy");
    expect(runtime.guardrails).toBeUndefined();

    const response = await runtime.app.handle(
      new Request("http://gateway.test/health"),
    );
    expect(response.status).toBe(200);
  });
});
