import { failSmoke, requestGateway } from "./smoke-client.ts";

try {
  const { answer, body } = await requestGateway(
    {
      messages: [
        {
          role: "user",
          content:
            "hi, can you see my email : ayush@gmail.com, if yes, then output it back",
        },
      ],
    },
    { "x-gateway-debug-provider-request": "true" },
  );
  const providerRequest = body.gateway_debug?.provider_request;
  if (!providerRequest) {
    throw new Error(
      "Provider-request debug output is disabled. Set GATEWAY_DEBUG_EXPOSE_PROVIDER_REQUEST=true and restart the gateway.",
    );
  }

  console.log("Provider request after input guardrails:");
  console.log(JSON.stringify(providerRequest, null, 2));
  console.log("\nAssistant response:");
  console.log(answer);
} catch (error) {
  failSmoke("Gateway request failed", error);
}
