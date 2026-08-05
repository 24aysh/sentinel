import Ajv2020, {
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { JsonSchemaValidator } from "../types.ts";

export class CompiledJsonSchemaValidator implements JsonSchemaValidator {
  readonly schema: unknown;
  private readonly validateFunction: ValidateFunction;

  constructor(schema: unknown) {
    if (
      typeof schema !== "boolean" &&
      (typeof schema !== "object" || schema === null || Array.isArray(schema))
    ) {
      throw new TypeError("A JSON Schema must be an object or boolean.");
    }

    const ajv = new Ajv2020({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
    });
    addFormats(ajv, { mode: "fast" });

    this.schema = schema;
    this.validateFunction = ajv.compile(schema as AnySchema);
  }

  validate(value: unknown): boolean {
    return this.validateFunction(value) === true;
  }
}
