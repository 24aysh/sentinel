import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationError } from "../src/domain/errors.ts";
import { loadGuardrailPolicy } from "../src/guardrails/config/policy-loader.ts";

const temporaryDirectories: string[] = [];
const validSchema = JSON.stringify({
  type: "object",
  properties: { status: { const: "ok" } },
  required: ["status"],
  additionalProperties: false,
});

async function createFixture(
  policy: string,
  schema = validSchema,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-policy-test-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "schemas"));
  await writeFile(join(directory, "policy.yaml"), policy);
  await writeFile(join(directory, "schemas", "response.json"), schema);
  return join(directory, "policy.yaml");
}

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("loadGuardrailPolicy", () => {
  test("accepts every expanded entity", async () => {
    const path = await createFixture(`
apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: expanded, version: 1 }
input:
  - id: expanded-pii
    detector: pii
    entities: [EMAIL, PHONE_NUMBER, IP_ADDRESS, API_KEY, JWT, PRIVATE_KEY, CLOUD_CREDENTIAL, CREDIT_CARD, DATABASE_CONNECTION_STRING]
    action: { type: redact }
`);

    const rule = (await loadGuardrailPolicy(path)).input[0];
    expect(rule?.detector).toBe("pii");
    if (rule?.detector === "pii") {
      expect(rule.entities).toHaveLength(9);
    }
  });

  test("loads, normalizes, and compiles a valid policy", async () => {
    const path = await createFixture(`
apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: false
metadata:
  name: test-policy
  version: 3
defaults:
  input_action: redact
  input_execution_mode: sequential
  runtime_failure_mode: open
  maximum_retries: 2
input:
  - id: redact-email
    detector: pii
    entities: [EMAIL]
    roles: [user]
    action:
      type: redact
      replacement: "[email]"
output:
  - id: validate-output
    validator: json_schema
    schema_ref: schemas/response.json
    on_failure:
      type: retry
`);

    const policy = await loadGuardrailPolicy(path);

    expect(policy.identity).toEqual({ name: "test-policy", version: 3 });
    expect(policy.enabled).toBe(false);
    expect(policy.defaults).toEqual({
      inputAction: "redact",
      inputExecutionMode: "sequential",
      runtimeFailureMode: "open",
      maximumRetries: 2,
    });
    expect(policy.input[0]).toMatchObject({
      id: "redact-email",
      entities: ["EMAIL"],
      roles: ["user"],
      action: { type: "redact", replacement: "[email]" },
    });
    expect(policy.output?.validator.validate({ status: "ok" })).toBe(true);
    expect(policy.output?.validator.validate({ status: "bad" })).toBe(false);
    expect(policy.output?.onFailure).toEqual({
      type: "retry",
      maximumRetries: 2,
    });
  });

  test("applies documented defaults to a minimal policy", async () => {
    const path = await createFixture(`
apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata:
  name: minimal
  version: 1
`);

    const policy = await loadGuardrailPolicy(path);

    expect(policy.defaults).toEqual({
      inputAction: "allow",
      inputExecutionMode: "sequential",
      runtimeFailureMode: "closed",
      maximumRetries: 1,
    });
    expect(policy.input).toEqual([]);
    expect(policy.enabled).toBe(true);
    expect(policy.output).toBeUndefined();
  });

  test.each([
    [
      "unknown top-level field",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid, version: 1 }
unexpected: true`,
    ],
    [
      "unsupported action",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid, version: 1 }
input:
  - id: route-email
    detector: pii
    entities: [EMAIL]
    action: { type: route }`,
    ],
    [
      "a non-boolean enabled value",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
enabled: "off"
metadata: { name: invalid, version: 1 }`,
    ],
    [
      "duplicate rule IDs",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid, version: 1 }
input:
  - id: duplicate
    detector: pii
    entities: [EMAIL]
    action: { type: allow }
  - id: duplicate
    detector: pii
    entities: [PHONE_NUMBER]
    action: { type: block }`,
    ],
    [
      "duplicate YAML keys",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata:
  name: invalid
  name: duplicate
  version: 1`,
    ],
    [
      "an excessive retry budget",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid, version: 1 }
output:
  - id: output
    validator: json_schema
    schema_ref: schemas/response.json
    on_failure: { type: retry, maximum_retries: 4 }`,
    ],
    [
      "multiple output rules",
      `apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid, version: 1 }
output:
  - id: first
    validator: json_schema
    schema_ref: schemas/response.json
    on_failure: { type: block }
  - id: second
    validator: json_schema
    schema_ref: schemas/response.json
    on_failure: { type: block }`,
    ],
  ])("rejects %s", async (_name, source) => {
    const path = await createFixture(source);
    expect(loadGuardrailPolicy(path)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  test("rejects a missing configured policy", () => {
    expect(
      loadGuardrailPolicy("/tmp/definitely-missing-guardrail-policy.yaml"),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      message: expect.stringContaining("GUARDRAIL_POLICY_PATH"),
    });
  });

  test("rejects malformed and externally-referenced schemas", async () => {
    const policySource = `
apiVersion: guardrails/v1
kind: GuardrailPolicy
metadata: { name: invalid-schema, version: 1 }
output:
  - id: output
    validator: json_schema
    schema_ref: schemas/response.json
    on_failure: { type: block }
`;
    const malformed = await createFixture(policySource, "not-json");
    const external = await createFixture(
      policySource,
      JSON.stringify({ $ref: "https://schemas.example.test/output.json" }),
    );

    expect(loadGuardrailPolicy(malformed)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    expect(loadGuardrailPolicy(external)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });
});
