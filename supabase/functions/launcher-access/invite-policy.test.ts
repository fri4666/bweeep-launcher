import { decideInvite, isInviteOpen } from "./invite-policy.ts";

Deno.test("members can only create single-use invites", () => {
  const decision = decideInvite("member", 20, 0);
  if (!decision.ok || decision.maxUses !== 1 || decision.expiresInDays !== 7) {
    throw new Error("Member invites must be clamped to one use and seven days.");
  }
});

Deno.test("members are capped on open invites", () => {
  if (decideInvite("member", 1, 2).ok !== true) throw new Error("A member below the cap must be allowed.");
  if (decideInvite("member", 1, 3).ok !== false) throw new Error("A member at the cap must be refused.");
});

Deno.test("admins can create group invites up to twenty uses", () => {
  const group = decideInvite("admin", 10, 50);
  const clamped = decideInvite("admin", 99, 0);
  if (!group.ok || group.maxUses !== 10 || !clamped.ok || clamped.maxUses !== 20) {
    throw new Error("Admin invites must allow 1-20 uses without an open-invite cap.");
  }
});

Deno.test("only unexpired, unrevoked, unused invites count as open", () => {
  const now = Date.parse("2026-09-28T00:00:00Z");
  const base = { expires_at: "2026-10-01T00:00:00Z", max_uses: 1, uses: 0, revoked_at: null };
  if (!isInviteOpen(base, now)) throw new Error("A fresh invite must be open.");
  if (isInviteOpen({ ...base, uses: 1 }, now)) throw new Error("A used invite must be closed.");
  if (isInviteOpen({ ...base, revoked_at: "2026-09-27T00:00:00Z" }, now)) throw new Error("A revoked invite must be closed.");
  if (isInviteOpen({ ...base, expires_at: "2026-09-27T00:00:00Z" }, now)) throw new Error("An expired invite must be closed.");
});
