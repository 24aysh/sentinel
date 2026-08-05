import type { GatewayErrorCode } from "../domain/errors.ts";
import type { RequestContext } from "../domain/request-context.ts";
import type { Logger } from "../observability/logger.ts";

export type LifecycleStage =
  | "received"
  | "validated"
  | "provider_started"
  | "provider_completed"
  | "completed"
  | "failed";

export interface LifecycleEvent {
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
  private readonly context: RequestContext;
  private readonly logger: Logger;
  private readonly listener?: LifecycleListener;
  private readonly recordedEvents: LifecycleEvent[] = [];
  private lastStage: Exclude<LifecycleStage, "failed"> = "received";
  private failed = false;

  constructor(
    context: RequestContext,
    logger: Logger,
    listener?: LifecycleListener,
  ) {
    this.context = context;
    this.logger = logger;
    this.listener = listener;
  }

  get events(): readonly LifecycleEvent[] {
    return this.recordedEvents;
  }

  record(stage: Exclude<LifecycleStage, "failed">): void {
    this.lastStage = stage;
    const event = this.createEvent(stage);
    this.recordedEvents.push(event);
    this.logger.info({ event: "gateway.lifecycle", ...event });
    this.listener?.(event);
  }

  recordFailure(errorCode: GatewayErrorCode): void {
    if (this.failed) {
      return;
    }

    this.failed = true;
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
