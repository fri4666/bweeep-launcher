import { handleInviteRequest, type InviteRequest } from "./invite-management.ts";

const codes = { create: () => "BWEEP-0123456789AB-CDEF01234567", hash: async () => "code-hash" };

function fakeDatabase(data: unknown, message: string | null = null) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data, error: message ? { message } : null });
    }
  };
}
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

Deno.test("invite creation uses the atomic RPC and returns its authoritative expiry and policy", async () => {
  const database = fakeDatabase([{ id: "invite-id", expires_at: "2030-01-01T00:00:00Z", max_uses: 1 }]);
  const response = await handleInviteRequest(database, "member-id", { action: "createInvite", maxUses: 99 }, codes);
  const body = await response.json();
  check(response.status === 200 && body.id === "invite-id" && body.code === codes.create(), "Create response changed.");
  check(body.expiresAt === "2030-01-01T00:00:00Z" && body.maxUses === 1, "Edge must use the database role policy and clock.");
  check(database.calls.length === 1 && database.calls[0].name === "launcher_create_invite", "Creation must be one atomic RPC.");
  check(JSON.stringify(database.calls[0].args) === JSON.stringify({ p_user_id: "member-id", p_code_hash: "code-hash", p_max_uses: 20 }), "Only a normalized requested limit and hashed code belong in the RPC.");
});

Deno.test("active invite listing preserves older codes beyond both history and Data API row limits", async () => {
  const invites = Array.from({ length: 1051 }, (_, id) => ({ id: String(id), expiresAt: "2030-01-01", maxUses: 20, uses: 1, createdAt: "2026-01-01" }));
  const result = { role: "admin", maxUsesLimit: 20, activeLimit: null, invites };
  const database = fakeDatabase(result);
  const response = await handleInviteRequest(database, "admin-id", { action: "listInvites" }, codes);
  check(JSON.stringify(await response.json()) === JSON.stringify(result), "All active group codes must remain visible.");
  check(database.calls[0].name === "launcher_list_invites", "Active filtering belongs in SQL before API pagination.");
});

Deno.test("revoking an owned ID never depends on a bounded history list", async () => {
  for (const exists of [true, false]) {
    const database = fakeDatabase(exists);
    const response = await handleInviteRequest(database, "owner", { action: "revokeInvite", inviteId: "old-id" }, codes);
    check(response.status === (exists ? 200 : 404), "Revoke status changed.");
    check(JSON.stringify(database.calls) === JSON.stringify([{ name: "launcher_revoke_invite", args: { p_user_id: "owner", p_invite_id: "old-id" } }]), "Revoke must address the owned invite directly.");
  }
});

Deno.test("invite RPC cap, removal and database failures retain public status codes", async () => {
  const request: InviteRequest = { action: "createInvite" };
  for (const [message, status] of [["INVITE_LIMIT_REACHED", 409], ["NOT_MEMBER", 403], ["database unavailable", 500]] as const) {
    const response = await handleInviteRequest(fakeDatabase(null, message), "user", request, codes);
    const body = await response.json();
    check(response.status === status && typeof body.message === "string" && !JSON.stringify(body).includes("BWEEP-"), "Failures must not expose a usable invite code.");
  }
  check((await handleInviteRequest(fakeDatabase([]), "user", request, codes)).status === 500, "An empty creation result must fail closed.");
});
