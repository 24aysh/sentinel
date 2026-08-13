import type { GatewayErrorCode } from "../domain/errors.ts";
import type { RequestContext } from "../domain/request-context.ts";
import type { Logger } from "../observability/logger.ts";
import type { InputExecutionMode } from "../guardrails/types.ts";

export type LifecycleStage =
  | "received"
  | "validated"
  | "input_guardrails_started"
  | "input_guardrails_completed"
  | "provider_started"
  | "provider_completed"
  | "output_guardrails_started"
  | "output_guardrails_completed"
  | "retry_started"
  | "completed"
  | "failed";

export type LifecycleDecision = "allow" | "redact" | "block" | "retry";

export interface LifecycleMetadata {
  policyName?: string;
  policyVersion?: number;
  decision?: LifecycleDecision;
  findingCount?: number;
  ruleIds?: string[];
  entityTypes?: string[];
  detectorTypes?: string[];
  failedDetectorTypes?: string[];
  promptInjectionModelId?: string;
  evaluatedMessageCount?: number;
  evaluatedWindowCount?: number;
  inputExecutionMode?: InputExecutionMode;
  attempt?: number;
  maximumAttempts?: number;
}

export interface LifecycleEvent extends LifecycleMetadata {
  requestId: string;
  model: string;
  stage: LifecycleStage;
  timestamp: string;
  elapsedMs: number;
  failedAt?: Exclude<LifecycleStage, "failed">;
  errorCode?: GatewayErrorCode;
}

export type LifecycleListener = (event: LifecycleEvent) => void;

export class LifecycleTracker {
  private readonly recordedEvents: LifecycleEvent[] = [];
  private lastStage: Exclude<LifecycleStage, "failed"> = "received";

  constructor(
    private readonly context: RequestContext,
    private readonly logger: Logger,
    private readonly listener?: LifecycleListener,
  ) {}

  get events(): readonly LifecycleEvent[] {
    return this.recordedEvents;
  }

  record(
    stage: Exclude<LifecycleStage, "failed">,
    metadata: LifecycleMetadata = {},
  ): void {
    this.lastStage = stage;
    const event = { ...this.createEvent(stage), ...metadata };
    this.recordedEvents.push(event);
    this.logger.info({ event: "gateway.lifecycle", ...event });
    this.listener?.(event);
  }

  recordFailure(errorCode: GatewayErrorCode): void {
    const event: LifecycleEvent = {
      ...this.createEvent("failed"),
      failedAt: this.lastStage,
      errorCode,
    };
    this.recordedEvents.push(event);
    this.logger.error({ event: "gateway.lifecycle", ...event });
    this.listener?.(event);
  }

  private createEvent(stage: LifecycleStage): LifecycleEvent {
    return {
      requestId: this.context.requestId,
      model: this.context.model,
      stage,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - this.context.startedAt),
    };
  }
}
