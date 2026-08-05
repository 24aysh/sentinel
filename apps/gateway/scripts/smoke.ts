type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAnswer(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return undefined;
  }

  const firstChoice = value.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    return undefined;
  }

  return typeof firstChoice.message.content === "string"
    ? firstChoice.message.content
    : undefined;
}

const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:3001").replace(
  /\/+$/,
  "",
);

let response: Response;
try {
  response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: "Reply with a short confirmation that the gateway works.",
        },
      ],
      temperature: 0,
      max_tokens: 64,
      stream: false,
    }),
  });
} catch {
  console.error(`Could not connect to the gateway at ${gatewayUrl}.`);
  process.exit(1);
}

let body: unknown;
try {
  body = await response.json();
} catch {
  console.error(
    `Gateway returned non-JSON data with status ${response.status}.`,
  );
  process.exit(1);
}

if (!response.ok) {
  const code =
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.code === "string"
      ? body.error.code
      : "UNKNOWN_ERROR";
  const message =
    isRecord(body) &&
    isRecord(body.error) &&
    typeof body.error.message === "string"
      ? body.error.message
      : "The gateway request failed.";
  console.error(`Gateway smoke test failed (${code}): ${message}`);
  process.exit(1);
}

const answer = readAnswer(body);
if (!isRecord(body) || typeof body.model !== "string" || !answer) {
  console.error("Gateway returned an invalid chat-completion response.");
  process.exit(1);
}

console.info(
  JSON.stringify(
    {
      status: "ok",
      requestId: response.headers.get("x-request-id"),
      durationMs: response.headers.get("x-gateway-duration-ms"),
      model: body.model,
      answer,
    },
    null,
    2,
  ),
);
