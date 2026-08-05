import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { realpath, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { ConfigurationError } from "../../config/env.ts";
import { CHAT_ROLES, type ChatRole } from "../../domain/chat.ts";
import { CompiledJsonSchemaValidator } from "../output/json-schema-validator.ts";
import {
  PII_ENTITIES,
  type InputActionType,
  type InputPolicyAction,
  type InputPolicyRule,
  type LoadedGuardrailPolicy,
  type OutputFailureAction,
  type PiiEntity,
  type PolicyDefaults,
  type RuntimeFailureMode,
} from "../types.ts";

const MAX_FILE_SIZE = 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
type UnknownRecord = Record<string, unknown>;

interface ParsedOutputRule {
  id: string;
  schemaRef: string;
  onFailure: OutputFailureAction;
}

function fail(message: string): never {
  throw new ConfigurationError(`GUARDRAIL_POLICY_PATH ${message}`);
}

function object(
  value: unknown,
  location: string,
  allowed?: readonly string[],
): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`must contain an object at ${location}.`);
  }
  if (allowed) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) fail(`contains unknown field ${location}.${unknown}.`);
  }
  return value as UnknownRecord;
}

function text(
  value: unknown,
  location: string,
  maximumLength?: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`must contain a non-empty string at ${location}.`);
  }
  const result = value.trim();
  if (maximumLength !== undefined && result.length > maximumLength) {
    fail(
      `must contain no more than ${maximumLength} characters at ${location}.`,
    );
  }
  return result;
}

function name(value: unknown, location: string): string {
  const result = text(value, location);
  if (!NAME_PATTERN.test(result)) {
    fail(`contains an invalid identifier at ${location}.`);
  }
  return result;
}

function integer(
  value: unknown,
  location: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (maximum !== undefined && (value as number) > maximum)
  ) {
    const range =
      maximum !== undefined
        ? `from ${minimum} through ${maximum}`
        : `at least ${minimum}`;
    fail(`must contain an integer ${range} at ${location}.`);
  }
  return value as number;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`contains an unsupported value at ${location}.`);
  }
  return value as T;
}

function array(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) fail(`must contain an array at ${location}.`);
  return value;
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T[] {
  const result = array(value, location).map((item, index) =>
    oneOf(item, allowed, `${location}[${index}]`),
  );
  if (result.length === 0) {
    fail(`must contain at least one item at ${location}.`);
  }
  if (new Set(result).size !== result.length) {
    fail(`must not contain duplicate values at ${location}.`);
  }
  return result;
}

function optional<T>(
  value: unknown,
  fallback: T,
  parse: (value: unknown) => T,
): T {
  return value === undefined ? fallback : parse(value);
}

function parseDefaults(value: unknown): PolicyDefaults {
  const defaults =
    value === undefined
      ? {}
      : object(value, "defaults", [
          "input_action",
          "runtime_failure_mode",
          "maximum_retries",
        ]);
  return {
    inputAction: optional<InputActionType>(
      defaults.input_action,
      "allow",
      (item) =>
        oneOf(item, ["allow", "redact", "block"], "defaults.input_action"),
    ),
    runtimeFailureMode: optional<RuntimeFailureMode>(
      defaults.runtime_failure_mode,
      "closed",
      (item) =>
        oneOf(item, ["open", "closed"], "defaults.runtime_failure_mode"),
    ),
    maximumRetries: optional(defaults.maximum_retries, 1, (item) =>
      integer(item, "defaults.maximum_retries", 0, 3),
    ),
  };
}

function parseInputAction(value: unknown, location: string): InputPolicyAction {
  const action = object(value, location, ["type", "replacement"]);
  const type = oneOf<InputActionType>(
    action.type,
    ["allow", "redact", "block"],
    `${location}.type`,
  );
  if (action.replacement !== undefined && type !== "redact") {
    fail(`allows replacement only for redact at ${location}.`);
  }
  return type === "redact" && action.replacement !== undefined
    ? {
        type,
        replacement: text(action.replacement, `${location}.replacement`, 256),
      }
    : { type };
}

function parseInputRules(value: unknown): InputPolicyRule[] {
  if (value === undefined) return [];
  return array(value, "input").map((item, index) => {
    const location = `input[${index}]`;
    const rule = object(item, location, [
      "id",
      "description",
      "detector",
      "entities",
      "roles",
      "action",
    ]);
    if (rule.detector !== "pii") {
      fail(`must use detector pii at ${location}.detector.`);
    }
    if (rule.description !== undefined) {
      text(rule.description, `${location}.description`, 2_000);
    }

    const result: InputPolicyRule = {
      id: name(rule.id, `${location}.id`),
      entities: enumArray<PiiEntity>(
        rule.entities,
        PII_ENTITIES,
        `${location}.entities`,
      ),
      action: parseInputAction(rule.action, `${location}.action`),
    };
    if (rule.roles !== undefined) {
      result.roles = enumArray<ChatRole>(
        rule.roles,
        CHAT_ROLES,
        `${location}.roles`,
      );
    }
    return result;
  });
}

function parseOutputAction(
  value: unknown,
  defaults: PolicyDefaults,
  location: string,
): OutputFailureAction {
  const action = object(value, location, [
    "type",
    "maximum_retries",
    "repair_prompt",
  ]);
  const type = oneOf(action.type, ["retry", "block"], `${location}.type`);
  if (type === "block") {
    if (
      action.maximum_retries !== undefined ||
      action.repair_prompt !== undefined
    ) {
      fail(
        `allows maximum_retries and repair_prompt only for retry at ${location}.`,
      );
    }
    return { type };
  }

  const result: OutputFailureAction = {
    type,
    maximumRetries: optional(
      action.maximum_retries,
      defaults.maximumRetries,
      (item) => integer(item, `${location}.maximum_retries`, 0, 3),
    ),
  };
  if (action.repair_prompt !== undefined) {
    result.repairPrompt = text(
      action.repair_prompt,
      `${location}.repair_prompt`,
      2_000,
    );
  }
  return result;
}

function parseOutputRule(
  value: unknown,
  defaults: PolicyDefaults,
): ParsedOutputRule | undefined {
  if (value === undefined) return undefined;
  const rules = array(value, "output");
  if (rules.length > 1) fail("supports at most one output rule.");
  if (rules.length === 0) return undefined;

  const location = "output[0]";
  const rule = object(rules[0], location, [
    "id",
    "validator",
    "schema_ref",
    "on_failure",
  ]);
  if (rule.validator !== "json_schema") {
    fail(`must use validator json_schema at ${location}.validator.`);
  }
  return {
    id: name(rule.id, `${location}.id`),
    schemaRef: text(rule.schema_ref, `${location}.schema_ref`),
    onFailure: parseOutputAction(
      rule.on_failure,
      defaults,
      `${location}.on_failure`,
    ),
  };
}

async function readFile(path: string, label: string): Promise<string> {
  const details = await stat(path).catch(() =>
    fail(`could not read the configured ${label}.`),
  );
  if (!details.isFile()) fail(`must reference a regular ${label}.`);
  if (details.size > MAX_FILE_SIZE) {
    fail(`configured ${label} exceeds the 1 MiB limit.`);
  }
  return Bun.file(path)
    .text()
    .catch(() => fail(`could not read the configured ${label}.`));
}

function hasExternalReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExternalReference);
  if (typeof value !== "object" || value === null) return false;

  const record = value as UnknownRecord;
  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    if (
      keyword in record &&
      (typeof record[keyword] !== "string" || !record[keyword].startsWith("#"))
    ) {
      return true;
    }
  }
  return Object.values(record).some(hasExternalReference);
}

async function loadSchema(policyDirectory: string, schemaRef: string) {
  if (isAbsolute(schemaRef) || extname(schemaRef).toLowerCase() !== ".json") {
    fail("requires schema_ref to be a relative JSON file.");
  }
  const schemaPath = await realpath(resolve(policyDirectory, schemaRef)).catch(
    () => fail("could not read the configured schema."),
  );
  const relativePath = relative(policyDirectory, schemaPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    fail("requires schema_ref to remain inside the policy directory.");
  }

  const source = await readFile(schemaPath, "schema file");
  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch {
    fail("contains invalid JSON in the configured schema.");
  }
  if (hasExternalReference(schema)) {
    fail("does not support remote or cross-file schema references.");
  }
  try {
    return { schema, validator: new CompiledJsonSchemaValidator(schema) };
  } catch {
    fail("contains a schema that could not be compiled.");
  }
}

export async function loadGuardrailPolicy(
  configuredPath: string,
  workingDirectory = process.cwd(),
): Promise<LoadedGuardrailPolicy> {
  const policyPath = await realpath(
    resolve(workingDirectory, configuredPath),
  ).catch(() => fail("could not read the configured policy file."));
  const document = parseDocument(await readFile(policyPath, "policy file"), {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length) fail("contains invalid YAML.");

  let rawPolicy: unknown;
  try {
    rawPolicy = document.toJS({ maxAliasCount: 0 });
  } catch {
    fail("contains unsupported YAML aliases.");
  }

  const policy = object(rawPolicy, "policy", [
    "apiVersion",
    "kind",
    "enabled",
    "metadata",
    "defaults",
    "input",
    "output",
  ]);
  if (policy.apiVersion !== "guardrails/v1") {
    fail("must use apiVersion guardrails/v1.");
  }
  if (policy.kind !== "GuardrailPolicy") {
    fail("must use kind GuardrailPolicy.");
  }

  const metadata = object(policy.metadata, "metadata", ["name", "version"]);
  const defaults = parseDefaults(policy.defaults);
  const input = parseInputRules(policy.input);
  const output = parseOutputRule(policy.output, defaults);
  const ids = [...input.map(({ id }) => id), ...(output ? [output.id] : [])];
  if (new Set(ids).size !== ids.length) {
    fail("requires globally unique rule IDs.");
  }

  const loaded: LoadedGuardrailPolicy = {
    enabled:
      policy.enabled === undefined
        ? true
        : typeof policy.enabled === "boolean"
          ? policy.enabled
          : fail("must contain a boolean at enabled."),
    identity: {
      name: name(metadata.name, "metadata.name"),
      version: integer(metadata.version, "metadata.version", 1),
    },
    defaults,
    input,
  };
  if (output) {
    loaded.output = {
      id: output.id,
      onFailure: output.onFailure,
      ...(await loadSchema(dirname(policyPath), output.schemaRef)),
    };
  }
  return loaded;
}
