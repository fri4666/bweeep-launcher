import {
  createDisplaySessionToken,
  isDisplaySessionToken,
  normalizeDisplayName
} from "./display-name.ts";

Deno.test("normalizes supported server display names", () => {
  if (normalizeDisplayName("  서우  님 ") !== "서우 님") {
    throw new Error("Korean display names should be normalized.");
  }
  if (normalizeDisplayName("seos_py") !== "seos_py") {
    throw new Error("Minecraft-safe names should remain unchanged.");
  }
});

Deno.test("rejects invalid server display names", () => {
  if (normalizeDisplayName("a") !== null || normalizeDisplayName("bad!") !== null) {
    throw new Error("Invalid display names must be rejected.");
  }
});

Deno.test("creates fixed-length display session tokens", () => {
  const first = createDisplaySessionToken();
  const second = createDisplaySessionToken();
  if (!isDisplaySessionToken(first) || !isDisplaySessionToken(second) || first === second) {
    throw new Error("Display session tokens must be unique 256-bit base64url values.");
  }
});
