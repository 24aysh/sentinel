import { t } from "elysia";
import { CHAT_ROLES } from "../../domain/chat.ts";

const chatMessageSchema = t.Object(
  {
    role: t.Union(CHAT_ROLES.map((role) => t.Literal(role))),
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
