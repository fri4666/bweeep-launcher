import { getBearerToken } from "./authorization.ts";
import { previousGameNames } from "./profile-history.ts";

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

Deno.test("returns only distinct, valid historical game names", () => {
  const result = previousGameNames("new_name", [
    { game_name: "old_name" },
    { game_name: "new_name" },
    { game_name: "old_name" },
    { game_name: "이름" },
    { game_name: "x" }
  ]);
  if (result.length !== 1 || result[0] !== "old_name") {
    throw new Error("Historical game names were not filtered and deduplicated.");
  }
});
