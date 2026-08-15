import { describe, expect, test } from "bun:test";
import type {
  ChatResponse,
  FunctionToolDefinition,
} from "../src/domain/chat.ts";
import { ConfiguredGuardrailHub } from "../src/guardrails/guardrail-hub.ts";
import { GatewayPipeline } from "../src/pipeline/gateway-pipeline.ts";
import { FakeProvider, sampleChatResponse } from "./helpers/fake-provider.ts";
import { createTestPolicy } from "./helpers/guardrail-policy.ts";
import { RecordingLogger } from "./helpers/recording-logger.ts";

const tools: FunctionToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      strict: true,
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

const providerResponse: ChatResponse = {
  id: "chatcmpl-tool-pipeline",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Pune"}',
            },
          },
          {
            id: "call_shell",
            type: "function",
            function: {
              name: "run_shell",
              arguments: '{"command":":(){ :|:& };:"}',
            },
          },
        ],
      },
      finishReason: "tool_calls",
    },
  ],
};

describe("tool-guardrail GatewayPipeline", () => {
  test("returns only allowed calls and reports filtering", async () => {
    const provider = new FakeProvider(providerResponse);
    const logger = new RecordingLogger();
    const guardrails = new ConfiguredGuardrailHub(
      createTestPolicy({
        tools: {
          defaultAction: "allow",
          rules: [
            {
              id: "block-fork-bomb",
              toolNames: ["run_shell"],
              action: "block",
              arguments: [
                {
                  path: ["command"],
                  operator: "equals",
                  values: [":(){ :|:& };:"],
                },
              ],
            },
          ],
        },
      }),
    );
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails,
      logger,
    });

    const result = await pipeline.execute({
      messages: [{ role: "user", content: "Use both tools" }],
      tools,
    });

    expect(
      result.response.choices[0]?.message.toolCalls?.map(
        (call) => call.function.name,
      ),
    ).toEqual(["get_weather"]);
    expect(result.toolGuardrails).toEqual({
      decision: "filter",
      allowedCallCount: 1,
      blockedCallCount: 1,
      ruleIds: ["block-fork-bomb"],
    });
    expect(result.lifecycle.map(({ stage }) => stage)).toContain(
      "tool_calls_guardrails_completed",
    );
    expect(result.lifecycle.map(({ stage }) => stage)).not.toContain(
      "output_guardrails_started",
    );

    let weatherExecutions = 0;
    let shellExecutions = 0;
    const registry = new Map<string, () => void>([
      ["get_weather", () => (weatherExecutions += 1)],
      ["run_shell", () => (shellExecutions += 1)],
    ]);
    for (const call of result.response.choices[0]?.message.toolCalls ?? []) {
      registry.get(call.function.name)?.();
    }
    expect(weatherExecutions).toBe(1);
    expect(shellExecutions).toBe(0);
    expect(JSON.stringify(logger.records)).not.toContain(":(){ :|:& };:");
  });

  test("removes a name-blocked definition before provider execution", async () => {
    const weatherOnlyResponse = structuredClone(providerResponse);
    weatherOnlyResponse.choices[0]!.message.toolCalls = [
      providerResponse.choices[0]!.message.toolCalls![0]!,
    ];
    const provider = new FakeProvider(weatherOnlyResponse);
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          tools: {
            defaultAction: "allow",
            rules: [
              {
                id: "block-shell",
                toolNames: ["run_shell"],
                action: "block",
              },
            ],
          },
        }),
      ),
    });

    const result = await pipeline.execute({
      messages: [{ role: "user", content: "Weather" }],
      tools,
    });

    expect(
      provider.calls[0]?.request.tools?.map((tool) => tool.function.name),
    ).toEqual(["get_weather"]);
    expect(
      result.providerRequest.tools?.map((tool) => tool.function.name),
    ).toEqual(["get_weather"]);
  });

  test("rejects a forced blocked tool without calling the provider", async () => {
    const provider = new FakeProvider(providerResponse);
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          tools: {
            defaultAction: "allow",
            rules: [
              {
                id: "block-shell",
                toolNames: ["run_shell"],
                action: "block",
              },
            ],
          },
        }),
      ),
    });

    await expect(
      pipeline.execute({
        messages: [{ role: "user", content: "Run it" }],
        tools,
        toolChoice: {
          type: "function",
          function: { name: "run_shell" },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(provider.calls).toHaveLength(0);
  });

  test("throws when every returned call is blocked", async () => {
    const shellOnlyResponse = structuredClone(providerResponse);
    shellOnlyResponse.choices[0]!.message.toolCalls = [
      providerResponse.choices[0]!.message.toolCalls![1]!,
    ];
    const pipeline = new GatewayPipeline({
      provider: new FakeProvider(shellOnlyResponse),
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          tools: {
            defaultAction: "allow",
            rules: [
              {
                id: "block-fork-bomb",
                toolNames: ["run_shell"],
                action: "block",
                arguments: [
                  {
                    path: ["command"],
                    operator: "equals",
                    values: [":(){ :|:& };:"],
                  },
                ],
              },
            ],
          },
        }),
      ),
    });

    await expect(
      pipeline.execute({
        messages: [{ role: "user", content: "Run it" }],
        tools,
      }),
    ).rejects.toMatchObject({
      code: "TOOL_GUARDRAIL_BLOCKED",
      status: 502,
    });
  });

  test("accepts a sanitized tool call and result on the continuation request", async () => {
    const provider = new FakeProvider(sampleChatResponse);
    const pipeline = new GatewayPipeline({
      provider,
      defaultModel: "test-model",
    });

    await pipeline.execute({
      messages: [
        { role: "user", content: "Weather" },
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_weather",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Pune"}',
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_weather",
          content: '{"temperature":25}',
        },
      ],
      tools: [tools[0]!],
      toolChoice: "none",
    });

    expect(provider.calls[0]?.request.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "call_weather",
      content: '{"temperature":25}',
    });
  });

  test("validates tool arguments even when no policy is configured", async () => {
    const invalidResponse = structuredClone(providerResponse);
    invalidResponse.choices[0]!.message.toolCalls = [
      {
        id: "call_weather",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":25}',
        },
      },
    ];
    const pipeline = new GatewayPipeline({
      provider: new FakeProvider(invalidResponse),
      defaultModel: "test-model",
    });

    await expect(
      pipeline.execute({
        messages: [{ role: "user", content: "Weather" }],
        tools: [tools[0]!],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_MODEL_RESPONSE",
      status: 502,
    });
  });

  test("still applies the output schema when a tool-enabled turn returns text", async () => {
    const textResponse = structuredClone(sampleChatResponse);
    textResponse.choices[0]!.message.content = '{"status":"ok"}';
    const pipeline = new GatewayPipeline({
      provider: new FakeProvider(textResponse),
      defaultModel: "test-model",
      guardrails: new ConfiguredGuardrailHub(
        createTestPolicy({
          output: {
            schema: {
              type: "object",
              properties: { status: { const: "ok" } },
              required: ["status"],
              additionalProperties: false,
            },
            onFailure: { type: "block" },
          },
        }),
      ),
    });

    const result = await pipeline.execute({
      messages: [{ role: "user", content: "Answer or use weather" }],
      tools: [tools[0]!],
    });

    expect(result.lifecycle.map(({ stage }) => stage)).toContain(
      "output_guardrails_completed",
    );
    expect(result.toolGuardrails).toBeUndefined();
  });
});
