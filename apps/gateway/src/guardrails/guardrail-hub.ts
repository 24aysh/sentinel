import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";
import { evaluateInput } from "./input/input-evaluator.ts";
import type {
  GuardrailHub,
  InputGuardrailResult,
  LoadedGuardrailPolicy,
  OutputGuardrailResult,
} from "./types.ts";

function repairRequest(
  request: ChatRequest,
  invalidContent: string,
  schema: unknown,
  prompt = "Correct the previous response so it satisfies the JSON Schema.",
): ChatRequest {
  return {
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: invalidContent },
      {
        role: "user",
        content: `${prompt}\n\nJSON Schema:\n${JSON.stringify(schema)}\n\nReturn only the corrected JSON value without Markdown or commentary.`,
      },
    ],
  };
}

export class ConfiguredGuardrailHub implements GuardrailHub {
  readonly identity;
  readonly runtimeFailureMode;
  readonly maximumAttempts;

  constructor(private readonly policy: LoadedGuardrailPolicy) {
    this.identity = policy.identity;
    this.runtimeFailureMode = policy.defaults.runtimeFailureMode;
    this.maximumAttempts =
      policy.output?.onFailure.type === "retry"
        ? policy.output.onFailure.maximumRetries + 1
        : 1;
  }

  async evaluateInput(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<InputGuardrailResult> {
    return evaluateInput(request, this.policy);
  }

  async evaluateOutput(
    request: ChatRequest,
    response: ChatResponse,
    _context: RequestContext,
    attempt: number,
  ): Promise<OutputGuardrailResult> {
    const output = this.policy.output;
    if (!output) {
      return { decision: "allow" };
    }

    const invalid = response.choices.find(({ message }) => {
      try {
        return !output.validator.validate(JSON.parse(message.content.trim()));
      } catch {
        return true;
      }
    });
    if (!invalid) return { decision: "allow" };

    if (
      output.onFailure.type === "retry" &&
      attempt <= output.onFailure.maximumRetries
    ) {
      return {
        decision: "retry",
        ruleId: output.id,
        repairRequest: repairRequest(
          request,
          invalid.message.content,
          output.schema,
          output.onFailure.repairPrompt,
        ),
      };
    }

    return { decision: "block", ruleId: output.id };
  }
}
