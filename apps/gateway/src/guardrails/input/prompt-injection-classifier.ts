import type { ChatRole } from "../../domain/chat.ts";

export interface PromptInjectionMessage {
  messageIndex: number;
  role: ChatRole;
  content: string;
}

export interface PromptInjectionClassifierIdentity {
  artifactId: string;
  runtimeManifestSha256: string;
}

interface PromptInjectionEvaluationMetadata {
  evaluatedMessageCount: number;
  evaluatedWindowCount: number;
}

export type PromptInjectionClassification =
  | (PromptInjectionEvaluationMetadata & { decision: "allow" })
  | (PromptInjectionEvaluationMetadata & {
      decision: "detected";
      findings: readonly {
        messageIndex: number;
        role: ChatRole;
      }[];
    })
  | (PromptInjectionEvaluationMetadata & { decision: "limit_exceeded" });

export interface PromptInjectionClassifier {
  readonly identity: PromptInjectionClassifierIdentity;

  classify(
    messages: readonly PromptInjectionMessage[],
  ): Promise<PromptInjectionClassification>;
}
