import { failSmoke, requestGateway } from "./smoke-client.ts";

try {
  const rawEmail = "smoke.gateway@gmail.com";
  const { answer } = await requestGateway(
    {
      messages: [
        {
          role: "user",
          content:
            `Return only JSON with status "ok", a short message confirming ` +
            `the gateway works, and contact exactly as provided: ${rawEmail}`,
        },
      ],
    },
    { "x-request-id": "guardrail-e2e-smoke" },
  );
  const parsed = JSON.parse(answer) as {
    status?: unknown;
    message?: unknown;
    contact?: unknown;
  };
  if (
    parsed.status !== "ok" ||
    typeof parsed.message !== "string" ||
    !parsed.message ||
    parsed.contact !== "<EMAIL>"
  ) {
    throw new Error(
      "The response did not demonstrate the configured input and output guardrails.",
    );
  }
  console.log(answer);
} catch (error) {
  failSmoke(
    "Guardrail gateway request failed",
    error,
    "Start the gateway with GUARDRAIL_POLICY_PATH=policies/example-policy.yaml and enabled: true.",
  );
}
