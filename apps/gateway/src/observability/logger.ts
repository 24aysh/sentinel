export type LogRecord = Readonly<Record<string, unknown>> & { event: string };

export interface Logger {
  info(record: LogRecord): void;
  error(record: LogRecord): void;
}

export class ConsoleLogger implements Logger {
  info(record: LogRecord): void {
    console.info(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        ...record,
      }),
    );
  }

  error(record: LogRecord): void {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        ...record,
      }),
    );
  }
}

export const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
};
