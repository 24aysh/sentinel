import type {
  ChatRequest,
  FunctionToolCall,
  FunctionToolDefinition,
} from "../../domain/chat.ts";
import { GatewayError } from "../../domain/errors.ts";
import { CompiledJsonSchemaValidator } from "../output/json-schema-validator.ts";

const MAX_SCHEMA_LENGTH = 100_000;
const MAX_SCHEMA_DEPTH = 32;
const MAX_ARGUMENT_LENGTH = 1_000_000;
const FORBIDDEN_REFERENCE_PREFIXES = ["http://", "https://", "file:"];

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): never {
  throw new GatewayError("INVALID_REQUEST", message, 400);
}

function invalidResponse(): never {
  throw new GatewayError(
    "INVALID_MODEL_RESPONSE",
    "The model provider returned an invalid tool call.",
    502,
  );
}

function validateSchemaNode(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): void {
  if (depth > MAX_SCHEMA_DEPTH) invalidRequest("Tool schemas are too deep.");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidRequest("Tool schemas must be JSON.");
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    invalidRequest("Tool schemas must be finite JSON values.");
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateSchemaNode(item, depth + 1, ancestors);
    ancestors.delete(value);
    return;
  }

  const schema = value as UnknownRecord;
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    const reference = schema[keyword];
    if (
      typeof reference === "string" &&
      FORBIDDEN_REFERENCE_PREFIXES.some((prefix) =>
        reference.toLowerCase().startsWith(prefix),
      )
    ) {
      invalidRequest("Tool schemas cannot use external references.");
    }
  }

  if (schema.type === "object") {
    if (!isRecord(schema.properties) || schema.additionalProperties !== false) {
      invalidRequest(
        "Every object in a strict tool schema must declare properties and additionalProperties false.",
      );
    }
    if (!Array.isArray(schema.required)) {
      invalidRequest(
        "Every object in a strict tool schema must require every property.",
      );
    }
    const required = schema.required;
    const properties = Object.keys(schema.properties);
    if (
      required.some((item) => typeof item !== "string") ||
      new Set(required).size !== required.length ||
      properties.length !== required.length ||
      properties.some((property) => !required.includes(property))
    ) {
      invalidRequest(
        "Every object in a strict tool schema must require every property exactly once.",
      );
    }
  }

  for (const item of Object.values(schema)) {
    validateSchemaNode(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function compile(definition: FunctionToolDefinition) {
  validateSchemaNode(definition.function.parameters);
  let serialized: string;
  try {
    serialized = JSON.stringify(definition.function.parameters);
  } catch {
    invalidRequest("Tool schemas must be serializable JSON.");
  }
  if (serialized.length > MAX_SCHEMA_LENGTH) {
    invalidRequest("Tool schemas must not exceed 100000 characters.");
  }
  try {
    return new CompiledJsonSchemaValidator(definition.function.parameters);
  } catch {
    invalidRequest("Tool schemas must be valid strict JSON Schemas.");
  }
}

function parseArguments(argumentsJson: string, requestSide: boolean): unknown {
  if (argumentsJson.length > MAX_ARGUMENT_LENGTH) {
    return requestSide
      ? invalidRequest("Tool call arguments exceed the supported size.")
      : invalidResponse();
  }
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    return requestSide
      ? invalidRequest("Tool call arguments must contain valid JSON.")
      : invalidResponse();
  }
  if (!isRecord(value)) {
    return requestSide
      ? invalidRequest("Tool call arguments must contain a JSON object.")
      : invalidResponse();
  }
  return value;
}

export class ToolSchemaRegistry {
  private readonly validators = new Map<string, CompiledJsonSchemaValidator>();

  constructor(definitions: readonly FunctionToolDefinition[] = []) {
    for (const definition of definitions) {
      this.validators.set(definition.function.name, compile(definition));
    }
  }

  validateRequestHistory(request: ChatRequest): void {
    for (const message of request.messages) {
      if (message.role !== "assistant" || !message.toolCalls) continue;
      for (const call of message.toolCalls) this.validateRequestCall(call);
    }
  }

  validateResponseCall(call: FunctionToolCall): UnknownRecord {
    const validator = this.validators.get(call.function.name);
    if (!validator) invalidResponse();
    const value = parseArguments(call.function.arguments, false);
    if (!validator.validate(value)) invalidResponse();
    return value as UnknownRecord;
  }

  private validateRequestCall(call: FunctionToolCall): void {
    const validator = this.validators.get(call.function.name);
    if (!validator) {
      invalidRequest("Historical tool calls must reference a supplied tool.");
    }
    const value = parseArguments(call.function.arguments, true);
    if (!validator.validate(value)) {
      invalidRequest("Historical tool call arguments do not match the schema.");
    }
  }
}
