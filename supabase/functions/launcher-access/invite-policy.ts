export type InviteRole = "admin" | "member";

export interface InvitePolicy {
  /** Largest group code this role may create. */
  maxUsesLimit: number;
  expiresInDays: number;
  /** Open codes a member may hold at once; admins are not capped. */
  activeLimit: number | null;
}

export interface InviteRecord {
  expires_at: string;
  max_uses: number;
  uses: number;
  revoked_at: string | null;
}

// Members invite friends one at a time. Group codes stay with admins so a
// single leaked code cannot let many strangers in.
const policies: Record<InviteRole, InvitePolicy> = {
  admin: { maxUsesLimit: 20, expiresInDays: 14, activeLimit: null },
  member: { maxUsesLimit: 1, expiresInDays: 7, activeLimit: 3 }
};

export function invitePolicy(role: InviteRole): InvitePolicy {
  return policies[role];
}

export function isInviteOpen(invite: InviteRecord, now = Date.now()): boolean {
  return !invite.revoked_at && Date.parse(invite.expires_at) > now && invite.uses < invite.max_uses;
}

export type InviteDecision =
  | { ok: true; maxUses: number; expiresInDays: number }
  | { ok: false; message: string };

export function decideInvite(role: InviteRole, requestedMaxUses: unknown, openInvites: number): InviteDecision {
  const policy = invitePolicy(role);
  if (policy.activeLimit !== null && openInvites >= policy.activeLimit) {
    return { ok: false, message: `사용 전인 초대 코드는 ${policy.activeLimit}개까지 만들 수 있습니다. 기존 코드를 취소하거나 사용된 뒤 다시 만들어 주세요.` };
  }
  const requested = typeof requestedMaxUses === "number" && Number.isInteger(requestedMaxUses) ? requestedMaxUses : 1;
  return {
    ok: true,
    maxUses: Math.min(Math.max(requested, 1), policy.maxUsesLimit),
    expiresInDays: policy.expiresInDays
  };
}
