import { describe, expect, test } from "bun:test";
import * as sdk from "../src/index.ts";
import * as server from "../src/server.ts";
import { FakeProvider } from "./helpers/fake-provider.ts";

describe("public SDK entry points", () => {
  test("exports the documented class API without starting a server", async () => {
    expect(sdk.ModelGateway).toBeFunction();
    expect(sdk.OpenAICompatibleProvider).toBeFunction();
    expect(sdk.GatewayError).toBeFunction();
    expect(server.createApp).toBeFunction();
    expect(server.createRuntime).toBeFunction();

    const gateway = new sdk.ModelGateway({
      provider: new FakeProvider(),
      defaultModel: "entry-test-model",
    });
    const result = await gateway.chat.completions.create({
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.providerRequest.model).toBe("entry-test-model");
  });
});
