import type { createClient } from "@supabase/supabase-js";
import { isModpackManifest, usesBweeepAccounts } from "./catalog.ts";

type Db = ReturnType<typeof createClient<any, "public">>;

/**
 * Actions of the launcher's admin tab. launcher-access lets only admins in,
 * and the database functions behind the changes check it again.
 */
export type AdminRequest =
  | { action: "listMembers" }
  | { action: "setTester"; userId: string; tester: boolean }
  | { action: "setMemberRole"; userId: string; role: "admin" | "member" }
  | { action: "removeMember"; userId: string }
  | { action: "adminNames" }
  | { action: "releaseName"; userId: string; gameName: string }
  | { action: "deleteReservation"; minecraftUuid: string }
  | { action: "adminReleases" }
  | { action: "activateRelease"; releaseId: string }
  | { action: "adminDiagnostics" }
  | { action: "openDiagnostics"; diagnosticId: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);

export function parseAdminRequest(body: Record<string, unknown>): AdminRequest | null {
  switch (body.action) {
    case "listMembers":
    case "adminNames":
    case "adminReleases":
    case "adminDiagnostics":
      return { action: body.action };
    case "setTester":
      return isUuid(body.userId) && typeof body.tester === "boolean" ? { action: "setTester", userId: body.userId, tester: body.tester } : null;
    case "setMemberRole":
      return isUuid(body.userId) && (body.role === "admin" || body.role === "member") ? { action: "setMemberRole", userId: body.userId, role: body.role } : null;
    case "removeMember":
      return isUuid(body.userId) ? { action: "removeMember", userId: body.userId } : null;
    case "releaseName":
      return isUuid(body.userId) && typeof body.gameName === "string" && /^[A-Za-z0-9_]{2,16}$/.test(body.gameName)
        ? { action: "releaseName", userId: body.userId, gameName: body.gameName }
        : null;
    case "deleteReservation":
      return isUuid(body.minecraftUuid) ? { action: "deleteReservation", minecraftUuid: body.minecraftUuid } : null;
    case "activateRelease":
      return isUuid(body.releaseId) ? { action: "activateRelease", releaseId: body.releaseId } : null;
    case "openDiagnostics":
      return isUuid(body.diagnosticId) ? { action: "openDiagnostics", diagnosticId: body.diagnosticId } : null;
    default:
      return null;
  }
}

export const ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  "listMembers", "setTester", "setMemberRole", "removeMember", "adminNames", "releaseName", "deleteReservation",
  "adminReleases", "activateRelease", "adminDiagnostics", "openDiagnostics"
]);

/** For a body that already passed parseAdminRequest. */
export function isAdminRequest(body: { action: string }): body is AdminRequest {
  return ADMIN_ACTIONS.has(body.action);
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Codes the admin database functions raise, as the launcher shows them. */
const refusals: Record<string, [number, string]> = {
  NOT_ADMIN: [403, "관리자만 할 수 있어요."],
  MEMBER_NOT_FOUND: [404, "멤버를 찾지 못했어요."],
  CANNOT_CHANGE_SELF: [409, "자기 자신은 바꿀 수 없어요."],
  LAST_ADMIN: [409, "마지막 관리자는 바꿀 수 없어요."],
  NAME_NOT_HELD: [404, "보호 중인 이름이 아니에요."],
  RESERVATION_NOT_FOUND: [404, "예약을 찾지 못했어요."],
  RELEASE_NOT_FOUND: [404, "버전을 찾지 못했어요."],
  OFFLINE_RELEASE: [409, "붸에엡 계정 접속이 아닌 버전은 켤 수 없어요."],
  PACK_MISMATCH: [409, "다른 서버 팩의 정보라 켤 수 없어요."]
};

export function refusal(error: { message?: string } | null, fallback: string): Response {
  const known = error?.message ? refusals[error.message] : undefined;
  if (known) return json({ code: error!.message, message: known[1] }, known[0]);
  console.error("admin action failed", error);
  return json({ message: fallback }, 500);
}

class ReadError extends Error {}

function rows<T>(result: { data: T[] | null; error: unknown }, what: string): T[] {
  if (result.error) {
    console.error(`admin read failed: ${what}`, result.error);
    throw new ReadError(what);
  }
  return result.data ?? [];
}

/** Discord display names, looked up once per request. */
class Names {
  private cache = new Map<string, Promise<string>>();
  constructor(private db: Db) {}
  get(userId: string): Promise<string> {
    let name = this.cache.get(userId);
    if (!name) {
      name = this.db.auth.admin.getUserById(userId).then(({ data }) => {
        const metadata = data.user?.user_metadata ?? {};
        const found = [metadata.full_name, metadata.name, metadata.user_name].find((value) => typeof value === "string" && value.trim());
        return typeof found === "string" ? found : "이름 없음";
      }, () => "이름 없음");
      this.cache.set(userId, name);
    }
    return name;
  }
}

export interface AdminMember {
  userId: string;
  name: string;
  gameName: string | null;
  role: "admin" | "member";
  tester: boolean;
  lastPlayedAt: string | null;
}

export async function listMembers(db: Db, names = new Names(db)): Promise<AdminMember[]> {
  const [members, testers, profiles, accounts, history] = await Promise.all([
    db.from("launcher_members").select("user_id, role, invited_at").order("invited_at"),
    db.from("launcher_environment_access").select("user_id").eq("environment", "test"),
    db.from("launcher_profiles").select("user_id, game_name"),
    db.from("launcher_minecraft_accounts").select("user_id, game_name"),
    db.from("launcher_game_name_history").select("user_id, used_at").not("used_at", "is", null)
  ]);
  const testerIds = new Set(rows(testers, "testers").map((row) => row.user_id));
  const saved = new Map(rows(profiles, "profiles").map((row) => [row.user_id, row.game_name as string]));
  const played = new Map(rows(accounts, "accounts").map((row) => [row.user_id, row.game_name as string]));
  const lastPlayed = new Map<string, string>();
  for (const row of rows(history, "history")) {
    const previous = lastPlayed.get(row.user_id);
    if (!previous || Date.parse(row.used_at) > Date.parse(previous)) lastPlayed.set(row.user_id, row.used_at);
  }
  return Promise.all(rows(members, "members").map(async (member) => ({
    userId: member.user_id,
    name: await names.get(member.user_id),
    gameName: saved.get(member.user_id) ?? played.get(member.user_id) ?? null,
    role: member.role === "admin" ? "admin" as const : "member" as const,
    tester: member.role === "admin" || testerIds.has(member.user_id),
    lastPlayedAt: lastPlayed.get(member.user_id) ?? null
  })));
}

async function nameState(db: Db, actorId: string, names: Names) {
  const [holds, reservations] = await Promise.all([
    db.rpc("launcher_admin_name_holds", { p_actor: actorId }),
    db.rpc("launcher_admin_reservations", { p_actor: actorId })
  ]);
  return {
    holds: await Promise.all(rows<{ user_id: string; game_name: string; kind: string; held_until: string }>(holds, "name holds").map(async (hold) => ({
      userId: hold.user_id,
      owner: await names.get(hold.user_id),
      gameName: hold.game_name,
      kind: hold.kind === "removed" ? "removed" : "released",
      heldUntil: hold.held_until
    }))),
    reservations: await Promise.all(rows<{ minecraft_uuid: string; game_name: string; user_id: string | null; source: string; created_at: string }>(reservations, "reservations").map(async (reservation) => ({
      minecraftUuid: reservation.minecraft_uuid,
      gameName: reservation.game_name,
      userId: reservation.user_id,
      owner: reservation.user_id ? await names.get(reservation.user_id) : null,
      source: reservation.source,
      createdAt: reservation.created_at
    })))
  };
}

async function releaseState(db: Db) {
  const releases = rows(await db
    .from("launcher_releases")
    .select("id, pack_id, version, active, created_at, gameAuth:manifest->>gameAuth, name:manifest->>name, audience:manifest->>audience")
    .order("pack_id")
    .order("created_at", { ascending: false })
    .limit(300), "releases");
  return {
    releases: releases.map((release) => ({
      id: release.id,
      packId: release.pack_id,
      name: typeof release.name === "string" ? release.name : release.pack_id,
      version: release.version,
      active: release.active === true,
      gameAuth: release.gameAuth === "yggdrasil" ? "yggdrasil" : "offline",
      audience: release.audience === "testers" ? "testers" : "members",
      createdAt: release.created_at
    }))
  };
}

async function diagnosticState(db: Db, names: Names) {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const [failures, uploads] = await Promise.all([
    db.from("launcher_auth_failures").select("id, user_id, game_name, audience, reason, created_at")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(300),
    db.from("launcher_diagnostics").select("id, user_id, size_bytes, created_at")
      .order("created_at", { ascending: false }).limit(100)
  ]);
  return {
    failures: await Promise.all(rows(failures, "auth failures").map(async (failure) => ({
      id: String(failure.id),
      userId: failure.user_id,
      owner: failure.user_id ? await names.get(failure.user_id) : null,
      gameName: failure.game_name,
      audience: failure.audience === "testers" ? "testers" : "members",
      reason: failure.reason,
      at: failure.created_at
    }))),
    uploads: await Promise.all(rows(uploads, "diagnostics").map(async (upload) => ({
      id: upload.id,
      userId: upload.user_id,
      owner: await names.get(upload.user_id),
      sizeBytes: upload.size_bytes,
      at: upload.created_at
    })))
  };
}

/** Inside the local stack the storage address is a container name; players reach publicUrl. */
function reachable(url: string, publicUrl: string | undefined): string {
  if (!publicUrl) return url;
  const address = new URL(url);
  const base = new URL(publicUrl);
  address.protocol = base.protocol;
  address.host = base.host;
  return address.toString();
}

export async function handleAdminRequest(db: Db, actorId: string, body: AdminRequest, publicUrl?: string): Promise<Response> {
  const names = new Names(db);
  try {
    switch (body.action) {
      case "listMembers":
        return json({ members: await listMembers(db, names) });
      case "setTester": {
        const { error } = await db.rpc("launcher_admin_set_tester", { p_actor: actorId, p_user_id: body.userId, p_tester: body.tester });
        if (error) return refusal(error, "테스터 지정을 저장하지 못했습니다.");
        return json({ members: await listMembers(db, names) });
      }
      case "setMemberRole": {
        const { error } = await db.rpc("launcher_admin_set_role", { p_actor: actorId, p_user_id: body.userId, p_role: body.role });
        if (error) return refusal(error, "역할을 바꾸지 못했습니다.");
        return json({ members: await listMembers(db, names) });
      }
      case "removeMember": {
        const { error } = await db.rpc("launcher_admin_remove_member", { p_actor: actorId, p_user_id: body.userId });
        if (error) return refusal(error, "멤버를 내보내지 못했습니다.");
        return json({ members: await listMembers(db, names) });
      }
      case "adminNames":
        return json(await nameState(db, actorId, names));
      case "releaseName": {
        const { error } = await db.rpc("launcher_admin_release_name", { p_actor: actorId, p_user_id: body.userId, p_game_name: body.gameName });
        if (error) return refusal(error, "이름 보호를 풀지 못했습니다.");
        return json(await nameState(db, actorId, names));
      }
      case "deleteReservation": {
        const { error } = await db.rpc("launcher_admin_delete_reservation", { p_actor: actorId, p_minecraft_uuid: body.minecraftUuid });
        if (error) return refusal(error, "예약을 해제하지 못했습니다.");
        return json(await nameState(db, actorId, names));
      }
      case "adminReleases":
        return json(await releaseState(db));
      case "activateRelease": {
        const { data: release, error: readError } = await db.from("launcher_releases").select("manifest").eq("id", body.releaseId).maybeSingle();
        if (readError) return refusal(readError, "버전 정보를 읽지 못했습니다.");
        if (!release) return refusal({ message: "RELEASE_NOT_FOUND" }, "");
        // The catalog would skip a broken manifest, which hides the server.
        if (!isModpackManifest(release.manifest)) return json({ code: "INVALID_MANIFEST", message: "모드팩 정보 형식이 올바르지 않아 켤 수 없어요." }, 409);
        if (!usesBweeepAccounts(release.manifest)) return refusal({ message: "OFFLINE_RELEASE" }, "");
        const { error } = await db.rpc("launcher_admin_activate_release", { p_actor: actorId, p_release_id: body.releaseId });
        if (error) return refusal(error, "버전을 바꾸지 못했습니다.");
        return json(await releaseState(db));
      }
      case "adminDiagnostics":
        return json(await diagnosticState(db, names));
      case "openDiagnostics": {
        const { data: upload, error } = await db.from("launcher_diagnostics").select("id, user_id").eq("id", body.diagnosticId).maybeSingle();
        if (error) return refusal(error, "진단 정보를 찾지 못했습니다.");
        if (!upload) return json({ message: "진단 정보를 찾지 못했어요." }, 404);
        const { data: signed, error: signError } = await db.storage.from("launcher-diagnostics").createSignedUrl(`${upload.id}.txt`, 300);
        if (signError || !signed?.signedUrl) return refusal(signError, "진단 정보를 열지 못했습니다.");
        await db.rpc("launcher_log_admin_action", {
          p_actor: actorId, p_action: "open_diagnostics", p_target: upload.id, p_detail: { userId: upload.user_id }
        });
        return json({ url: reachable(signed.signedUrl, publicUrl) });
      }
    }
  } catch (error) {
    if (error instanceof ReadError) return json({ message: "관리 정보를 불러오지 못했습니다." }, 500);
    throw error;
  }
}
