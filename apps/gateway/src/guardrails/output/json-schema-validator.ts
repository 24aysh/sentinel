import Ajv2020, {
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const DRAFT_2020_12_SCHEMA = "https://json-schema.org/draft/2020-12/schema";

export class CompiledJsonSchemaValidator {
  private readonly validateFunction: ValidateFunction;

  constructor(schema: unknown) {
    if (
      typeof schema !== "object" ||
      schema === null ||
      Array.isArray(schema)
    ) {
      throw new TypeError("An output JSON Schema must be an object.");
    }

    const root = schema as Record<string, unknown>;
    if (root.type !== "object") {
      throw new TypeError(
        "An output JSON Schema must explicitly declare an object root.",
      );
    }
    if (root.$schema !== undefined && root.$schema !== DRAFT_2020_12_SCHEMA) {
      throw new TypeError("An output JSON Schema must use Draft 2020-12.");
    }

    const ajv = new Ajv2020({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
    });
    addFormats(ajv, { mode: "fast" });

    this.validateFunction = ajv.compile(schema as AnySchema);
  }

  validate(value: unknown): boolean {
    return this.validateFunction(value) === true;
  }
}
