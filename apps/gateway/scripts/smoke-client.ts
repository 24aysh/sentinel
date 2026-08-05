interface SmokeResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { code?: string; message?: string };
  gateway_debug?: { provider_request?: Record<string, unknown> };
}

const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:3001").replace(
  /\/+$/,
  "",
);

export async function requestGateway(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ answer: string; body: SmokeResponse }> {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as SmokeResponse;
  if (!response.ok) {
    throw new Error(
      `${body.error?.code || "UNKNOWN_ERROR"}: ${body.error?.message || `Gateway returned HTTP ${response.status}`}`,
    );
  }

  const answer = body.choices?.[0]?.message?.content;
  if (!answer) throw new Error("The gateway returned no assistant response.");
  return { answer, body };
}

export function failSmoke(
  prefix: string,
  error: unknown,
  hint?: string,
): never {
  console.error(
    `${prefix}: ${error instanceof Error ? error.message : "Unknown error"}`,
  );
  if (hint) console.error(hint);
  process.exit(1);
}
