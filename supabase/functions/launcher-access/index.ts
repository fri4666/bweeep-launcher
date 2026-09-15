import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

type RequestBody =
  | { action: "status" }
  | { action: "redeem"; code: string }
  | { action: "createInvite"; expiresInDays?: number; maxUses?: number }
  | { action: "manifest"; packId: string };

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  fetch: withSupabase({ auth: "user" }, async (request, ctx) => {
    if (request.method !== "POST") {
      return json({ message: "POST 요청만 지원합니다." }, 405);
    }

    const userId = ctx.userClaims?.sub;
    if (!userId) {
      return json({ message: "사용자 식별 정보를 찾지 못했습니다." }, 401);
    }

    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return json({ message: "JSON 요청 본문이 필요합니다." }, 400);
    }

    const { data: membership, error: membershipError } = await ctx.supabaseAdmin
      .from("launcher_members")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipError) {
      return json({ message: "권한 정보를 조회하지 못했습니다." }, 500);
    }

    if (body.action === "status") {
      return json({
        allowed: Boolean(membership),
        isAdmin: membership?.role === "admin",
        reason: membership ? "런처 사용 권한이 있습니다." : "초대 코드가 필요합니다."
      });
    }

    if (body.action === "redeem") {
      const code = normalizeCode(body.code);
      if (!code) {
        return json({ message: "초대 코드 형식이 올바르지 않습니다." }, 400);
      }

      const { data, error } = await ctx.supabaseAdmin.rpc("redeem_launcher_invite", {
        p_code_hash: await sha256(code),
        p_user_id: userId
      });
      if (error) {
        return json({ message: "초대 코드 사용 중 오류가 발생했습니다." }, 500);
      }

      const outcome = data?.[0];
      return json(
        {
          ok: Boolean(outcome?.ok),
          message: outcome?.message ?? "초대 코드 결과를 확인하지 못했습니다.",
          allowed: Boolean(outcome?.ok),
          isAdmin: outcome?.member_role === "admin"
        },
        outcome?.ok ? 200 : 400
      );
    }

    if (!membership) {
      return json({ message: "초대 코드가 필요합니다." }, 403);
    }

    if (body.action === "manifest") {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.packId)) {
        return json({ message: "모드팩 ID 형식이 올바르지 않습니다." }, 400);
      }

      const { data, error } = await ctx.supabaseAdmin
        .from("launcher_releases")
        .select("manifest, version")
        .eq("pack_id", body.packId)
        .eq("active", true)
        .maybeSingle();
      if (error) {
        return json({ message: "모드팩 정보를 조회하지 못했습니다." }, 500);
      }
      if (!data) {
        return json({ message: "활성 모드팩 release를 찾지 못했습니다." }, 404);
      }

      return json({ manifest: data.manifest, version: data.version });
    }

    const expiresInDays = clamp(body.expiresInDays, 14, 1, 30);
    const maxUses = clamp(body.maxUses, 1, 1, 20);
    const code = createInviteCode();
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    const { error } = await ctx.supabaseAdmin.from("launcher_invites").insert({
      code_hash: await sha256(code),
      created_by: userId,
      expires_at: expiresAt,
      max_uses: maxUses
    });

    if (error) {
      return json({ message: "초대 코드를 만들지 못했습니다." }, 500);
    }
    return json({ code, expiresAt, maxUses });
  })
};

function normalizeCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^BWEEP-[A-F0-9]{12}-[A-F0-9]{12}$/.test(code) ? code : null;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function createInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `BWEEP-${toHex(bytes.slice(0, 6))}-${toHex(bytes.slice(6))}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
