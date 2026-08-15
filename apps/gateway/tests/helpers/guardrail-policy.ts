import { CompiledJsonSchemaValidator } from "../../src/guardrails/output/json-schema-validator.ts";
import type {
  InputActionType,
  InputExecutionMode,
  InputPolicyRule,
  LoadedGuardrailPolicy,
  OutputFailureAction,
  RuntimeFailureMode,
  ToolPolicy,
} from "../../src/guardrails/types.ts";

interface PolicyOptions {
  input?: InputPolicyRule[];
  inputAction?: InputActionType;
  inputExecutionMode?: InputExecutionMode;
  runtimeFailureMode?: RuntimeFailureMode;
  output?: {
    schema: unknown;
    onFailure: OutputFailureAction;
  };
  tools?: ToolPolicy;
}

export function createTestPolicy(
  options: PolicyOptions = {},
): LoadedGuardrailPolicy {
  const policy: LoadedGuardrailPolicy = {
    enabled: true,
    identity: { name: "test-policy", version: 1 },
    defaults: {
      inputAction: options.inputAction ?? "allow",
      inputExecutionMode: options.inputExecutionMode ?? "sequential",
      runtimeFailureMode: options.runtimeFailureMode ?? "closed",
      maximumRetries: 1,
    },
    input: options.input ?? [],
    ...(options.tools && { tools: options.tools }),
  };

  if (options.output) {
    policy.output = {
      id: "test-output",
      schema: options.output.schema,
      validator: new CompiledJsonSchemaValidator(options.output.schema),
      onFailure: options.output.onFailure,
    };
  }
  return policy;
}
