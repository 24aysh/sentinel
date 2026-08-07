import { Buffer } from "node:buffer";
import { isIP } from "node:net";

const PLACEHOLDER =
  /^(?:example|sample|dummy|test|secret|token|password|redacted|placeholder|changeme|your[-_]?.*)$/i;
const SEQUENCES = [
  "0123456789",
  "1234567890",
  "9876543210",
  "abcdefghijklmnopqrstuvwxyz",
  "zyxwvutsrqponmlkjihgfedcba",
];

function looksFake(value: string): boolean {
  const compact = value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const digits = [...compact].map(Number);
  const sequentialDigits =
    /^\d+$/.test(compact) &&
    ([1, 9] as const).some((step) =>
      digits
        .slice(1)
        .every((digit, index) => digit === (digits[index]! + step) % 10),
    );
  return (
    compact.length === 0 ||
    /^(.)\1+$/.test(compact) ||
    /^(.{1,4})\1+$/.test(compact) ||
    PLACEHOLDER.test(compact) ||
    /example|dummy|placeholder|redacted|changeme/i.test(value) ||
    sequentialDigits ||
    SEQUENCES.some((sequence) => sequence.includes(compact))
  );
}

function decodeBase64(value: string, url = false): Buffer | undefined {
  const alphabet = url
    ? /^[A-Za-z0-9_-]+$/
    : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!alphabet.test(value) || (url && value.length % 4 === 1)) return;
  try {
    const decoded = Buffer.from(value, url ? "base64url" : "base64");
    const encoded = decoded.toString(url ? "base64url" : "base64");
    if (encoded !== value) return;
    return decoded;
  } catch {
    return;
  }
}

export function validEmail(value: string): boolean {
  if (value.length > 254) return false;
  const at = value.lastIndexOf("@");
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    at < 1 ||
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return false;
  }
  const labels = domain.split(".");
  return (
    domain.length <= 253 &&
    labels.length > 1 &&
    labels.every(
      (label) =>
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
}

export function validPhone(value: string): boolean {
  const extension = /\s*(?:x|ext\.?)\s*\d{1,6}$/i.exec(value);
  const number = extension ? value.slice(0, extension.index) : value;
  if (
    !/^\+?[\d\s().-]+$/.test(number) ||
    (number.match(/\(/g)?.length ?? 0) !== (number.match(/\)/g)?.length ?? 0) ||
    number.indexOf(")") < number.indexOf("(") ||
    (number.startsWith("+") && !/^\+[1-9]/.test(number)) ||
    (!number.startsWith("+") && !/[\s().-]/.test(number))
  ) {
    return false;
  }
  const digits = number.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && !looksFake(digits);
}

export function validIp(value: string): boolean {
  const bare =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return isIP(bare) !== 0;
}

export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

export function validSecret(
  value: string,
  minimum = 20,
  maximum = 256,
): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  return (
    value.length >= minimum &&
    value.length <= maximum &&
    !looksFake(value) &&
    new Set(value).size >= 8 &&
    classes >= 2 &&
    entropy(value) >= 3.5
  );
}

function jsonObject(segment: string): Record<string, unknown> | undefined {
  const decoded = decodeBase64(segment, true);
  if (!decoded) return;
  try {
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return;
  }
}

export function validJwt(value: string): boolean {
  if (value.length > 12_288) return false;
  const segments = value.split(".");
  if (
    segments.length !== 3 ||
    segments[0]!.length > 2_048 ||
    segments[1]!.length > 8_192 ||
    segments[2]!.length > 2_048
  ) {
    return false;
  }
  const header = jsonObject(segments[0]!);
  const payload = jsonObject(segments[1]!);
  const algorithm = header?.alg;
  return (
    payload !== undefined &&
    typeof algorithm === "string" &&
    /^(?!none$)[A-Za-z0-9_-]{1,32}$/i.test(algorithm) &&
    (decodeBase64(segments[2]!, true)?.length ?? 0) > 0
  );
}

const PRIVATE_KEY_LABELS = new Set([
  "PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "DSA PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
]);

export function validPrivateKey(value: string): boolean {
  if (value.length > 70_000) return false;
  const match =
    /^-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END \1-----$/.exec(
      value,
    );
  if (!match || !PRIVATE_KEY_LABELS.has(match[1]!)) return false;
  const body = match[2]!.replace(/\s/g, "");
  return body.length <= 65_536 && (decodeBase64(body)?.length ?? 0) > 0;
}

export function validCard(value: string): boolean {
  if (!/^\d(?:[ -]?\d){12,18}$/.test(value)) return false;
  const separators = value.match(/[ -]/g) ?? [];
  if (new Set(separators).size > 1) return false;
  const digits = value.replace(/\D/g, "");
  if (digits[0] === "0" || looksFake(digits) || looksFake(digits.slice(0, -1)))
    return false;

  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if ((digits.length - index) % 2 === 0 && (digit *= 2) > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

const DATABASE_SCHEMES = new Set([
  "postgres:",
  "postgresql:",
  "mysql:",
  "mariadb:",
  "mongodb:",
  "mongodb+srv:",
  "redis:",
  "rediss:",
]);

function validDatabaseUrl(value: string): boolean {
  if (/%(?![\dA-F]{2})/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (!DATABASE_SCHEMES.has(url.protocol) || !url.hostname) return false;
    return url.protocol.startsWith("redis") || url.pathname.length > 1;
  } catch {
    return false;
  }
}

function dsnFields(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of value.split(";")) {
    const separator = field.indexOf("=");
    const key = field.slice(0, separator).trim().toLowerCase();
    const item = field.slice(separator + 1).trim();
    if (separator > 0 && key && item) result.set(key, item);
  }
  return result;
}

export function validDatabaseConnectionString(value: string): boolean {
  if (value.length > 4_096) return false;
  if (
    /^(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?):\/\//i.test(
      value,
    )
  ) {
    return validDatabaseUrl(value);
  }
  if (/^(?:jdbc:)?sqlserver:\/\//i.test(value)) {
    const [endpoint, ...parameters] = value
      .replace(/^(?:jdbc:)?sqlserver:\/\//i, "")
      .split(";");
    const fields = dsnFields(parameters.join(";"));
    return (
      Boolean(endpoint) &&
      (fields.has("database") || fields.has("databasename"))
    );
  }
  const fields = dsnFields(value);
  const driver = fields.get("driver");
  return (
    (!driver || /sql server/i.test(driver)) &&
    (fields.has("server") || fields.has("data source")) &&
    (fields.has("database") || fields.has("initial catalog"))
  );
}
