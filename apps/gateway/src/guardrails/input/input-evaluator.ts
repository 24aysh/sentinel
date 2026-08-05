import type { ChatRequest } from "../../domain/chat.ts";
import type {
  InputGuardrailResult,
  InputPolicyAction,
  LoadedGuardrailPolicy,
  PiiEntity,
  PiiFinding,
} from "../types.ts";
import { detectPii } from "./pii-detector.ts";

interface ResolvedFinding {
  finding: PiiFinding;
  action: InputPolicyAction;
  ruleId?: string;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function resolveFinding(
  finding: PiiFinding,
  policy: LoadedGuardrailPolicy,
): ResolvedFinding {
  const rule = policy.input.find(
    (candidate) =>
      candidate.entities.includes(finding.entity) &&
      (candidate.roles === undefined || candidate.roles.includes(finding.role)),
  );

  if (rule) {
    return { finding, action: rule.action, ruleId: rule.id };
  }
  return { finding, action: { type: policy.defaults.inputAction } };
}

function metadata(resolved: readonly ResolvedFinding[]): {
  ruleIds: string[];
  entityTypes: PiiEntity[];
} {
  return {
    ruleIds: unique(
      resolved.flatMap((item) => (item.ruleId ? [item.ruleId] : [])),
    ),
    entityTypes: unique(resolved.map((item) => item.finding.entity)),
  };
}

function redactRequest(
  request: ChatRequest,
  findings: readonly ResolvedFinding[],
): ChatRequest {
  const byMessage = new Map<number, ResolvedFinding[]>();
  for (const finding of findings) {
    const list = byMessage.get(finding.finding.messageIndex) ?? [];
    list.push(finding);
    byMessage.set(finding.finding.messageIndex, list);
  }

  return {
    ...request,
    messages: request.messages.map((message, messageIndex) => {
      const messageFindings = byMessage.get(messageIndex);
      if (!messageFindings) {
        return { ...message };
      }

      let content = message.content;
      const descending = [...messageFindings].sort(
        (first, second) => second.finding.start - first.finding.start,
      );
      for (const item of descending) {
        const replacement =
          item.action.replacement ?? `<${item.finding.entity}>`;
        content =
          content.slice(0, item.finding.start) +
          replacement +
          content.slice(item.finding.end);
      }
      return { ...message, content };
    }),
  };
}

export class InputPolicyEvaluator {
  constructor(private readonly policy: LoadedGuardrailPolicy) {}

  evaluate(request: ChatRequest): InputGuardrailResult {
    const findings = detectPii(request.messages);
    const resolved = findings.map((finding) =>
      resolveFinding(finding, this.policy),
    );
    const resultMetadata = metadata(resolved);

    if (resolved.some((item) => item.action.type === "block")) {
      return {
        decision: "block",
        findingCount: findings.length,
        ...resultMetadata,
      };
    }

    const redactions = resolved.filter((item) => item.action.type === "redact");
    if (redactions.length > 0) {
      return {
        decision: "redact",
        request: redactRequest(request, redactions),
        findingCount: findings.length,
        ...resultMetadata,
      };
    }

    return {
      decision: "allow",
      request,
      findingCount: findings.length,
      ...resultMetadata,
    };
  }
}
