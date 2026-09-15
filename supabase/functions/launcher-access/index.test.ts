import { getBearerToken } from "./authorization.ts";

Deno.test("reads a standard Authorization Bearer header", () => {
  const request = new Request("https://example.invalid", {
    headers: { Authorization: "Bearer launcher-access-token" }
  });

  if (getBearerToken(request) !== "launcher-access-token") {
    throw new Error("A standard Bearer token was not parsed.");
  }
});

Deno.test("rejects missing and non-Bearer authorization headers", () => {
  const missing = new Request("https://example.invalid");
  const basic = new Request("https://example.invalid", {
    headers: { Authorization: "Basic credentials" }
  });

  if (getBearerToken(missing) !== null || getBearerToken(basic) !== null) {
    throw new Error("Only Bearer authorization headers must be accepted.");
  }
});
