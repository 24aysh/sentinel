import type { ChatMessage } from "../../domain/chat.ts";
import { PII_ENTITIES, type PiiEntity, type PiiFinding } from "../types.ts";

const ENTITY_PRECEDENCE: Record<PiiEntity, number> = {
  CREDIT_CARD: 0,
  EMAIL: 1,
  PHONE_NUMBER: 2,
};

function luhnIsValid(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function hasTokenBoundaries(
  content: string,
  start: number,
  end: number,
): boolean {
  const before = start > 0 ? content[start - 1] : undefined;
  const after = end < content.length ? content[end] : undefined;
  return !before?.match(/[A-Za-z0-9_]/) && !after?.match(/[A-Za-z0-9_]/);
}

function findEmails(content: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const pattern =
    /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (hasTokenBoundaries(content, start, end)) {
      matches.push({ start, end });
    }
  }
  return matches;
}

function findPhoneNumbers(
  content: string,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const pattern = /(?:\+|\()?(?:\d[\s().-]?){9,14}\d/g;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    const digitCount = match[0].replace(/\D/g, "").length;
    if (
      digitCount >= 10 &&
      digitCount <= 15 &&
      hasTokenBoundaries(content, start, end)
    ) {
      matches.push({ start, end });
    }
  }
  return matches;
}

function findCreditCards(
  content: string,
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const pattern = /(?:\d[ -]?){12,18}\d/g;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (hasTokenBoundaries(content, start, end) && luhnIsValid(match[0])) {
      matches.push({ start, end });
    }
  }
  return matches;
}

const FINDERS: Record<
  PiiEntity,
  (content: string) => Array<{ start: number; end: number }>
> = {
  EMAIL: findEmails,
  PHONE_NUMBER: findPhoneNumbers,
  CREDIT_CARD: findCreditCards,
};

function findingsOverlap(first: PiiFinding, second: PiiFinding): boolean {
  return first.messageIndex === second.messageIndex && first.end > second.start;
}

export function detectPii(messages: readonly ChatMessage[]): PiiFinding[] {
  const findings: PiiFinding[] = [];

  messages.forEach((message, messageIndex) => {
    for (const entity of PII_ENTITIES) {
      for (const match of FINDERS[entity](message.content)) {
        findings.push({
          entity,
          messageIndex,
          role: message.role,
          start: match.start,
          end: match.end,
        });
      }
    }
  });

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
    if (!previous || !findingsOverlap(previous, finding)) {
      normalized.push(finding);
    }
  }
  return normalized;
}
