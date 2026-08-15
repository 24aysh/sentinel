import type {
  ChatRequest,
  ChatResponse,
  FunctionToolCall,
} from "../../domain/chat.ts";
import { GatewayError } from "../../domain/errors.ts";
import type {
  ToolArgumentMatcher,
  ToolArgumentValue,
  ToolPolicy,
  ToolPolicyRule,
} from "../types.ts";
import { ToolSchemaRegistry } from "./tool-schema-validator.ts";

type UnknownRecord = Record<string, unknown>;

export interface ToolDefinitionFilterResult {
  request: ChatRequest;
  allowedDefinitionCount: number;
  blockedDefinitionCount: number;
  ruleIds: string[];
}

interface ToolCallCounts {
  allowedCallCount: number;
  blockedCallCount: number;
  ruleIds: string[];
}

export type ToolCallEvaluationResult =
  | (ToolCallCounts & {
      decision: "allow" | "filter";
      response: ChatResponse;
    })
  | (ToolCallCounts & { decision: "block" });

export type ChatResponseMode = "text" | "tool_calls";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function invalidRequest(message: string): never {
  throw new GatewayError("INVALID_REQUEST", message, 400);
}

function invalidResponse(): never {
  throw new GatewayError(
    "INVALID_MODEL_RESPONSE",
    "The model provider returned an invalid tool-call response.",
    502,
  );
}

function matchingNameRules(
  toolName: string,
  policy: ToolPolicy,
): ToolPolicyRule[] {
  return policy.rules.filter((rule) => rule.toolNames.includes(toolName));
}

function definitionDecision(
  toolName: string,
  policy: ToolPolicy,
): { action: "allow" | "block"; ruleIds: string[] } {
  const matching = matchingNameRules(toolName, policy).filter(
    (rule) => rule.arguments === undefined,
  );
  const blocks = matching.filter((rule) => rule.action === "block");
  if (blocks.length > 0) {
    return { action: "block", ruleIds: blocks.map(({ id }) => id) };
  }
  const allows = matching.filter((rule) => rule.action === "allow");
  return allows.length > 0
    ? { action: "allow", ruleIds: allows.map(({ id }) => id) }
    : { action: policy.defaultAction, ruleIds: [] };
}

export function filterToolDefinitions(
  request: ChatRequest,
  policy: ToolPolicy,
): ToolDefinitionFilterResult {
  if (!request.tools) {
    return {
      request,
      allowedDefinitionCount: 0,
      blockedDefinitionCount: 0,
      ruleIds: [],
    };
  }

  const ruleIds = new Set<string>();
  const tools = request.tools.filter(({ function: callable }) => {
    const result = definitionDecision(callable.name, policy);
    for (const id of result.ruleIds) ruleIds.add(id);
    return result.action === "allow";
  });

  if (request.toolChoice === "required" && tools.length === 0) {
    invalidRequest("The configured tool policy blocks every required tool.");
  }
  const forcedChoice =
    typeof request.toolChoice === "object" ? request.toolChoice : undefined;
  if (
    forcedChoice &&
    !tools.some(
      ({ function: callable }) => callable.name === forcedChoice.function.name,
    )
  ) {
    invalidRequest("The configured tool policy blocks the forced tool.");
  }

  const { tools: _tools, parallelToolCalls, ...withoutTools } = request;
  const sanitizedRequest: ChatRequest =
    tools.length > 0
      ? {
          ...withoutTools,
          tools,
          ...(parallelToolCalls !== undefined && { parallelToolCalls }),
        }
      : {
          ...withoutTools,
          toolChoice: "none",
        };

  return {
    request: sanitizedRequest,
    allowedDefinitionCount: tools.length,
    blockedDefinitionCount: request.tools.length - tools.length,
    ruleIds: [...ruleIds].sort(),
  };
}

function normalizeString(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

function valueAtPath(root: UnknownRecord, path: readonly string[]): unknown {
  let value: unknown = root;
  for (const segment of path) {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as UnknownRecord)[segment];
  }
  return value;
}

function equals(candidate: unknown, expected: ToolArgumentValue): boolean {
  return typeof candidate === "string" && typeof expected === "string"
    ? normalizeString(candidate) === normalizeString(expected)
    : candidate === expected;
}

function matchesArgument(
  argumentsValue: UnknownRecord,
  matcher: ToolArgumentMatcher,
): boolean {
  const candidate = valueAtPath(argumentsValue, matcher.path);
  if (candidate === undefined) return false;
  if (matcher.operator === "equals") {
    return matcher.values.some((expected) => equals(candidate, expected));
  }
  return (
    typeof candidate === "string" &&
    matcher.values.some(
      (expected) =>
        typeof expected === "string" &&
        normalizeString(candidate).includes(normalizeString(expected)),
    )
  );
}

function matchesCallRule(
  toolName: string,
  argumentsValue: UnknownRecord,
  rule: ToolPolicyRule,
): boolean {
  return (
    rule.toolNames.includes(toolName) &&
    (rule.arguments === undefined ||
      rule.arguments.every((matcher) =>
        matchesArgument(argumentsValue, matcher),
      ))
  );
}

function callDecision(
  call: FunctionToolCall,
  argumentsValue: UnknownRecord,
  policy: ToolPolicy | undefined,
): { action: "allow" | "block"; ruleIds: string[] } {
  if (!policy) return { action: "allow", ruleIds: [] };
  const matching = policy.rules.filter((rule) =>
    matchesCallRule(call.function.name, argumentsValue, rule),
  );
  const blocks = matching.filter((rule) => rule.action === "block");
  if (blocks.length > 0) {
    return { action: "block", ruleIds: blocks.map(({ id }) => id) };
  }
  const allows = matching.filter((rule) => rule.action === "allow");
  return allows.length > 0
    ? { action: "allow", ruleIds: allows.map(({ id }) => id) }
    : { action: policy.defaultAction, ruleIds: [] };
}

export function classifyChatResponse(response: ChatResponse): ChatResponseMode {
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    invalidResponse();
  }
  for (const choice of response.choices) {
    if (
      choice.message.role !== "assistant" ||
      (choice.message.toolCalls !== undefined &&
        choice.message.toolCalls.length === 0) ||
      (choice.message.content === null && !choice.message.toolCalls)
    ) {
      invalidResponse();
    }
  }
  const toolChoiceCount = response.choices.filter(
    ({ message }) => (message.toolCalls?.length ?? 0) > 0,
  ).length;
  if (toolChoiceCount === 0) return "text";
  if (toolChoiceCount !== response.choices.length) invalidResponse();
  return "tool_calls";
}

export function evaluateToolCalls(
  requestSentToProvider: ChatRequest,
  response: ChatResponse,
  schemas: ToolSchemaRegistry,
  policy?: ToolPolicy,
): ToolCallEvaluationResult {
  const offeredNames = new Set(
    requestSentToProvider.tools?.map(({ function: callable }) => callable.name),
  );
  const callIds = new Set<string>();
  const ruleIds = new Set<string>();
  let allowedCallCount = 0;
  let blockedCallCount = 0;

  const choices = response.choices.flatMap((choice) => {
    const calls = choice.message.toolCalls;
    if (!calls || calls.length === 0) invalidResponse();
    const allowedCalls = calls.filter((call) => {
      if (
        typeof call !== "object" ||
        call === null ||
        typeof call.id !== "string" ||
        call.id.length === 0 ||
        call.id.length > 256 ||
        call.type !== "function" ||
        typeof call.function !== "object" ||
        call.function === null ||
        typeof call.function.name !== "string" ||
        !TOOL_NAME_PATTERN.test(call.function.name) ||
        typeof call.function.arguments !== "string" ||
        !offeredNames.has(call.function.name) ||
        callIds.has(call.id)
      ) {
        invalidResponse();
      }
      callIds.add(call.id);
      const argumentsValue = schemas.validateResponseCall(call);
      const decision = callDecision(call, argumentsValue, policy);
      for (const id of decision.ruleIds) ruleIds.add(id);
      if (decision.action === "block") {
        blockedCallCount += 1;
        return false;
      }
      allowedCallCount += 1;
      return true;
    });
    return allowedCalls.length > 0
      ? [
          {
            ...choice,
            message: { ...choice.message, toolCalls: allowedCalls },
          },
        ]
      : [];
  });

  const counts = {
    allowedCallCount,
    blockedCallCount,
    ruleIds: [...ruleIds].sort(),
  };
  if (allowedCallCount === 0) return { decision: "block", ...counts };
  return {
    decision: blockedCallCount > 0 ? "filter" : "allow",
    response: { ...response, choices },
    ...counts,
  };
}
