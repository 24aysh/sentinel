import { describe, expect, test } from "bun:test";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { ConfigurationError, ModelGateway } from "../src/index.ts";
import { createTestPolicy } from "./helpers/guardrail-policy.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";
import { RecordingLogger } from "./helpers/recording-logger.ts";

describe("ModelGateway SDK", () => {
  test("constructs stable resources and completes through an injected provider", async () => {
    const provider = new FakeProvider();
    const gateway = new ModelGateway({
      provider,
      defaultModel: " default-model ",
    });

    expect(gateway.chat).toBe(gateway.chat);
    expect(gateway.chat.completions).toBe(gateway.chat.completions);

    const result = await gateway.chat.completions.create(
      { messages: [{ role: "user", content: "Hello" }] },
      { requestId: "sdk-request-1" },
    );

    expect(provider.calls).toHaveLength(1);
    expect(result.context.requestId).toBe("sdk-request-1");
    expect(result.providerRequest.model).toBe("default-model");
    expect(result.response.choices[0]?.message.content).toBe("Test response");
    expect(result.lifecycle.map(({ stage }) => stage)).toEqual([
      "received",
      "validated",
      "provider_started",
      "provider_completed",
      "completed",
    ]);
  });

  test("rejects an empty default model during synchronous construction", () => {
    expect(
      () =>
        new ModelGateway({
          provider: new FakeProvider(),
          defaultModel: "   ",
        }),
    ).toThrow(ConfigurationError);
  });

  test("accepts custom guardrails through dependency injection", async () => {
    const provider = new FakeProvider();
    const gateway = new ModelGateway({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          input: [
            {
              id: "redact-email",
              detector: "pii",
              entities: ["EMAIL"],
              action: { type: "redact" },
            },
          ],
        }),
      ),
    });

    const result = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "Email sdk@example.com" }],
    });

    expect(result.providerRequest.messages[0]?.content).toBe("Email <EMAIL>");
  });

  test("creates a no-policy gateway without file access or guardrail stages", async () => {
    const provider = new FakeProvider();
    const gateway = await ModelGateway.create({
      provider,
      defaultModel: "test-model",
    });

    const result = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "No policy" }],
    });

    expect(provider.calls).toHaveLength(1);
    expect(result.lifecycle.map(({ stage }) => stage)).toEqual([
      "received",
      "validated",
      "provider_started",
      "provider_completed",
      "completed",
    ]);
  });

  test("rejects an unused prompt-injection model path", async () => {
    await expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        promptInjectionModelPath: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    await expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        policyPath: "fixtures/sdk-enabled-policy.yaml",
        policyWorkingDirectory: import.meta.dir,
        promptInjectionModelPath: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  test("requires a model path for an enabled prompt-injection rule", async () => {
    await expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        policyPath: "fixtures/sdk-prompt-injection-policy.yaml",
        policyWorkingDirectory: import.meta.dir,
      }),
    ).rejects.toThrow(
      "promptInjectionModelPath is required by the enabled prompt_injection policy rule.",
    );
  });

  test("loads an enabled relative YAML policy once and logs only metadata", async () => {
    const provider = new FakeProvider();
    const logger = new RecordingLogger();
    const gateway = await ModelGateway.create({
      provider,
      defaultModel: "test-model",
      policyPath: "fixtures/sdk-enabled-policy.yaml",
      policyWorkingDirectory: import.meta.dir,
      logger,
    });

    const first = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "Email first@example.com" }],
    });
    const second = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "Email second@example.com" }],
    });

    expect(first.providerRequest.messages[0]?.content).toBe("Email <EMAIL>");
    expect(second.providerRequest.messages[0]?.content).toBe("Email <EMAIL>");
    const policyLogs = logger.records.filter(
      ({ event }) => event === "gateway.guardrail_policy_loaded",
    );
    expect(policyLogs).toEqual([
      expect.objectContaining({
        policyName: "sdk-test-policy",
        policyVersion: 1,
        enabled: true,
        inputRuleCount: 1,
        outputRuleCount: 0,
      }),
    ]);
    expect(JSON.stringify(policyLogs)).not.toContain("first@example.com");
  });

  test("validates but does not apply a disabled YAML policy", async () => {
    const provider = new FakeProvider();
    const gateway = await ModelGateway.create({
      provider,
      defaultModel: "test-model",
      policyPath: "fixtures/disabled-policy.yaml",
      policyWorkingDirectory: import.meta.dir,
      promptInjectionModelPath: "does-not-exist",
    });

    const result = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "Email unchanged@example.com" }],
    });

    expect(result.providerRequest.messages[0]?.content).toBe(
      "Email unchanged@example.com",
    );
    expect(result.lifecycle.map(({ stage }) => stage)).not.toContain(
      "input_guardrails_started",
    );
  });

  test("rejects invalid policy configuration through the async factory", () => {
    expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        policyPath: "fixtures/missing-policy.yaml",
        policyWorkingDirectory: import.meta.dir,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  test("logs a sanitized malformed output schema rejection", async () => {
    const logger = new RecordingLogger();

    await expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        policyPath: "fixtures/invalid-output-schema-policy.yaml",
        policyWorkingDirectory: import.meta.dir,
        logger,
      }),
    ).rejects.toMatchObject({
      name: "InvalidOutputSchemaConfigurationError",
      message:
        "GUARDRAIL_POLICY_PATH contains an invalid or unsupported output schema.",
    });

    expect(logger.records).toEqual([
      {
        event: "gateway.guardrail_policy_rejected",
        phase: "startup",
        reasonCode: "invalid_output_schema",
      },
    ]);
    expect(JSON.stringify(logger.records)).not.toContain("invalid-output");
  });

  test("does not let a throwing logger mask a malformed schema", async () => {
    await expect(
      ModelGateway.create({
        provider: new FakeProvider(),
        defaultModel: "test-model",
        policyPath: "fixtures/invalid-output-schema-policy.yaml",
        policyWorkingDirectory: import.meta.dir,
        logger: {
          info() {},
          error() {
            throw new Error("logger failed");
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "InvalidOutputSchemaConfigurationError",
      message:
        "GUARDRAIL_POLICY_PATH contains an invalid or unsupported output schema.",
    });
  });

  test("keeps concurrent request context and lifecycle state isolated", async () => {
    const gateway = new ModelGateway({
      provider: new FakeProvider(),
      defaultModel: "test-model",
    });

    const [first, second] = await Promise.all([
      gateway.chat.completions.create(
        { messages: [{ role: "user", content: "First" }] },
        { requestId: "sdk-concurrent-1" },
      ),
      gateway.chat.completions.create(
        { messages: [{ role: "user", content: "Second" }] },
        { requestId: "sdk-concurrent-2" },
      ),
    ]);

    expect(first.context.requestId).toBe("sdk-concurrent-1");
    expect(second.context.requestId).toBe("sdk-concurrent-2");
    expect(
      first.lifecycle.every(
        ({ requestId }) => requestId === "sdk-concurrent-1",
      ),
    ).toBe(true);
    expect(
      second.lifecycle.every(
        ({ requestId }) => requestId === "sdk-concurrent-2",
      ),
    ).toBe(true);
  });
});
