import { createGameTicket, isGameName, isGameTicket } from "./game-ticket.ts";

Deno.test("creates unpredictable fixed-length game tickets", () => {
  const first = createGameTicket();
  const second = createGameTicket();
  if (!isGameTicket(first) || !isGameTicket(second) || first === second) {
    throw new Error("Game tickets must be unique 256-bit base64url values.");
  }
});

Deno.test("accepts only Minecraft-safe game names", () => {
  if (!isGameName("seos_py_b8ce") || isGameName("한글 이름") || isGameName("ab")) {
    throw new Error("Minecraft name validation is incorrect.");
  }
});
