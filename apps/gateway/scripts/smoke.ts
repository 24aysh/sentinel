type ChatCompletionResponse = {
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

const gatewayUrl = (process.env.GATEWAY_URL || "http://localhost:3001").replace(
  /\/+$/,
  "",
);

try {
  const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  const body = (await response.json()) as ChatCompletionResponse;

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

  console.log(answer);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Gateway request failed: ${message}`);
  process.exit(1);
}
1