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

function policyError(message: string, _cause?: unknown): never {
  throw new ConfigurationError(`GUARDRAIL_POLICY_PATH ${message}`);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, location: string): UnknownRecord {
  if (!isRecord(value)) {
    policyError(`must contain an object at ${location}.`);
  }
  return value;
}

function rejectUnknownKeys(
  record: UnknownRecord,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) {
    policyError(`contains unknown field ${location}.${unknown}.`);
  }
}

function requireString(
  value: unknown,
  location: string,
  options: { maximumLength?: number } = {},
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    policyError(`must contain a non-empty string at ${location}.`);
  }
  const normalized = value.trim();
  if (
    options.maximumLength !== undefined &&
    normalized.length > options.maximumLength
  ) {
    policyError(
      `must contain no more than ${options.maximumLength} characters at ${location}.`,
    );
  }
  return normalized;
}

function requireName(value: unknown, location: string): string {
  const name = requireString(value, location);
  if (!NAME_PATTERN.test(name)) {
    policyError(`contains an invalid identifier at ${location}.`);
  }
  return name;
}

function requireInteger(
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
      maximum === undefined
        ? `at least ${minimum}`
        : `from ${minimum} through ${maximum}`;
    policyError(`must contain an integer ${range} at ${location}.`);
  }
  return value as number;
}

function requireBoolean(value: unknown, location: string): boolean {
  if (typeof value !== "boolean") {
    policyError(`must contain a boolean at ${location}.`);
  }
  return value;
}

function requireArray(value: unknown, location: string): unknown[] {
  if (!Array.isArray(value)) {
    policyError(`must contain an array at ${location}.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    policyError(`contains an unsupported value at ${location}.`);
  }
  return value as T;
}

function requireUniqueEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  location: string,
): T[] {
  const values = requireArray(value, location);
  if (values.length === 0) {
    policyError(`must contain at least one item at ${location}.`);
  }

  const normalized = values.map((item, index) =>
    requireEnum(item, allowed, `${location}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    policyError(`must not contain duplicate values at ${location}.`);
  }
  return normalized;
}

function parseDefaults(value: unknown): PolicyDefaults {
  if (value === undefined) {
    return {
      inputAction: "allow",
      runtimeFailureMode: "closed",
      maximumRetries: 1,
    };
  }

  const defaults = requireRecord(value, "defaults");
  rejectUnknownKeys(
    defaults,
    ["input_action", "runtime_failure_mode", "maximum_retries"],
    "defaults",
  );

  return {
    inputAction:
      defaults.input_action === undefined
        ? "allow"
        : requireEnum<InputActionType>(
            defaults.input_action,
            ["allow", "redact", "block"],
            "defaults.input_action",
          ),
    runtimeFailureMode:
      defaults.runtime_failure_mode === undefined
        ? "closed"
        : requireEnum<RuntimeFailureMode>(
            defaults.runtime_failure_mode,
            ["open", "closed"],
            "defaults.runtime_failure_mode",
          ),
    maximumRetries:
      defaults.maximum_retries === undefined
        ? 1
        : requireInteger(
            defaults.maximum_retries,
            "defaults.maximum_retries",
            0,
            3,
          ),
  };
}

function parseInputAction(value: unknown, location: string): InputPolicyAction {
  const action = requireRecord(value, location);
  rejectUnknownKeys(action, ["type", "replacement"], location);
  const type = requireEnum<InputActionType>(
    action.type,
    ["allow", "redact", "block"],
    `${location}.type`,
  );

  if (type !== "redact" && action.replacement !== undefined) {
    policyError(`allows replacement only for redact at ${location}.`);
  }

  if (type === "redact" && action.replacement !== undefined) {
    return {
      type,
      replacement: requireString(
        action.replacement,
        `${location}.replacement`,
        {
          maximumLength: 256,
        },
      ),
    };
  }

  return { type };
}

function parseInputRules(value: unknown): InputPolicyRule[] {
  if (value === undefined) {
    return [];
  }

  return requireArray(value, "input").map((item, index) => {
    const location = `input[${index}]`;
    const rule = requireRecord(item, location);
    rejectUnknownKeys(
      rule,
      ["id", "description", "detector", "entities", "roles", "action"],
      location,
    );

    if (rule.detector !== "pii") {
      policyError(`must use detector pii at ${location}.detector.`);
    }

    const parsed: InputPolicyRule = {
      id: requireName(rule.id, `${location}.id`),
      entities: requireUniqueEnumArray<PiiEntity>(
        rule.entities,
        PII_ENTITIES,
        `${location}.entities`,
      ),
      action: parseInputAction(rule.action, `${location}.action`),
    };

    if (rule.description !== undefined) {
      parsed.description = requireString(
        rule.description,
        `${location}.description`,
        { maximumLength: 2_000 },
      );
    }
    if (rule.roles !== undefined) {
      parsed.roles = requireUniqueEnumArray<ChatRole>(
        rule.roles,
        CHAT_ROLES,
        `${location}.roles`,
      );
    }

    return parsed;
  });
}

function parseOutputFailureAction(
  value: unknown,
  defaults: PolicyDefaults,
  location: string,
): OutputFailureAction {
  const action = requireRecord(value, location);
  rejectUnknownKeys(
    action,
    ["type", "maximum_retries", "repair_prompt"],
    location,
  );
  const type = requireEnum(action.type, ["retry", "block"], `${location}.type`);

  if (type === "block") {
    if (
      action.maximum_retries !== undefined ||
      action.repair_prompt !== undefined
    ) {
      policyError(
        `allows maximum_retries and repair_prompt only for retry at ${location}.`,
      );
    }
    return { type };
  }

  const parsed: OutputFailureAction = {
    type,
    maximumRetries:
      action.maximum_retries === undefined
        ? defaults.maximumRetries
        : requireInteger(
            action.maximum_retries,
            `${location}.maximum_retries`,
            0,
            3,
          ),
  };
  if (action.repair_prompt !== undefined) {
    parsed.repairPrompt = requireString(
      action.repair_prompt,
      `${location}.repair_prompt`,
      { maximumLength: 2_000 },
    );
  }
  return parsed;
}

function parseOutputRule(
  value: unknown,
  defaults: PolicyDefaults,
): ParsedOutputRule | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rules = requireArray(value, "output");
  if (rules.length > 1) {
    policyError("supports at most one output rule.");
  }
  if (rules.length === 0) {
    return undefined;
  }

  const location = "output[0]";
  const rule = requireRecord(rules[0], location);
  rejectUnknownKeys(
    rule,
    ["id", "validator", "schema_ref", "on_failure"],
    location,
  );
  if (rule.validator !== "json_schema") {
    policyError(`must use validator json_schema at ${location}.validator.`);
  }

  return {
    id: requireName(rule.id, `${location}.id`),
    schemaRef: requireString(rule.schema_ref, `${location}.schema_ref`),
    onFailure: parseOutputFailureAction(
      rule.on_failure,
      defaults,
      `${location}.on_failure`,
    ),
  };
}

async function readBoundedFile(path: string, label: string): Promise<string> {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    policyError(`could not read the configured ${label}.`, error);
  }
  if (!details.isFile()) {
    policyError(`must reference a regular ${label}.`);
  }
  if (details.size > MAX_FILE_SIZE) {
    policyError(`configured ${label} exceeds the 1 MiB limit.`);
  }

  try {
    return await Bun.file(path).text();
  } catch (error) {
    policyError(`could not read the configured ${label}.`, error);
  }
}

function containsExternalReference(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsExternalReference);
  }
  if (!isRecord(value)) {
    return false;
  }

  for (const referenceKeyword of ["$ref", "$dynamicRef"] as const) {
    if (
      referenceKeyword in value &&
      (typeof value[referenceKeyword] !== "string" ||
        !value[referenceKeyword].startsWith("#"))
    ) {
      return true;
    }
  }
  return Object.values(value).some(containsExternalReference);
}

async function loadSchema(
  policyDirectory: string,
  schemaRef: string,
): Promise<{ schema: unknown; validator: CompiledJsonSchemaValidator }> {
  if (isAbsolute(schemaRef) || extname(schemaRef).toLowerCase() !== ".json") {
    policyError("requires schema_ref to be a relative JSON file.");
  }

  let schemaPath: string;
  try {
    schemaPath = await realpath(resolve(policyDirectory, schemaRef));
  } catch (error) {
    policyError("could not read the configured schema.", error);
  }

  const relativePath = relative(policyDirectory, schemaPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    policyError("requires schema_ref to remain inside the policy directory.");
  }

  const source = await readBoundedFile(schemaPath, "schema file");
  let schema: unknown;
  try {
    schema = JSON.parse(source);
  } catch (error) {
    policyError("contains invalid JSON in the configured schema.", error);
  }
  if (containsExternalReference(schema)) {
    policyError("does not support remote or cross-file schema references.");
  }

  try {
    return { schema, validator: new CompiledJsonSchemaValidator(schema) };
  } catch (error) {
    policyError("contains a schema that could not be compiled.", error);
  }
}

export async function loadGuardrailPolicy(
  configuredPath: string,
  workingDirectory = process.cwd(),
): Promise<LoadedGuardrailPolicy> {
  let policyPath: string;
  try {
    policyPath = await realpath(resolve(workingDirectory, configuredPath));
  } catch (error) {
    policyError("could not read the configured policy file.", error);
  }

  const source = await readBoundedFile(policyPath, "policy file");
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    policyError("contains invalid YAML.");
  }

  let rawPolicy: unknown;
  try {
    rawPolicy = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    policyError("contains unsupported YAML aliases.", error);
  }

  const policy = requireRecord(rawPolicy, "policy");
  rejectUnknownKeys(
    policy,
    [
      "apiVersion",
      "kind",
      "enabled",
      "metadata",
      "defaults",
      "input",
      "output",
    ],
    "policy",
  );
  if (policy.apiVersion !== "guardrails/v1") {
    policyError("must use apiVersion guardrails/v1.");
  }
  if (policy.kind !== "GuardrailPolicy") {
    policyError("must use kind GuardrailPolicy.");
  }

  const metadata = requireRecord(policy.metadata, "metadata");
  rejectUnknownKeys(metadata, ["name", "version"], "metadata");
  const identity = {
    name: requireName(metadata.name, "metadata.name"),
    version: requireInteger(metadata.version, "metadata.version", 1),
  };
  const defaults = parseDefaults(policy.defaults);
  const input = parseInputRules(policy.input);
  const parsedOutput = parseOutputRule(policy.output, defaults);

  const ids = [...input.map((rule) => rule.id)];
  if (parsedOutput) {
    ids.push(parsedOutput.id);
  }
  if (new Set(ids).size !== ids.length) {
    policyError("requires globally unique rule IDs.");
  }

  const loaded: LoadedGuardrailPolicy = {
    sourcePath: policyPath,
    enabled:
      policy.enabled === undefined
        ? true
        : requireBoolean(policy.enabled, "enabled"),
    identity,
    defaults,
    input,
  };
  if (parsedOutput) {
    const compiled = await loadSchema(
      dirname(policyPath),
      parsedOutput.schemaRef,
    );
    loaded.output = {
      ...parsedOutput,
      ...compiled,
    };
  }
  return loaded;
}
