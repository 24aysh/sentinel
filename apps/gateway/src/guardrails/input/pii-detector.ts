import type { ChatMessage } from "../../domain/chat.ts";
import { PII_ENTITIES, type PiiEntity, type PiiFinding } from "../types.ts";
import {
  validCard,
  validDatabaseConnectionString,
  validEmail,
  validIp,
  validJwt,
  validPhone,
  validPrivateKey,
  validSecret,
} from "./pii-validators.ts";

type Span = Pick<PiiFinding, "start" | "end">;
type Finder = (content: string) => Span[];

const PRECEDENCE: Record<PiiEntity, number> = {
  PRIVATE_KEY: 0,
  DATABASE_CONNECTION_STRING: 1,
  JWT: 2,
  CLOUD_CREDENTIAL: 3,
  API_KEY: 4,
  CREDIT_CARD: 5,
  EMAIL: 6,
  IP_ADDRESS: 7,
  PHONE_NUMBER: 8,
};

function find(
  content: string,
  pattern: RegExp,
  accept: (value: string) => boolean = () => true,
  captured = false,
): Span[] {
  const spans: Span[] = [];
  for (const match of content.matchAll(pattern)) {
    const value = captured ? match[1] : match[0];
    if (!value || !accept(value)) continue;
    const start = match.index + (captured ? match[0].lastIndexOf(value) : 0);
    const end = start + value.length;
    if (
      !/[A-Za-z0-9_]/.test(content[start - 1] ?? "") &&
      !/[A-Za-z0-9_]/.test(content[end] ?? "")
    ) {
      spans.push({ start, end });
    }
  }
  return spans;
}

function trimConnection(value: string): string {
  return value.replace(/[,.!?)}\]]+$/, "");
}

function databaseConnections(content: string): Span[] {
  const patterns = [
    /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?):\/\/[^\s<>"'`]{1,4096}/gi,
    /(?:jdbc:)?sqlserver:\/\/[^\s<>"'`]{1,4096}/gi,
    /(?:Driver=\{[^}\r\n]{1,128}\};\s*)?(?:(?:Server|Data Source)=[^;\r\n]{1,256};)(?:[^;\r\n=]{1,64}=[^;\r\n]{1,512};?){1,16}/gi,
  ];
  return patterns.flatMap((pattern) => {
    const spans: Span[] = [];
    for (const match of content.matchAll(pattern)) {
      const value = trimConnection(match[0]);
      if (validDatabaseConnectionString(value)) {
        spans.push({ start: match.index, end: match.index + value.length });
      }
    }
    return spans;
  });
}

const FINDERS: Record<PiiEntity, Finder> = {
  EMAIL: (content) =>
    find(
      content,
      /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,255}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi,
      validEmail,
    ),
  PHONE_NUMBER: (content) =>
    find(
      content,
      /(?:\+|\()?(?:\d[\s().-]{0,3}){9,14}\d(?:\s*(?:x|ext\.?)\s*\d{1,6})?/gi,
      validPhone,
    ),
  IP_ADDRESS: (content) =>
    [
      ...find(content, /(?:\d{1,3}\.){3}\d{1,3}/g, validIp),
      ...find(content, /\[?[A-F\d]*:[A-F\d:.]*\]?/gi, validIp),
    ].filter(({ end }) => !/^(?::\d+|\/\d+)/.test(content.slice(end))),
  API_KEY: (content) => [
    ...find(
      content,
      /(?:sk-[A-Za-z\d_-]{20,128}|gh[pousr]_[A-Za-z\d]{36,255}|github_pat_[A-Za-z\d_]{20,255}|xox[baprs]-[A-Za-z\d-]{10,200}|[sr]k_live_[A-Za-z\d]{16,128})/g,
      validSecret,
    ),
    ...find(
      content,
      /\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|token|secret)\b\s*[:=]\s*["']?([A-Za-z\d_+/.=-]{20,256})/gi,
      validSecret,
      true,
    ),
  ],
  JWT: (content) =>
    find(
      content,
      /[A-Za-z\d_-]{2,2048}\.[A-Za-z\d_-]{2,8192}\.[A-Za-z\d_-]{1,2048}/g,
      validJwt,
    ),
  PRIVATE_KEY: (content) =>
    find(
      content,
      /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[A-Za-z\d+/=\s]{1,65536}?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
      validPrivateKey,
    ),
  CLOUD_CREDENTIAL: (content) => [
    ...find(content, /(?:AKIA|ASIA)[A-Z\d]{16}/g),
    ...find(content, /AIza[A-Za-z\d_-]{35}/g),
    ...find(
      content,
      /\baws_secret_access_key\b\s*[:=]\s*["']?([A-Za-z\d/+=]{40})/gi,
      (value) => validSecret(value, 40, 40),
      true,
    ),
    ...find(
      content,
      /"private_key_id"\s*:\s*"([A-F\d]{40})"/gi,
      undefined,
      true,
    ),
    ...find(
      content,
      /\b(?:AccountKey|azure_storage_key)\b\s*[:=]\s*["']?([A-Za-z\d+/]{86}==)/gi,
      (value) => validSecret(value, 88, 88),
      true,
    ),
    ...find(content, /sv=[^\s<>"',.!?)\]}]{1,2048}/gi, (value) => {
      const parameters = new URLSearchParams(value);
      return Boolean(
        parameters.get("sv") &&
        parameters.get("sig") &&
        ["sp", "sr", "ss", "srt"].some((name) => parameters.has(name)),
      );
    }),
  ],
  CREDIT_CARD: (content) => find(content, /\d(?:[ -]?\d){12,18}/g, validCard),
  DATABASE_CONNECTION_STRING: databaseConnections,
};

function better(first: PiiFinding, second: PiiFinding): PiiFinding {
  const priority = PRECEDENCE[first.entity] - PRECEDENCE[second.entity];
  if (priority !== 0) return priority < 0 ? first : second;
  const firstLength = first.end - first.start;
  const secondLength = second.end - second.start;
  if (firstLength !== secondLength)
    return firstLength > secondLength ? first : second;
  return first.start <= second.start ? first : second;
}

export function detectPii(messages: readonly ChatMessage[]): PiiFinding[] {
  const findings = messages.flatMap((message, messageIndex) => {
    const content = message.content;
    if (typeof content !== "string") return [];
    return PII_ENTITIES.flatMap((entity) =>
      FINDERS[entity](content).map((span) => ({
        entity,
        messageIndex,
        role: message.role,
        ...span,
      })),
    );
  });
  findings.sort(
    (a, b) =>
      a.messageIndex - b.messageIndex || a.start - b.start || a.end - b.end,
  );

  const normalized: PiiFinding[] = [];
  for (let index = 0; index < findings.length;) {
    let winner = findings[index]!;
    let groupEnd = winner.end;
    let next = index + 1;
    while (
      next < findings.length &&
      findings[next]!.messageIndex === winner.messageIndex &&
      findings[next]!.start < groupEnd
    ) {
      groupEnd = Math.max(groupEnd, findings[next]!.end);
      winner = better(winner, findings[next]!);
      next += 1;
    }
    normalized.push(winner);
    index = next;
  }
  return normalized;
}
