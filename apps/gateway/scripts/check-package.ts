import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const gatewayDirectory = resolve(import.meta.dir, "..");
const workspaceDirectory = resolve(gatewayDirectory, "../..");
const consumerDirectory = await mkdtemp(join(tmpdir(), "gateway-sdk-check-"));

async function run(command: string[], label: string): Promise<string> {
  const process = Bun.spawn(command, {
    cwd: consumerDirectory,
    env: { ...Bun.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit code ${exitCode}.\n${stderr || stdout}`,
    );
  }
  return stdout;
}

try {
  await Promise.all(
    ["index.js", "index.d.ts", "server.js", "server.d.ts"].map((file) =>
      stat(join(gatewayDirectory, "dist", file)),
    ),
  );

  const packageNamespace = join(
    consumerDirectory,
    "node_modules",
    "@llm-gateway",
  );
  await mkdir(packageNamespace, { recursive: true });
  await symlink(gatewayDirectory, join(packageNamespace, "sdk"), "dir");

  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({
      name: "sdk-consumer-check",
      private: true,
      type: "module",
    }),
  );
  await writeFile(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022", "DOM"],
      },
      include: ["consumer.ts"],
    }),
  );

  const typeScriptConsumer = `
import {
  ModelGateway,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type RequestContext,
} from "@llm-gateway/sdk";

class FakeProvider implements ModelProvider {
  async complete(request: ChatRequest, _context: RequestContext): Promise<ChatResponse> {
    return {
      id: "consumer-test",
      created: 1,
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "package works" },
        finishReason: "stop",
      }],
    };
  }
}

const gateway = new ModelGateway({ provider: new FakeProvider(), defaultModel: "fake" });
const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "test" }],
});
result.response.choices[0]?.message.content;
`;
  await writeFile(join(consumerDirectory, "consumer.ts"), typeScriptConsumer);
  await writeFile(
    join(consumerDirectory, "consumer.mjs"),
    `
import { ModelGateway } from "@llm-gateway/sdk";
import { writeFile } from "node:fs/promises";

class FakeProvider {
  async complete(request, _context) {
    return {
      id: "consumer-test",
      created: 1,
      model: request.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "package works" },
        finishReason: "stop",
      }],
    };
  }
}

const gateway = new ModelGateway({ provider: new FakeProvider(), defaultModel: "fake" });
const result = await gateway.chat.completions.create({
  messages: [{ role: "user", content: "test" }],
});
await writeFile(process.argv[2], result.response.choices[0]?.message.content ?? "");
`,
  );

  const tsc = join(workspaceDirectory, "node_modules", ".bin", "tsc");
  await run([tsc, "--project", "tsconfig.json"], "declaration consumer");

  const sideEffectScript =
    'await import("@llm-gateway/sdk"); await import("@llm-gateway/sdk/server");';
  const sideEffectOutput = await run(
    [process.execPath, "--eval", sideEffectScript],
    "Bun side-effect import",
  );
  if (sideEffectOutput.length > 0) {
    throw new Error("Public entry points wrote output during import.");
  }
  await run(
    ["node", "--input-type=module", "--eval", sideEffectScript],
    "Node side-effect import",
  );

  await run(
    [process.execPath, "consumer.mjs", "bun-result.txt"],
    "Bun package consumer",
  );
  await run(
    ["node", "consumer.mjs", "node-result.txt"],
    "Node package consumer",
  );
  const [bunOutput, nodeOutput] = await Promise.all([
    readFile(join(consumerDirectory, "bun-result.txt"), "utf8"),
    readFile(join(consumerDirectory, "node-result.txt"), "utf8"),
  ]);
  if (bunOutput !== "package works" || nodeOutput !== "package works") {
    throw new Error(
      `A package consumer returned an unexpected result (Bun: ${JSON.stringify(bunOutput)}, Node: ${JSON.stringify(nodeOutput)}).`,
    );
  }

  console.log(
    "Package declarations, side-effect imports, Bun, and Node checks passed.",
  );
} finally {
  await rm(consumerDirectory, { recursive: true, force: true });
}
