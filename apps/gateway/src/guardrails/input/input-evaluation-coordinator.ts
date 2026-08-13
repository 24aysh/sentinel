import type { ChatRequest } from "../../domain/chat.ts";
import type { PromptInjectionClassifier } from "./prompt-injection-classifier.ts";
import {
  evaluatePromptInjectionInput,
  promptInjectionRules,
  type PromptInjectionInputResult,
} from "./prompt-injection-evaluator.ts";
import { evaluatePiiInput } from "./input-evaluator.ts";
import type {
  InputDetectorType,
  InputExecutionMode,
  InputGuardrailResult,
  LoadedGuardrailPolicy,
} from "../types.ts";

type DetectorOutcome<T> =
  { status: "fulfilled"; value: T } | { status: "rejected" };

export class InputDetectorEvaluationError extends Error {
  constructor(
    readonly failedDetectorTypes: readonly InputDetectorType[],
    readonly inputExecutionMode: InputExecutionMode,
  ) {
    super("One or more input detectors failed.");
    this.name = "InputDetectorEvaluationError";
  }
}

type PiiEvaluator = typeof evaluatePiiInput;

function fulfilled<T>(value: T): DetectorOutcome<T> {
  return { status: "fulfilled", value };
}

async function settle<T>(promise: Promise<T>): Promise<DetectorOutcome<T>> {
  try {
    return fulfilled(await promise);
  } catch {
    return { status: "rejected" };
  }
}

function orderedRuleIds(
  policy: LoadedGuardrailPolicy,
  ruleIds: readonly string[],
): string[] {
  const selected = new Set(ruleIds);
  return policy.input.flatMap(({ id }) => (selected.has(id) ? [id] : []));
}

function combineInputOutcomes(
  request: ChatRequest,
  policy: LoadedGuardrailPolicy,
  mode: InputExecutionMode,
  piiOutcome: DetectorOutcome<InputGuardrailResult>,
  promptInjectionOutcome: DetectorOutcome<PromptInjectionInputResult>,
  classifier?: PromptInjectionClassifier,
): InputGuardrailResult {
  const pii = piiOutcome.status === "fulfilled" ? piiOutcome.value : undefined;
  const promptInjection =
    promptInjectionOutcome.status === "fulfilled"
      ? promptInjectionOutcome.value
      : undefined;
  const promptInjectionAttempted =
    promptInjectionOutcome.status === "rejected" ||
    promptInjection?.status === "evaluated";
  const failedDetectorTypes: InputDetectorType[] = [
    ...(piiOutcome.status === "rejected" ? (["pii"] as const) : []),
    ...(promptInjectionOutcome.status === "rejected"
      ? (["prompt_injection"] as const)
      : []),
  ];
  const detectorTypes: InputDetectorType[] = [
    "pii",
    ...(promptInjectionAttempted ? (["prompt_injection"] as const) : []),
  ];
  const piEvaluated =
    promptInjection?.status === "evaluated" ? promptInjection : undefined;
  const isBlocked =
    pii?.decision === "block" || piEvaluated?.decision === "block";

  if (
    failedDetectorTypes.length > 0 &&
    policy.defaults.runtimeFailureMode === "closed" &&
    !isBlocked
  ) {
    throw new InputDetectorEvaluationError(failedDetectorTypes, mode);
  }

  const metadata = {
    findingCount: (pii?.findingCount ?? 0) + (piEvaluated?.findingCount ?? 0),
    ruleIds: orderedRuleIds(policy, [
      ...(pii?.ruleIds ?? []),
      ...(piEvaluated?.ruleIds ?? []),
    ]),
    entityTypes: pii?.entityTypes ?? [],
    detectorTypes,
    ...(failedDetectorTypes.length > 0 && { failedDetectorTypes }),
    ...(piEvaluated
      ? { promptInjectionModelId: piEvaluated.promptInjectionModelId }
      : promptInjectionAttempted && classifier
        ? { promptInjectionModelId: classifier.identity.artifactId }
        : {}),
    ...(piEvaluated && {
      evaluatedMessageCount: piEvaluated.evaluatedMessageCount,
      evaluatedWindowCount: piEvaluated.evaluatedWindowCount,
    }),
    inputExecutionMode: mode,
  };

  if (isBlocked) return { decision: "block", ...metadata };
  if (pii?.decision === "redact") {
    return { decision: "redact", request: pii.request, ...metadata };
  }
  return {
    decision: "allow",
    request: pii?.decision === "allow" ? pii.request : request,
    ...metadata,
  };
}

async function evaluateSequentialInput(
  request: ChatRequest,
  policy: LoadedGuardrailPolicy,
  classifier: PromptInjectionClassifier | undefined,
  evaluatePii: PiiEvaluator,
): Promise<InputGuardrailResult> {
  const pii = evaluatePii(request, policy);
  if (pii.decision === "block") {
    return combineInputOutcomes(
      request,
      policy,
      "sequential",
      fulfilled(pii),
      fulfilled({ status: "skipped" }),
    );
  }

  const rules = promptInjectionRules(policy);
  if (rules.length === 0) {
    return combineInputOutcomes(
      request,
      policy,
      "sequential",
      fulfilled(pii),
      fulfilled({ status: "skipped" }),
    );
  }
  const promptInjection = classifier
    ? await settle(evaluatePromptInjectionInput(pii.request, rules, classifier))
    : ({ status: "rejected" } as const);
  return combineInputOutcomes(
    request,
    policy,
    "sequential",
    fulfilled(pii),
    promptInjection,
    classifier,
  );
}

async function evaluateParallelInput(
  request: ChatRequest,
  policy: LoadedGuardrailPolicy,
  classifier: PromptInjectionClassifier | undefined,
  evaluatePii: PiiEvaluator,
): Promise<InputGuardrailResult> {
  const rules = promptInjectionRules(policy);
  if (rules.length === 0) {
    return combineInputOutcomes(
      request,
      policy,
      "parallel",
      fulfilled(evaluatePii(request, policy)),
      fulfilled({ status: "skipped" }),
    );
  }

  const promptInjectionTask = classifier
    ? settle(evaluatePromptInjectionInput(request, rules, classifier))
    : Promise.resolve({ status: "rejected" } as const);
  const piiTask = settle(
    Promise.resolve().then(() => evaluatePii(request, policy)),
  );
  const [promptInjection, pii] = await Promise.all([
    promptInjectionTask,
    piiTask,
  ]);
  return combineInputOutcomes(
    request,
    policy,
    "parallel",
    pii,
    promptInjection,
    classifier,
  );
}

export function evaluateConfiguredInput(
  request: ChatRequest,
  policy: LoadedGuardrailPolicy,
  classifier?: PromptInjectionClassifier,
  evaluatePii: PiiEvaluator = evaluatePiiInput,
): Promise<InputGuardrailResult> {
  return policy.defaults.inputExecutionMode === "parallel"
    ? evaluateParallelInput(request, policy, classifier, evaluatePii)
    : evaluateSequentialInput(request, policy, classifier, evaluatePii);
}
