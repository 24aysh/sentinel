import type { ChatMessage } from "../../domain/chat.ts";
import { PII_ENTITIES, type PiiEntity, type PiiFinding } from "../types.ts";

type Span = Pick<PiiFinding, "start" | "end">;

const ENTITY_PRECEDENCE: Record<PiiEntity, number> = {
  CREDIT_CARD: 0,
  EMAIL: 1,
  PHONE_NUMBER: 2,
};

function validLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if ((digits.length - index) % 2 === 0 && (digit *= 2) > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

function find(
  content: string,
  pattern: RegExp,
  accept: (candidate: string) => boolean = () => true,
): Span[] {
  const spans: Span[] = [];
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const before = content[start - 1];
    const after = content[end];
    if (
      !/[A-Za-z0-9_]/.test(before ?? "") &&
      !/[A-Za-z0-9_]/.test(after ?? "") &&
      accept(match[0])
    ) {
      spans.push({ start, end });
    }
  }
  return spans;
}

const FINDERS: Record<PiiEntity, (content: string) => Span[]> = {
  EMAIL: (content) =>
    find(
      content,
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi,
    ),
  PHONE_NUMBER: (content) =>
    find(content, /(?:\+|\()?(?:\d[\s().-]?){9,14}\d/g, (candidate) => {
      const length = candidate.replace(/\D/g, "").length;
      return length >= 10 && length <= 15;
    }),
  CREDIT_CARD: (content) => find(content, /(?:\d[ -]?){12,18}\d/g, validLuhn),
};

export function detectPii(messages: readonly ChatMessage[]): PiiFinding[] {
  const findings = messages.flatMap((message, messageIndex) =>
    PII_ENTITIES.flatMap((entity) =>
      FINDERS[entity](message.content).map((span) => ({
        entity,
        messageIndex,
        role: message.role,
        ...span,
      })),
    ),
  );

  findings.sort((first, second) =>
    first.messageIndex !== second.messageIndex
      ? first.messageIndex - second.messageIndex
      : first.start !== second.start
        ? first.start - second.start
        : first.end !== second.end
          ? second.end - first.end
          : ENTITY_PRECEDENCE[first.entity] - ENTITY_PRECEDENCE[second.entity],
  );

  const normalized: PiiFinding[] = [];
  for (const finding of findings) {
    const previous = normalized.at(-1);
    if (
      previous?.messageIndex !== finding.messageIndex ||
      previous.end <= finding.start
    ) {
      normalized.push(finding);
    }
  }
  return normalized;
}
