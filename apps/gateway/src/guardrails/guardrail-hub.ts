import type { ChatRequest, ChatResponse } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";
import { evaluatePiiInput } from "./input/input-evaluator.ts";
import type { PromptInjectionClassifier } from "./input/prompt-injection-classifier.ts";
import type {
  GuardrailHub,
  InputDetectorType,
  InputGuardrailResult,
  LoadedGuardrailPolicy,
  OutputGuardrailResult,
  PromptInjectionInputPolicyRule,
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

  constructor(
    private readonly policy: LoadedGuardrailPolicy,
    private readonly promptInjectionClassifier?: PromptInjectionClassifier,
  ) {
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
    const piiResult = evaluatePiiInput(request, this.policy);
    if (piiResult.decision === "block") return piiResult;

    const rules = this.policy.input.filter(
      (rule): rule is PromptInjectionInputPolicyRule =>
        rule.detector === "prompt_injection",
    );
    if (rules.length === 0) return piiResult;
    if (!this.promptInjectionClassifier) {
      throw new Error("Prompt-injection classifier was not configured.");
    }

    const selectedRoles = new Set(rules.flatMap((rule) => rule.roles));
    const selectedMessages = piiResult.request.messages.flatMap(
      (message, messageIndex) =>
        selectedRoles.has(message.role)
          ? [{ messageIndex, role: message.role, content: message.content }]
          : [],
    );
    if (selectedMessages.length === 0) return piiResult;

    let classification;
    try {
      classification =
        await this.promptInjectionClassifier.classify(selectedMessages);
      if (classification.decision === "detected") {
        const selected = new Set(
          selectedMessages.map(
            ({ messageIndex, role }) => `${messageIndex}:${role}`,
          ),
        );
        const findingIndexes = new Set<number>();
        for (const finding of classification.findings) {
          if (
            !selected.has(`${finding.messageIndex}:${finding.role}`) ||
            findingIndexes.has(finding.messageIndex)
          ) {
            throw new Error(
              "Prompt-injection classifier returned invalid findings.",
            );
          }
          findingIndexes.add(finding.messageIndex);
        }
      }
    } catch (error) {
      if (this.runtimeFailureMode === "closed") throw error;
      return {
        ...piiResult,
        detectorTypes: mergeDetectorTypes(
          piiResult.detectorTypes,
          "prompt_injection",
        ),
        failedDetectorTypes: ["prompt_injection"],
        promptInjectionModelId:
          this.promptInjectionClassifier.identity.artifactId,
      };
    }

    const classifierMetadata = {
      detectorTypes: mergeDetectorTypes(
        piiResult.detectorTypes,
        "prompt_injection",
      ),
      promptInjectionModelId:
        this.promptInjectionClassifier.identity.artifactId,
      evaluatedMessageCount: classification.evaluatedMessageCount,
      evaluatedWindowCount: classification.evaluatedWindowCount,
    };
    if (classification.decision === "allow") {
      return { ...piiResult, ...classifierMetadata };
    }
    if (classification.decision === "limit_exceeded") {
      return {
        decision: "block",
        findingCount: piiResult.findingCount,
        ruleIds: [
          ...new Set([...piiResult.ruleIds, ...rules.map(({ id }) => id)]),
        ],
        entityTypes: piiResult.entityTypes,
        ...classifierMetadata,
      };
    }

    const resolved = classification.findings.map((finding) => ({
      finding,
      rule: rules.find((rule) => rule.roles.includes(finding.role))!,
    }));
    const metadata = {
      findingCount: piiResult.findingCount + resolved.length,
      ruleIds: [
        ...new Set([
          ...piiResult.ruleIds,
          ...resolved.map(({ rule }) => rule.id),
        ]),
      ],
      entityTypes: piiResult.entityTypes,
      ...classifierMetadata,
    };
    return resolved.some(({ rule }) => rule.action.type === "block")
      ? { decision: "block", ...metadata }
      : { ...piiResult, ...metadata };
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

function mergeDetectorTypes(
  current: readonly InputDetectorType[] | undefined,
  next: InputDetectorType,
): InputDetectorType[] {
  return [...new Set([...(current ?? []), next])];
}
