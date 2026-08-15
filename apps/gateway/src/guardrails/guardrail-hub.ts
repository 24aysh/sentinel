import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";
import { evaluateConfiguredInput } from "./input/input-evaluation-coordinator.ts";
import type { PromptInjectionClassifier } from "./input/prompt-injection-classifier.ts";
import { evaluateOutputChoices } from "./output/output-evaluator.ts";
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
        content: `${prompt}\n\nJSON Schema:\n${JSON.stringify(schema)}\n\nReturn only the corrected JSON object without Markdown or commentary.`,
      },
    ],
  };
}

export class ConfiguredGuardrailHub implements GuardrailHub {
  readonly identity;
  readonly runtimeFailureMode;
  readonly maximumAttempts;
  readonly outputJsonSchema;
  readonly toolPolicy;

  constructor(
    private readonly policy: LoadedGuardrailPolicy,
    private readonly promptInjectionClassifier?: PromptInjectionClassifier,
  ) {
    this.identity = policy.identity;
    this.runtimeFailureMode = policy.defaults.runtimeFailureMode;
    this.toolPolicy = policy.tools;
    this.maximumAttempts =
      policy.output?.onFailure.type === "retry"
        ? policy.output.onFailure.maximumRetries + 1
        : 1;
    this.outputJsonSchema = policy.output
      ? {
          name: `guardrail_${policy.output.id}`
            .replace(/[^A-Za-z0-9_-]/g, "_")
            .slice(0, 64),
          schema: policy.output.schema,
          strict: true as const,
        }
      : undefined;
  }

  async evaluateInput(
    request: ChatRequest,
    _context: RequestContext,
  ): Promise<InputGuardrailResult> {
    return evaluateConfiguredInput(
      request,
      this.policy,
      this.promptInjectionClassifier,
    );
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

    const evaluation = evaluateOutputChoices(response, output.validator);
    if (evaluation.valid) return { decision: "allow" };

    if (
      output.onFailure.type === "retry" &&
      attempt <= output.onFailure.maximumRetries
    ) {
      return {
        decision: "retry",
        ruleId: output.id,
        violationType: evaluation.violationType,
        repairRequest: repairRequest(
          request,
          evaluation.invalidContent,
          output.schema,
          output.onFailure.repairPrompt,
        ),
      };
    }

    return {
      decision: "block",
      ruleId: output.id,
      violationType: evaluation.violationType,
    };
  }
}
