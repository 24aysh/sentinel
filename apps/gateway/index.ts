import { createRuntime } from "./src/runtime.ts";

const runtime = await createRuntime();

runtime.app.listen({
  hostname: runtime.config.host,
  port: runtime.config.port,
});

runtime.logger.info({
  event: "gateway.started",
  host: runtime.config.host,
  port: runtime.config.port,
  provider: runtime.config.modelProvider,
});
