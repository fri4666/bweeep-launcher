import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { getBearerToken } from "./authorization.ts";
import {
  createDisplaySessionToken,
  isDisplaySessionToken,
  normalizeDisplayName
} from "./display-name.ts";
import { createGameTicket, isGameName, isGameTicket } from "./game-ticket.ts";

type RequestBody =
  | { action: "status" }
  | { action: "redeem"; code: string }
  | { action: "createInvite"; expiresInDays?: number; maxUses?: number }
  | { action: "catalog" }
  | { action: "manifest"; packId: string }
  | { action: "setGameProfile"; gameName: string }
  | { action: "gameTicket"; gameName: string }
  | { action: "consumeGameTicket"; ticket: string; gameName: string }
  | { action: "setDisplayName"; sessionToken: string; displayName: string };

interface ModpackFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
}

interface ModpackManifest {
  schemaVersion: number;
  id: string;
  name: string;
  audience?: "members" | "testers";
  version: string;
  minecraftVersion: string;
  java: { majorVersion: number; component: string };
  loader: { kind: string; version: string };
  server: { host: string; port: number };
  files: ModpackFile[];
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handleRequest(request);
    } catch (error) {
      console.error("launcher-access unhandled error", error);
      return json({ code: "INTERNAL_ERROR", message: "서버에서 권한 확인 중 오류가 발생했습니다." }, 500);
    }
  }
};

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ message: "POST 요청만 지원합니다." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Supabase function environment is missing required credentials.");
    return json({ message: "서버 인증 설정을 확인하지 못했습니다." }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ message: "JSON 요청 본문이 필요합니다." }, 400);
  }
  if (!isRequestBody(body)) {
    return json({ message: "지원하지 않는 요청입니다." }, 400);
  }

  if (body.action === "consumeGameTicket") {
    const { data, error } = await supabaseAdmin.rpc("consume_launcher_game_ticket", {
      p_ticket_hash: await sha256(body.ticket),
      p_game_name: body.gameName
    });
    const consumed = data?.[0];
    if (error) {
      console.error("game ticket consumption failed", error);
      return json({ message: "게임 서버 인증을 확인하지 못했습니다." }, 500);
    }
    if (!consumed) return json({ ok: false, message: "만료되었거나 이미 사용한 인증표입니다." }, 401);
    const displaySessionToken = createDisplaySessionToken();
    const now = new Date();
    const displaySessionExpiresAt = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    await supabaseAdmin.from("launcher_game_sessions").delete().lt("expires_at", now.toISOString());
    const { error: sessionError } = await supabaseAdmin.from("launcher_game_sessions").insert({
      session_hash: await sha256(displaySessionToken),
      user_id: consumed.user_id,
      expires_at: displaySessionExpiresAt
    });
    if (sessionError) {
      console.error("display session creation failed", sessionError);
      return json({ message: "이름 설정 세션을 만들지 못했습니다." }, 500);
    }
    const { data: savedName, error: savedNameError } = await supabaseAdmin
      .from("launcher_display_names")
      .select("display_name")
      .eq("user_id", consumed.user_id)
      .maybeSingle();
    if (savedNameError) {
      console.error("display name lookup failed", savedNameError);
      return json({ message: "저장된 서버 이름을 확인하지 못했습니다." }, 500);
    }
    return json({
      ok: true,
      userId: consumed.user_id,
      discordId: consumed.discord_id,
      role: consumed.member_role,
      displaySessionToken,
      displaySessionExpiresAt,
      displayName: savedName?.display_name ?? null
    });
  }

  if (body.action === "setDisplayName") {
    const displayName = normalizeDisplayName(body.displayName);
    if (!displayName) {
      return json({ ok: false, message: "이름은 한글·영문·숫자·공백·밑줄로 2~16자여야 합니다." }, 400);
    }
    const { data, error } = await supabaseAdmin.rpc("set_launcher_display_name_once", {
      p_session_hash: await sha256(body.sessionToken),
      p_display_name: displayName
    });
    if (error) {
      console.error("display name save failed", error);
      return json({ ok: false, message: "서버 이름을 저장하지 못했습니다." }, 500);
    }
    const result = data?.[0];
    if (!result) {
      return json({ ok: false, message: "이름 설정 시간이 만료되었습니다. 다시 접속해주세요." }, 401);
    }
    return json({
      ok: Boolean(result.ok),
      displayName: result.saved_name,
      alreadySet: Boolean(result.already_set)
    });
  }

  const accessToken = getBearerToken(request);
  if (!accessToken) return json({ code: "MISSING_BEARER_TOKEN", message: "로그인 토큰이 필요합니다." }, 401);
  // The gateway JWT check is disabled for current asymmetric keys, so the
  // function validates the user token explicitly before any member operation.
  const { data: authData, error: authError } = await supabaseAdmin.auth.getClaims(accessToken);
  const userId = typeof authData?.claims?.sub === "string" ? authData.claims.sub : null;
  if (authError || !userId) {
    return json({ code: "INVALID_BEARER_TOKEN", message: "로그인 세션을 확인할 수 없습니다." }, 401);
  }

    const { data: membership, error: membershipError } = await supabaseAdmin
      .from("launcher_members")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipError) {
      console.error("launcher membership query failed", membershipError);
      return json({ message: "권한 정보를 조회하지 못했습니다." }, 500);
    }

    const { data: testAccess, error: testAccessError } = await supabaseAdmin
      .from("launcher_environment_access")
      .select("environment")
      .eq("user_id", userId)
      .eq("environment", "test")
      .maybeSingle();
    if (testAccessError) {
      console.error("launcher test access query failed", testAccessError);
      return json({ message: "테스트 서버 권한을 조회하지 못했습니다." }, 500);
    }
    const testAllowed = membership?.role === "admin" || Boolean(testAccess);

    if (body.action === "status") {
      const { data: profile, error: profileError } = await supabaseAdmin
        .from("launcher_profiles")
        .select("game_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (profileError) {
        console.error("launcher profile query failed", profileError);
        return json({ message: "게임 프로필을 조회하지 못했습니다." }, 500);
      }
      return json({
        allowed: Boolean(membership),
        isAdmin: membership?.role === "admin",
        testAllowed,
        reason: membership ? "런처 사용 권한이 있습니다." : "초대 코드가 필요합니다.",
        gameName: profile?.game_name ?? null
      });
    }

    if (body.action === "redeem") {
      const code = normalizeCode(body.code);
      if (!code) return json({ message: "초대 코드 형식이 올바르지 않습니다." }, 400);
      const { data, error } = await supabaseAdmin.rpc("redeem_launcher_invite", {
        p_code_hash: await sha256(code),
        p_user_id: userId
      });
      if (error) return json({ message: "초대 코드를 사용하는 중 오류가 발생했습니다." }, 500);
      const outcome = data?.[0];
      return json({
        ok: Boolean(outcome?.ok),
        message: outcome?.message ?? "초대 결과를 확인하지 못했습니다.",
        allowed: Boolean(outcome?.ok),
        isAdmin: outcome?.member_role === "admin"
      }, outcome?.ok ? 200 : 400);
    }

    if (!membership) {
      return json({ message: "초대 코드가 필요합니다." }, 403);
    }

    if (body.action === "setGameProfile") {
      if (!isGameName(body.gameName)) {
        return json({ message: "인게임 이름은 영문·숫자·밑줄 3~16자로 입력해 주세요." }, 400);
      }
      const { error } = await supabaseAdmin
        .from("launcher_profiles")
        .upsert({ user_id: userId, game_name: body.gameName }, { onConflict: "user_id" });
      if (error) {
        console.error("launcher profile save failed", error);
        return json({ message: "인게임 이름을 저장하지 못했습니다." }, 500);
      }
      return json({ ok: true, gameName: body.gameName });
    }

    if (body.action === "gameTicket") {
      const { data: userData, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
      const discordIdentity = userData.user?.identities?.find((identity) => identity.provider === "discord");
      const discordId = discordIdentity?.id;
      if (userError || !discordId || !/^\d{15,22}$/.test(discordId)) {
        return json({ message: "Discord 계정 연결을 확인하지 못했습니다." }, 403);
      }

      const ticket = createGameTicket();
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      await supabaseAdmin.from("launcher_game_tickets").delete().lt("expires_at", new Date().toISOString());
      const { error: insertError } = await supabaseAdmin.from("launcher_game_tickets").insert({
        ticket_hash: await sha256(ticket),
        user_id: userId,
        discord_id: discordId,
        role: membership.role === "admin" ? "admin" : "member",
        game_name: body.gameName,
        expires_at: expiresAt
      });
      if (insertError) {
        console.error("game ticket creation failed", insertError);
        return json({ message: "게임 서버 인증표를 만들지 못했습니다." }, 500);
      }
      return json({ ticket, expiresAt });
    }

    if (body.action === "manifest") {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.packId)) {
        return json({ message: "모드팩 ID 형식이 올바르지 않습니다." }, 400);
      }

      const { data, error } = await supabaseAdmin
        .from("launcher_releases")
        .select("manifest, version")
        .eq("pack_id", body.packId)
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) {
        return json({ message: "모드팩 정보를 조회하지 못했습니다." }, 500);
      }
      if (!data) {
        return json({ message: "활성 모드팩 release를 찾지 못했습니다." }, 404);
      }

      const manifest = await resolveManifestDownloads(supabaseAdmin, data.manifest);
      if (manifest.audience === "testers" && !testAllowed) {
        return json({ message: "테스트 서버는 지정된 테스터만 접속할 수 있습니다." }, 403);
      }
      return json({ manifest, version: data.version });
    }

    if (body.action === "catalog") {
      const { data, error } = await supabaseAdmin
        .from("launcher_releases")
        .select("pack_id, manifest, version, created_at")
        .eq("active", true)
        .order("created_at", { ascending: false });
      if (error) return json({ message: "서버 모드팩 목록을 조회하지 못했습니다." }, 500);

      // Releases are append-only. Keep the most recent active manifest for
      // each pack, so a pack update needs no launcher release.
      const newestByPack = new Map<string, { manifest: unknown; version: string }>();
      for (const row of data ?? []) {
        if (!newestByPack.has(row.pack_id)) {
          newestByPack.set(row.pack_id, { manifest: row.manifest, version: row.version });
        }
      }
      const manifests = await Promise.all(Array.from(newestByPack.values(), async (release) => ({
        manifest: await resolveManifestDownloads(supabaseAdmin, release.manifest),
        version: release.version
      })));
      return json({
        manifests: manifests.filter(({ manifest }) => manifest.audience !== "testers" || testAllowed)
      });
    }

    const expiresInDays = clamp(body.expiresInDays, 14, 1, 30);
    const maxUses = clamp(body.maxUses, 1, 1, 20);
    const code = createInviteCode();
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    const { error } = await supabaseAdmin.from("launcher_invites").insert({
      code_hash: await sha256(code),
      created_by: userId,
      expires_at: expiresAt,
      max_uses: maxUses
    });
    if (error) return json({ message: "초대 코드를 만들지 못했습니다." }, 500);
    return json({ code, expiresAt, maxUses });
}

function normalizeCode(value: unknown): string | null {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^BWEEP-[A-F0-9]{12}-[A-F0-9]{12}$/.test(code) ? code : null;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function isRequestBody(value: unknown): value is RequestBody {
  if (!value || typeof value !== "object" || !("action" in value)) return false;
  const body = value as Record<string, unknown>;
  if (body.action === "status") return true;
  if (body.action === "redeem") return typeof body.code === "string";
  if (body.action === "catalog") return true;
  if (body.action === "manifest") return typeof body.packId === "string";
  if (body.action === "setGameProfile") return isGameName(body.gameName);
  if (body.action === "gameTicket") return isGameName(body.gameName);
  if (body.action === "consumeGameTicket") return isGameTicket(body.ticket) && isGameName(body.gameName);
  if (body.action === "setDisplayName") {
    return isDisplaySessionToken(body.sessionToken) && typeof body.displayName === "string";
  }
  return body.action === "createInvite";
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

async function resolveManifestDownloads(
  supabase: ReturnType<typeof createClient>,
  rawManifest: unknown
): Promise<ModpackManifest> {
  if (!isModpackManifest(rawManifest)) {
    throw new Error("Stored launcher manifest has an invalid shape.");
  }

  const files = await Promise.all(rawManifest.files.map(async (file) => {
    const storageObject = parseStorageObjectUrl(file.url);
    if (!storageObject) return file;

    const { data, error } = await supabase.storage
      .from(storageObject.bucket)
      .createSignedUrl(storageObject.path, 15 * 60);
    if (error || !data?.signedUrl) {
      throw new Error(`Unable to sign modpack file ${file.path}.`);
    }
    return { ...file, url: data.signedUrl };
  }));

  return { ...rawManifest, files };
}

function parseStorageObjectUrl(value: string): { bucket: string; path: string } | null {
  if (!value.startsWith("storage://")) return null;
  const url = new URL(value);
  const bucket = url.hostname;
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(bucket) || !path || path.includes("..")) {
    throw new Error("Stored launcher manifest contains an invalid storage object URL.");
  }
  return { bucket, path };
}

function isModpackManifest(value: unknown): value is ModpackManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ModpackManifest>;
  return typeof manifest.id === "string" && typeof manifest.minecraftVersion === "string" &&
    typeof manifest.loader?.kind === "string" && typeof manifest.loader.version === "string" &&
    Number.isSafeInteger(manifest.java?.majorVersion) && manifest.java.majorVersion >= 21 &&
    typeof manifest.java.component === "string" && Array.isArray(manifest.files) && manifest.files.every((file) =>
    file && typeof file.path === "string" && typeof file.url === "string" &&
    typeof file.size === "number" && typeof file.sha256 === "string"
  );
}
