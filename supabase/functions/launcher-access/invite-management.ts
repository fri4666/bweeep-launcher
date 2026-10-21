import { decideInvite } from "./invite-policy.ts";

export type InviteRequest =
  | { action: "createInvite"; maxUses?: number }
  | { action: "listInvites" }
  | { action: "revokeInvite"; inviteId: string };

interface InviteDatabase {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

export async function handleInviteRequest(
  database: InviteDatabase,
  userId: string,
  request: InviteRequest,
  codes: { create(): string; hash(value: string): Promise<string> }
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const failure = (error: { message: string } | null, message: string) => {
    if (error?.message === "NOT_MEMBER") return json({ message: "초대 코드가 필요합니다." }, 403);
    if (error?.message === "INVITE_LIMIT_REACHED") {
      const decision = decideInvite("member", 1, 3);
      return json({ message: decision.ok ? message : decision.message }, 409);
    }
    return json({ message }, 500);
  };
  if (request.action === "listInvites") {
    const { data, error } = await database.rpc("launcher_list_invites", { p_user_id: userId });
    return error || !data ? failure(error, "초대 코드 목록을 조회하지 못했습니다.") : json(data);
  }
  if (request.action === "revokeInvite") {
    const { data, error } = await database.rpc("launcher_revoke_invite", { p_user_id: userId, p_invite_id: request.inviteId });
    if (error) return failure(error, "초대 코드를 취소하지 못했습니다.");
    return data === true ? json({ ok: true }) : json({ message: "취소할 수 있는 초대 코드를 찾지 못했습니다." }, 404);
  }
  // Normalize the public input without trusting the Edge membership snapshot
  // for policy: the database reads the current role under its creation lock.
  const decision = decideInvite("admin", request.maxUses, 0);
  if (!decision.ok) return failure(null, "초대 코드를 만들지 못했습니다.");
  const code = codes.create();
  const { data, error } = await database.rpc("launcher_create_invite", {
    p_user_id: userId, p_code_hash: await codes.hash(code), p_max_uses: decision.maxUses
  });
  const inserted = Array.isArray(data) ? data[0] as { id: string; expires_at: string; max_uses: number } | undefined : undefined;
  if (error || !inserted) return failure(error, "초대 코드를 만들지 못했습니다.");
  return json({ id: inserted.id, code, expiresAt: inserted.expires_at, maxUses: inserted.max_uses });
}
