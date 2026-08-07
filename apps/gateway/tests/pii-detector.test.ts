import { describe, expect, test } from "bun:test";
import { detectPii } from "../src/guardrails/input/pii-detector.ts";

const encoded = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({ sub: "synthetic-user" })}.${Buffer.from("synthetic-signature").toString("base64url")}`;
const privateKey = `-----BEGIN PRIVATE KEY-----\n${Buffer.from("synthetic private key bytes").toString("base64")}\n-----END PRIVATE KEY-----`;

describe("PII detector", () => {
  test("detects supported synthetic PII entities", () => {
    const findings = detectPii([
      {
        role: "user",
        content: [
          "test.user@example.com",
          "+1 415-555-2671",
          "192.0.2.10",
          "api_key=Q7vN2xL9mR4pT8kW6cY3zF1h",
          jwt,
          privateKey,
          "AKIAIOSFODNN7EXAMPLE",
          "4111 1111 1111 1111",
          "postgresql://user:pass@db.example.test:5432/app",
        ].join(" | "),
      },
    ]);

    expect(findings.map((finding) => finding.entity)).toEqual([
      "EMAIL",
      "PHONE_NUMBER",
      "IP_ADDRESS",
      "API_KEY",
      "JWT",
      "PRIVATE_KEY",
      "CLOUD_CREDENTIAL",
      "CREDIT_CARD",
      "DATABASE_CONNECTION_STRING",
    ]);
    expect(findings.every((finding) => finding.messageIndex === 0)).toBe(true);
    expect(findings.every((finding) => !("value" in finding))).toBe(true);
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

  test("rejects structurally invalid look-alikes", () => {
    const invalidByEntity = {
      EMAIL: "invalid..email@example.com",
      PHONE_NUMBER: "+1 111-111-1111",
      IP_ADDRESS: "999.0.2.10",
      API_KEY: "api_key=aaaaaaaaaaaaaaaaaaaaaaaa",
      JWT: "eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.c2ln",
      PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nnot-base64!\n-----END PRIVATE KEY-----",
      CLOUD_CREDENTIAL: "AKIAIOSFODNN7EXAMPL",
      CREDIT_CARD: "4111 1111 1111 1112",
      DATABASE_CONNECTION_STRING: "https://user:pass@example.test/app",
    } as const;

    for (const [entity, content] of Object.entries(invalidByEntity)) {
      expect(
        detectPii([{ role: "user", content }]).some(
          (finding) => finding.entity === entity,
        ),
      ).toBe(false);
    }
  });

  test("keeps the highest-protection span for overlaps", () => {
    const connection =
      "postgresql://user:pass@192.0.2.10:5432/app?token=Q7vN2xL9mR4pT8kW6cY3zF1h";
    const findings = detectPii([{ role: "user", content: connection }]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.entity).toBe("DATABASE_CONNECTION_STRING");
    expect(connection.slice(findings[0]?.start, findings[0]?.end)).toBe(
      connection,
    );
  });
});
