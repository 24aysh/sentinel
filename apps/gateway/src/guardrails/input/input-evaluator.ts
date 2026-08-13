import type { ChatRequest } from "../../domain/chat.ts";
import type {
  InputGuardrailResult,
  InputPolicyAction,
  LoadedGuardrailPolicy,
  PiiInputPolicyRule,
  PiiFinding,
} from "../types.ts";
import { detectPii } from "./pii-detector.ts";

interface ResolvedFinding {
  finding: PiiFinding;
  action: InputPolicyAction;
  ruleId?: string;
}

function resolve(
  finding: PiiFinding,
  policy: LoadedGuardrailPolicy,
): ResolvedFinding {
  const rule = policy.input
    .filter(
      (candidate): candidate is PiiInputPolicyRule =>
        candidate.detector === "pii",
    )
    .find(
      ({ entities, roles }) =>
        entities.includes(finding.entity) &&
        (roles === undefined || roles.includes(finding.role)),
    );
  return rule
    ? { finding, action: rule.action, ruleId: rule.id }
    : { finding, action: { type: policy.defaults.inputAction } };
}

function redact(
  request: ChatRequest,
  resolved: readonly ResolvedFinding[],
): ChatRequest {
  const byMessage = Map.groupBy(
    resolved,
    ({ finding }) => finding.messageIndex,
  );
  return {
    ...request,
    messages: request.messages.map((message, index) => {
      let content = message.content;
      for (const { finding, action } of (
        byMessage.get(index) ?? []
      ).toReversed()) {
        content = `${content.slice(0, finding.start)}${action.replacement ?? `<${finding.entity}>`}${content.slice(finding.end)}`;
      }
      return { ...message, content };
    }),
  };
}

export function evaluatePiiInput(
  request: ChatRequest,
  policy: LoadedGuardrailPolicy,
): InputGuardrailResult {
  const findings = detectPii(request.messages);
  const resolved = findings.map((finding) => resolve(finding, policy));
  const metadata = {
    findingCount: findings.length,
    ruleIds: [
      ...new Set(resolved.flatMap(({ ruleId }) => (ruleId ? [ruleId] : []))),
    ],
    entityTypes: [...new Set(findings.map(({ entity }) => entity))],
    detectorTypes: ["pii" as const],
  };

  if (resolved.some(({ action }) => action.type === "block")) {
    return { decision: "block", ...metadata };
  }

  const redactions = resolved.filter(({ action }) => action.type === "redact");
  return redactions.length
    ? { decision: "redact", request: redact(request, redactions), ...metadata }
    : { decision: "allow", request, ...metadata };
}
