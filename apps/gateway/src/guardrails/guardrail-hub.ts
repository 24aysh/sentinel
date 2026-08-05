import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";
import { InputPolicyEvaluator } from "./input/input-evaluator.ts";
import { createRepairRequest } from "./retry/repair-request.ts";
import type {
  GuardrailHub,
  InputGuardrailResult,
  LoadedGuardrailPolicy,
  OutputGuardrailResult,
} from "./types.ts";

export class ConfiguredGuardrailHub implements GuardrailHub {
  readonly identity;
  readonly runtimeFailureMode;
  readonly maximumAttempts;

  private readonly inputEvaluator: InputPolicyEvaluator;

  constructor(private readonly policy: LoadedGuardrailPolicy) {
    this.identity = policy.identity;
    this.runtimeFailureMode = policy.defaults.runtimeFailureMode;
    this.maximumAttempts =
      policy.output?.onFailure.type === "retry"
        ? policy.output.onFailure.maximumRetries + 1
        : 1;
    this.inputEvaluator = new InputPolicyEvaluator(policy);
  }

  async evaluateInput(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<InputGuardrailResult> {
    return this.inputEvaluator.evaluate(request);
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

    let invalidContent: string | undefined;
    for (const choice of response.choices) {
      let value: unknown;
      try {
        value = JSON.parse(choice.message.content.trim());
      } catch {
        invalidContent = choice.message.content;
        break;
      }

      if (!output.validator.validate(value)) {
        invalidContent = choice.message.content;
        break;
      }
    }

    if (invalidContent === undefined) {
      return { decision: "allow" };
    }

    if (
      output.onFailure.type === "retry" &&
      attempt <= output.onFailure.maximumRetries
    ) {
      return {
        decision: "retry",
        ruleId: output.id,
        repairRequest: createRepairRequest(
          request,
          invalidContent,
          output.schema,
          output.onFailure.repairPrompt,
        ),
      };
    }

    return { decision: "block", ruleId: output.id };
  }
}
