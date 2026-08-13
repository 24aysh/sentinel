import { resolve } from "node:path";

const gatewayDirectory = resolve(import.meta.dir, "..");
const modelPath = process.argv[2] ?? "../model";

for (const script of ["smoke:layer2", "smoke:layer2:node"]) {
  const child = Bun.spawn([process.execPath, "run", script, "--", modelPath], {
    cwd: gatewayDirectory,
    env: { ...Bun.env },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) process.exit(1);
}
