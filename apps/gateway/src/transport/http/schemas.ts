import { t } from "elysia";

const chatMessageSchema = t.Object(
  {
    role: t.Union([
      t.Literal("system"),
      t.Literal("user"),
      t.Literal("assistant"),
    ]),
    content: t.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const chatCompletionBodySchema = t.Object(
  {
    model: t.Optional(t.String({ minLength: 1 })),
    messages: t.Array(chatMessageSchema, { minItems: 1 }),
    temperature: t.Optional(t.Number({ minimum: 0, maximum: 2 })),
    max_tokens: t.Optional(t.Integer({ minimum: 1 })),
    stream: t.Optional(t.Boolean()),
  },
  { additionalProperties: false },
);
