import type { ChatResponse } from "../../domain/chat.ts";
import type { OutputViolationType } from "../types.ts";

export const MAX_OUTPUT_CONTENT_LENGTH = 1_000_000;
export const OVERSIZED_OUTPUT_REPAIR_MARKER =
  "[Previous model response omitted because it exceeded the output guardrail limit.]";

interface OutputValidator {
  validate(value: unknown): boolean;
}

export type OutputEvaluation =
  | { valid: true }
  | {
      valid: false;
      invalidContent: string;
      violationType: OutputViolationType;
    };

function evaluateContent(
  content: string,
  validator: OutputValidator,
): OutputEvaluation {
  if (content.length > MAX_OUTPUT_CONTENT_LENGTH) {
    return {
      valid: false,
      invalidContent: OVERSIZED_OUTPUT_REPAIR_MARKER,
      violationType: "output_too_large",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(content.trim());
  } catch {
    return {
      valid: false,
      invalidContent: content,
      violationType: "invalid_json",
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      valid: false,
      invalidContent: content,
      violationType: "non_object",
    };
  }

  return validator.validate(value)
    ? { valid: true }
    : {
        valid: false,
        invalidContent: content,
        violationType: "schema_mismatch",
      };
}

export function evaluateOutputChoices(
  response: ChatResponse,
  validator: OutputValidator,
): OutputEvaluation {
  for (const choice of response.choices) {
    if (choice.message.content === null) {
      return {
        valid: false,
        invalidContent: "",
        violationType: "invalid_json",
      };
    }
    const result = evaluateContent(choice.message.content, validator);
    if (!result.valid) return result;
  }
  return { valid: true };
}
