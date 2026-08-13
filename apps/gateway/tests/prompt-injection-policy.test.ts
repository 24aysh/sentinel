import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "../src/domain/errors.ts";
import { loadGuardrailPolicy } from "../src/guardrails/config/policy-loader.ts";

const temporaryDirectories: string[] = [];

function policy(input: string, enabled = true): string {
  return `
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: ${enabled}
metadata: { name: prompt-injection-test, version: 1 }
input:
${input}
`;
}

async function writePolicy(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-pi-policy-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "policy.yaml");
  await writeFile(path, source);
  return path;
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("prompt-injection policy rules", () => {
  test("loads allow and block rules without adding a threshold", async () => {
    const path = await writePolicy(
      policy(`
  - id: shadow-user
    detector: prompt_injection
    roles: [user]
    action: { type: allow }
  - id: block-system
    detector: prompt_injection
    roles: [system]
    action: { type: block }
`),
    );

    const loaded = await loadGuardrailPolicy(path);

    expect(loaded.input).toEqual([
      {
        id: "shadow-user",
        detector: "prompt_injection",
        roles: ["user"],
        action: { type: "allow" },
      },
      {
        id: "block-system",
        detector: "prompt_injection",
        roles: ["system"],
        action: { type: "block" },
      },
    ]);
  });

  test.each([
    [
      "missing roles",
      `  - id: invalid
    detector: prompt_injection
    action: { type: block }`,
    ],
    [
      "empty roles",
      `  - id: invalid
    detector: prompt_injection
    roles: []
    action: { type: block }`,
    ],
    [
      "duplicate roles",
      `  - id: invalid
    detector: prompt_injection
    roles: [user, user]
    action: { type: block }`,
    ],
    [
      "unknown role",
      `  - id: invalid
    detector: prompt_injection
    roles: [tool]
    action: { type: block }`,
    ],
    [
      "redaction",
      `  - id: invalid
    detector: prompt_injection
    roles: [user]
    action: { type: redact }`,
    ],
    [
      "entities",
      `  - id: invalid
    detector: prompt_injection
    roles: [user]
    entities: [EMAIL]
    action: { type: block }`,
    ],
    [
      "replacement",
      `  - id: invalid
    detector: prompt_injection
    roles: [user]
    action: { type: block, replacement: hidden }`,
    ],
    [
      "threshold override",
      `  - id: invalid
    detector: prompt_injection
    roles: [user]
    threshold: 0.5
    action: { type: block }`,
    ],
    [
      "unknown detector",
      `  - id: invalid
    detector: remote_classifier
    roles: [user]
    action: { type: block }`,
    ],
  ])("rejects %s", async (_name, rule) => {
    const path = await writePolicy(policy(rule));
    await expect(loadGuardrailPolicy(path)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("validates malformed rules even when the policy is disabled", async () => {
    const path = await writePolicy(
      policy(
        `  - id: invalid
    detector: prompt_injection
    roles: []
    action: { type: block }`,
        false,
      ),
    );

    await expect(loadGuardrailPolicy(path)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
