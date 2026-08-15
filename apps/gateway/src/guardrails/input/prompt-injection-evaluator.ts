import type { ChatRequest } from "../../domain/chat.ts";
import type { PromptInjectionClassifier } from "./prompt-injection-classifier.ts";
import type {
  LoadedGuardrailPolicy,
  PromptInjectionInputPolicyRule,
} from "../types.ts";

export type PromptInjectionInputResult =
  | { status: "skipped" }
  | {
      status: "evaluated";
      decision: "allow" | "block";
      findingCount: number;
      ruleIds: string[];
      promptInjectionModelId: string;
      evaluatedMessageCount: number;
      evaluatedWindowCount: number;
    };

export function promptInjectionRules(
  policy: LoadedGuardrailPolicy,
): PromptInjectionInputPolicyRule[] {
  return policy.input.filter(
    (rule): rule is PromptInjectionInputPolicyRule =>
      rule.detector === "prompt_injection",
  );
}

export async function evaluatePromptInjectionInput(
  request: ChatRequest,
  rules: readonly PromptInjectionInputPolicyRule[],
  classifier: PromptInjectionClassifier,
): Promise<PromptInjectionInputResult> {
  const selectedRoles = new Set(rules.flatMap((rule) => rule.roles));
  const selectedMessages = request.messages.flatMap((message, messageIndex) =>
    selectedRoles.has(message.role) && typeof message.content === "string"
      ? [{ messageIndex, role: message.role, content: message.content }]
      : [],
  );
  if (selectedMessages.length === 0) return { status: "skipped" };

  const classification = await classifier.classify(selectedMessages);
  const metadata = {
    status: "evaluated" as const,
    promptInjectionModelId: classifier.identity.artifactId,
    evaluatedMessageCount: classification.evaluatedMessageCount,
    evaluatedWindowCount: classification.evaluatedWindowCount,
  };
  if (classification.decision === "allow") {
    return {
      ...metadata,
      decision: "allow",
      findingCount: 0,
      ruleIds: [],
    };
  }
  if (classification.decision === "limit_exceeded") {
    return {
      ...metadata,
      decision: "block",
      findingCount: 0,
      ruleIds: rules.map(({ id }) => id),
    };
  }

  const selected = new Set(
    selectedMessages.map(({ messageIndex, role }) => `${messageIndex}:${role}`),
  );
  const findingIndexes = new Set<number>();
  const resolved = classification.findings.map((finding) => {
    if (
      !selected.has(`${finding.messageIndex}:${finding.role}`) ||
      findingIndexes.has(finding.messageIndex)
    ) {
      throw new Error("Prompt-injection classifier returned invalid findings.");
    }
    findingIndexes.add(finding.messageIndex);
    return rules.find((rule) => rule.roles.includes(finding.role))!;
  });

  return {
    ...metadata,
    decision: resolved.some(({ action }) => action.type === "block")
      ? "block"
      : "allow",
    findingCount: resolved.length,
    ruleIds: [...new Set(resolved.map(({ id }) => id))],
  };
}
