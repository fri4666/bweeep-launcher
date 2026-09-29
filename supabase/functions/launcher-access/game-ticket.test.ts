import { createGameTicket, isGameName, isGameTicket, ticketNameProblem } from "./game-ticket.ts";

Deno.test("a ticket is only issued for the member's own, unclaimed name", () => {
  if (ticketNameProblem("seos_py", "seos_py", true) !== null) throw new Error("The member's own free name must be accepted.");
  if (ticketNameProblem("other_admin", "seos_py", true)?.code !== "GAME_NAME_MISMATCH") {
    throw new Error("A ticket for someone else's name must be refused.");
  }
  if (ticketNameProblem("seos_py", "seos_py", false)?.code !== "GAME_NAME_TAKEN") {
    throw new Error("A name another member owns must be refused.");
  }
});

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
