import { CompiledJsonSchemaValidator } from "../../src/guardrails/output/json-schema-validator.ts";
import type {
  InputActionType,
  InputPolicyRule,
  LoadedGuardrailPolicy,
  OutputFailureAction,
  RuntimeFailureMode,
} from "../../src/guardrails/types.ts";

interface PolicyOptions {
  input?: InputPolicyRule[];
  inputAction?: InputActionType;
  runtimeFailureMode?: RuntimeFailureMode;
  output?: {
    schema: unknown;
    onFailure: OutputFailureAction;
  };
}

export function createTestPolicy(
  options: PolicyOptions = {},
): LoadedGuardrailPolicy {
  const policy: LoadedGuardrailPolicy = {
    sourcePath: "/test/policy.yaml",
    enabled: true,
    identity: { name: "test-policy", version: 1 },
    defaults: {
      inputAction: options.inputAction ?? "allow",
      runtimeFailureMode: options.runtimeFailureMode ?? "closed",
      maximumRetries: 1,
    },
    input: options.input ?? [],
  };

  if (options.output) {
    policy.output = {
      id: "test-output",
      schemaRef: "schema.json",
      schema: options.output.schema,
      validator: new CompiledJsonSchemaValidator(options.output.schema),
      onFailure: options.output.onFailure,
    };
  }
  return policy;
}
