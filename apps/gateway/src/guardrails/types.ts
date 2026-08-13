import type { ChatRequest, ChatResponse, ChatRole } from "../domain/chat.ts";
import type { RequestContext } from "../domain/request-context.ts";

export const PII_ENTITIES = [
  "EMAIL",
  "PHONE_NUMBER",
  "IP_ADDRESS",
  "API_KEY",
  "JWT",
  "PRIVATE_KEY",
  "CLOUD_CREDENTIAL",
  "CREDIT_CARD",
  "DATABASE_CONNECTION_STRING",
] as const;

export type PiiEntity = (typeof PII_ENTITIES)[number];
export type InputActionType = "allow" | "redact" | "block";
export type InputDetectorType = "pii" | "prompt_injection";
export type RuntimeFailureMode = "open" | "closed";

export interface PolicyIdentity {
  name: string;
  version: number;
}

export interface PolicyDefaults {
  inputAction: InputActionType;
  runtimeFailureMode: RuntimeFailureMode;
  maximumRetries: number;
}

export interface InputPolicyAction {
  type: InputActionType;
  replacement?: string;
}

export interface PiiInputPolicyRule {
  id: string;
  detector: "pii";
  entities: PiiEntity[];
  roles?: ChatRole[];
  action: InputPolicyAction;
}

export interface PromptInjectionInputPolicyRule {
  id: string;
  detector: "prompt_injection";
  roles: ChatRole[];
  action: { type: "allow" | "block" };
}

export type InputPolicyRule =
  PiiInputPolicyRule | PromptInjectionInputPolicyRule;

export type OutputFailureAction =
  | { type: "block" }
  | {
      type: "retry";
      maximumRetries: number;
      repairPrompt?: string;
    };

export interface OutputPolicyRule {
  id: string;
  schema: unknown;
  validator: { validate(value: unknown): boolean };
  onFailure: OutputFailureAction;
}

export interface LoadedGuardrailPolicy {
  enabled: boolean;
  identity: PolicyIdentity;
  defaults: PolicyDefaults;
  input: InputPolicyRule[];
  output?: OutputPolicyRule;
}

export interface PiiFinding {
  entity: PiiEntity;
  messageIndex: number;
  role: ChatRole;
  start: number;
  end: number;
}

interface GuardrailResultMetadata {
  ruleIds: string[];
  entityTypes: PiiEntity[];
  detectorTypes?: InputDetectorType[];
  failedDetectorTypes?: InputDetectorType[];
  promptInjectionModelId?: string;
  evaluatedMessageCount?: number;
  evaluatedWindowCount?: number;
}

export type InputGuardrailResult =
  | (GuardrailResultMetadata & {
      decision: "allow" | "redact";
      request: ChatRequest;
      findingCount: number;
    })
  | (GuardrailResultMetadata & {
      decision: "block";
      findingCount: number;
    });

export type OutputGuardrailResult =
  | { decision: "allow" }
  | { decision: "retry"; ruleId: string; repairRequest: ChatRequest }
  | { decision: "block"; ruleId: string };

export interface GuardrailHub {
  readonly identity: PolicyIdentity;
  readonly runtimeFailureMode: RuntimeFailureMode;
  readonly maximumAttempts: number;

  evaluateInput(
    request: ChatRequest,
    context: RequestContext,
  ): Promise<InputGuardrailResult>;

  evaluateOutput(
    request: ChatRequest,
    response: ChatResponse,
    context: RequestContext,
    attempt: number,
  ): Promise<OutputGuardrailResult>;
}
