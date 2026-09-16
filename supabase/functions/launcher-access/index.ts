import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { getBearerToken } from "./authorization.ts";

type RequestBody =
  | { action: "status" }
  | { action: "redeem"; code: string }
  | { action: "createInvite"; expiresInDays?: number; maxUses?: number }
  | { action: "manifest"; packId: string };

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
  version: string;
  minecraftVersion: string;
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

  const accessToken = getBearerToken(request);
  if (!accessToken) return json({ code: "MISSING_BEARER_TOKEN", message: "로그인 토큰이 필요합니다." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Supabase function environment is missing required credentials.");
      return json({ message: "서버 인증 설정을 확인하지 못했습니다." }, 500);
    }

    // Do not use the request's apikey for user authentication.  The launcher sends
    // both headers (as Supabase requires), and @supabase/server can select the
    // publishable key before the user bearer token on current key formats.
    const authClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { data: authData, error: authError } = await authClient.auth.getClaims(accessToken);
    const userId = typeof authData?.claims?.sub === "string" ? authData.claims.sub : null;
    if (authError || !userId) {
      return json({ code: "INVALID_BEARER_TOKEN", message: "로그인 세션을 확인할 수 없습니다." }, 401);
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

    const { data: membership, error: membershipError } = await supabaseAdmin
      .from("launcher_members")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle();

    if (membershipError) {
      console.error("launcher membership query failed", membershipError);
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

    if (body.action === "manifest") {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.packId)) {
        return json({ message: "모드팩 ID 형식이 올바르지 않습니다." }, 400);
      }

      const { data, error } = await supabaseAdmin
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

      const manifest = await resolveManifestDownloads(supabaseAdmin, data.manifest);
      return json({ manifest, version: data.version });
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
  if (body.action === "manifest") return typeof body.packId === "string";
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
  return Array.isArray(manifest.files) && manifest.files.every((file) =>
    file && typeof file.path === "string" && typeof file.url === "string" &&
    typeof file.size === "number" && typeof file.sha256 === "string"
  );
}
