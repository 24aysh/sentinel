import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ChatResponse,
  FunctionToolDefinition,
} from "../src/domain/chat.ts";
import {
  evaluateToolCalls,
  filterToolDefinitions,
} from "../src/guardrails/tools/tool-call-evaluator.ts";
import { ToolSchemaRegistry } from "../src/guardrails/tools/tool-schema-validator.ts";
import type { ToolPolicy } from "../src/guardrails/types.ts";

const weather: FunctionToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get weather for a city",
    strict: true,
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
};

const shell: FunctionToolDefinition = {
  type: "function",
  function: {
    name: "run_shell",
    description: "Run a command",
    strict: true,
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

function request(): ChatRequest {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "Check the weather" }],
    tools: [weather, shell],
  };
}

function response(
  calls: Array<{ id: string; name: string; arguments: string }>,
): ChatResponse {
  return {
    id: "chatcmpl-tools",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          toolCalls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        },
        finishReason: "tool_calls",
      },
    ],
  };
}

describe("tool-call guardrail evaluator", () => {
  test("removes name-blocked definitions before the provider call", () => {
    const policy: ToolPolicy = {
      defaultAction: "allow",
      rules: [
        {
          id: "block-shell",
          toolNames: ["run_shell"],
          action: "block",
        },
      ],
    };

    const result = filterToolDefinitions(request(), policy);

    expect(result.request.tools?.map((tool) => tool.function.name)).toEqual([
      "get_weather",
    ]);
    expect(result).toMatchObject({
      allowedDefinitionCount: 1,
      blockedDefinitionCount: 1,
      ruleIds: ["block-shell"],
    });
  });

  test("keeps allowed calls and filters an argument-blocked call", () => {
    const original = request();
    const policy: ToolPolicy = {
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
    };
    const providerResponse = response([
      { id: "call_weather", name: "get_weather", arguments: '{"city":"Pune"}' },
      {
        id: "call_shell",
        name: "run_shell",
        arguments: '{"command":":(){ :|:& };:"}',
      },
    ]);

    const result = evaluateToolCalls(
      original,
      providerResponse,
      new ToolSchemaRegistry(original.tools),
      policy,
    );

    expect(result).toMatchObject({
      decision: "filter",
      allowedCallCount: 1,
      blockedCallCount: 1,
      ruleIds: ["block-fork-bomb"],
    });
    if (result.decision !== "block") {
      expect(
        result.response.choices[0]?.message.toolCalls?.map(
          (call) => call.function.name,
        ),
      ).toEqual(["get_weather"]);
    }
    expect(providerResponse.choices[0]?.message.toolCalls).toHaveLength(2);
  });

  test("fails closed when every returned call is blocked", () => {
    const original = request();
    const result = evaluateToolCalls(
      original,
      response([
        {
          id: "call_shell",
          name: "run_shell",
          arguments: '{"command":"blocked"}',
        },
      ]),
      new ToolSchemaRegistry(original.tools),
      {
        defaultAction: "block",
        rules: [],
      },
    );

    expect(result).toEqual({
      decision: "block",
      allowedCallCount: 0,
      blockedCallCount: 1,
      ruleIds: [],
    });
  });

  test("rejects unoffered tools and schema-invalid arguments", () => {
    const original = request();
    const schemas = new ToolSchemaRegistry(original.tools);

    expect(() =>
      evaluateToolCalls(
        original,
        response([{ id: "call_unknown", name: "unknown", arguments: "{}" }]),
        schemas,
      ),
    ).toThrow();
    expect(() =>
      evaluateToolCalls(
        original,
        response([
          {
            id: "call_weather",
            name: "get_weather",
            arguments: '{"city":4}',
          },
        ]),
        schemas,
      ),
    ).toThrow();
  });
});
