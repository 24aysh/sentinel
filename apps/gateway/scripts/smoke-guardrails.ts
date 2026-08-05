type GuardrailSmokeResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    code?: string;
    message?: string;
  };
};

const rawEmail = "smoke.gateway@gmail.com";
const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:3001").replace(
  /\/+$/,
  "",
);

try {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "guardrail-e2e-smoke",
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content:
            `Return only JSON with status "ok", a short message confirming ` +
            `the gateway works, and contact exactly as provided: ${rawEmail}`,
        },
      ],
    }),
  });

  const body = (await response.json()) as GuardrailSmokeResponse;
  if (!response.ok) {
    const code = body.error?.code || "UNKNOWN_ERROR";
    const message =
      body.error?.message || `Gateway returned HTTP ${response.status}`;
    throw new Error(`${code}: ${message}`);
  }

  const answer = body.choices?.[0]?.message?.content;
  if (!answer) {
    throw new Error("The gateway returned no assistant response.");
  }

  const parsed = JSON.parse(answer) as {
    status?: unknown;
    message?: unknown;
    contact?: unknown;
  };
  if (
    parsed.status !== "ok" ||
    typeof parsed.message !== "string" ||
    parsed.message.length === 0 ||
    parsed.contact !== "<EMAIL>"
  ) {
    throw new Error(
      "The response did not demonstrate the configured input and output guardrails.",
    );
  }

  console.log(answer);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Guardrail gateway request failed: ${message}`);
  console.error(
    "Start the gateway with GUARDRAIL_POLICY_PATH=policies/example-policy.yaml and enabled: true.",
  );
  process.exit(1);
}
