import { describe, expect, test } from "bun:test";
import { ConfigurationError, loadConfig } from "../src/config/env.ts";

describe("loadConfig", () => {
  test("loads documented defaults", () => {
    expect(loadConfig({})).toEqual({
      host: "0.0.0.0",
      port: 3001,
      modelProvider: "openai-compatible",
      modelBaseUrl: "https://api.openai.com/v1",
      modelApiKey: undefined,
      defaultModel: "gpt-4.1-mini",
      modelTimeoutMs: 30_000,
      guardrailPolicyPath: undefined,
      debugExposeProviderRequest: false,
    });
  });

  test("loads explicit values and permits a missing API key", () => {
    expect(
      loadConfig({
        GATEWAY_HOST: "127.0.0.1",
        GATEWAY_PORT: "8080",
        MODEL_PROVIDER: "openai-compatible",
        MODEL_BASE_URL: "http://localhost:11434/v1/",
        MODEL_DEFAULT: "local-model",
        MODEL_TIMEOUT_MS: "1200",
        GUARDRAIL_POLICY_PATH: " policies/test.yaml ",
        GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST: " TRUE ",
      }),
    ).toMatchObject({
      host: "127.0.0.1",
      port: 8080,
      modelBaseUrl: "http://localhost:11434/v1",
      modelApiKey: undefined,
      defaultModel: "local-model",
      modelTimeoutMs: 1200,
      guardrailPolicyPath: "policies/test.yaml",
      debugExposeProviderRequest: true,
    });
  });

  test.each([
    [{ GATEWAY_PORT: "0" }, "GATEWAY_PORT"],
    [{ MODEL_TIMEOUT_MS: "not-a-number" }, "MODEL_TIMEOUT_MS"],
    [{ MODEL_BASE_URL: "file:///tmp/model" }, "MODEL_BASE_URL"],
    [{ MODEL_PROVIDER: "unknown" }, "MODEL_PROVIDER"],
    [
      { GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST: "yes" },
      "GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST",
    ],
  ])("rejects invalid configuration", (env, expectedName) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError);
    expect(() => loadConfig(env)).toThrow(expectedName);
  });
});
