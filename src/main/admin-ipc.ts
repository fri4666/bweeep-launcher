import { ipcMain, shell } from "electron";
import type { AdminDiagnostics, AdminNames, AdminRelease, AuthFailure } from "../shared/admin-types.js";
import type { LauncherUser, MemberSummary } from "../shared/types.js";
import { isDiagnosticsUrl, readLogTail } from "./diagnostics.js";
import { GameSessionWatch } from "./game-session-watch.js";
import { gameLogPath, writeGameLog } from "./logs.js";
import type { SupabaseAuth } from "./supabase-auth.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAME_NAME = /^[A-Za-z0-9_]{2,16}$/;

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${what} 정보가 올바르지 않습니다.`);
  return value;
}

interface AdminIpcContext {
  auth: SupabaseAuth;
  user: () => LauncherUser | null;
  /** The game log or crash report of the last run, if any. */
  lastGameLogFile: () => string | null;
  broadcast: (channel: string, payload: unknown) => void;
}

/**
 * The admin tab, diagnostics uploads and the per-run game token upkeep. The
 * server lets only admins use the admin actions; the checks here only keep
 * malformed values from reaching it.
 */
export function registerAdminIpc(context: AdminIpcContext): GameSessionWatch {
  const { auth, user } = context;
  const members = async (body: Record<string, unknown>, fallback: string) =>
    (await auth.call<{ members: MemberSummary[] }>(user(), body, fallback)).members ?? [];

  ipcMain.handle("admin:setRole", (_event, userId: unknown, role: unknown) => {
    if (role !== "admin" && role !== "member") throw new Error("역할 정보가 올바르지 않습니다.");
    return members({ action: "setMemberRole", userId: requireUuid(userId, "멤버"), role }, "역할을 바꾸지 못했습니다.");
  });
  ipcMain.handle("admin:removeMember", (_event, userId: unknown) =>
    members({ action: "removeMember", userId: requireUuid(userId, "멤버") }, "멤버를 내보내지 못했습니다."));
  ipcMain.handle("admin:names", () => auth.call<AdminNames>(user(), { action: "adminNames" }, "이름 목록을 불러오지 못했습니다."));
  ipcMain.handle("admin:releaseName", (_event, userId: unknown, gameName: unknown) => {
    if (typeof gameName !== "string" || !GAME_NAME.test(gameName)) throw new Error("이름 정보가 올바르지 않습니다.");
    return auth.call<AdminNames>(user(), { action: "releaseName", userId: requireUuid(userId, "멤버"), gameName }, "이름 보호를 풀지 못했습니다.");
  });
  ipcMain.handle("admin:deleteReservation", (_event, minecraftUuid: unknown) =>
    auth.call<AdminNames>(user(), { action: "deleteReservation", minecraftUuid: requireUuid(minecraftUuid, "예약") }, "예약을 해제하지 못했습니다."));
  ipcMain.handle("admin:releases", async () =>
    (await auth.call<{ releases: AdminRelease[] }>(user(), { action: "adminReleases" }, "서버 팩 목록을 불러오지 못했습니다.")).releases ?? []);
  ipcMain.handle("admin:activateRelease", async (_event, releaseId: unknown) =>
    (await auth.call<{ releases: AdminRelease[] }>(user(), { action: "activateRelease", releaseId: requireUuid(releaseId, "버전") }, "버전을 바꾸지 못했습니다.")).releases ?? []);
  ipcMain.handle("admin:diagnostics", () => auth.call<AdminDiagnostics>(user(), { action: "adminDiagnostics" }, "진단 목록을 불러오지 못했습니다."));
  ipcMain.handle("admin:openDiagnostics", async (_event, diagnosticId: unknown) => {
    const { url } = await auth.call<{ url: string }>(user(), { action: "openDiagnostics", diagnosticId: requireUuid(diagnosticId, "진단") }, "진단 정보를 열지 못했습니다.");
    if (!isDiagnosticsUrl(url)) throw new Error("진단 정보 주소가 올바르지 않습니다.");
    await shell.openExternal(url);
  });
  ipcMain.handle("diagnostics:send", async () => {
    const [gameLog, launcherLog] = await Promise.all([readLogTail(context.lastGameLogFile()), readLogTail(gameLogPath())]);
    await auth.call<{ ok: boolean }>(user(), { action: "uploadDiagnostics", gameLog, launcherLog }, "진단 정보를 보내지 못했습니다.");
  });

  return new GameSessionWatch({
    extend: (accessToken) => auth.call(user(), { action: "extendGameAuth", accessToken }, "게임 접속 토큰을 연장하지 못했습니다."),
    lastFailure: async (since) =>
      (await auth.call<{ failure: AuthFailure | null }>(user(), { action: "lastAuthFailure", since }, "접속 실패 이유를 확인하지 못했습니다.")).failure ?? null,
    report: (failure) => context.broadcast("game:authFailure", failure),
    log: (event, details) => void writeGameLog(event, details)
  });
}
