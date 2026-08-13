import type { LogRecord, Logger } from "../../src/observability/logger.ts";

export class RecordingLogger implements Logger {
  readonly records: LogRecord[] = [];

  info(record: LogRecord): void {
    this.records.push(record);
  }

  error(record: LogRecord): void {
    this.records.push(record);
  }
}
