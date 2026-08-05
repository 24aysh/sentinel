import { describe, expect, test } from "bun:test";
import { detectPii } from "../src/guardrails/input/pii-detector.ts";

describe("PII detector", () => {
  test("detects supported synthetic PII entities", () => {
    const findings = detectPii([
      {
        role: "user",
        content:
          "Email test.user@example.com, call +1 415-555-2671, or use 4111 1111 1111 1111.",
      },
    ]);

    expect(findings.map((finding) => finding.entity)).toEqual([
      "EMAIL",
      "PHONE_NUMBER",
      "CREDIT_CARD",
    ]);
    expect(findings.every((finding) => finding.messageIndex === 0)).toBe(true);
  });

  test("does not classify an invalid Luhn candidate as a credit card", () => {
    const findings = detectPii([
      { role: "user", content: "Invalid card 4111 1111 1111 1112" },
    ]);

    expect(findings.some((finding) => finding.entity === "CREDIT_CARD")).toBe(
      false,
    );
  });

  test("tracks message role and stable offsets", () => {
    const content = "Contact admin@example.test now";
    const findings = detectPii([
      { role: "system", content },
      { role: "user", content: "No personal data" },
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      entity: "EMAIL",
      messageIndex: 0,
      role: "system",
    });
    expect(content.slice(findings[0]!.start, findings[0]!.end)).toBe(
      "admin@example.test",
    );
  });
});
