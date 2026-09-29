import { ADMIN_ACTIONS, parseAdminRequest, refusal } from "./admin.ts";
import { composeDiagnostics, isDiagnosticsLog } from "./diagnostics.ts";
import { MAX_LOG_BYTES, redactSecrets, tailBytes } from "./redact.ts";

const userId = "0f8fad5b-d9cb-469f-a165-70867728950e";

Deno.test("admin requests are checked field by field", () => {
  const ok = (body: Record<string, unknown>) => parseAdminRequest(body) !== null;
  if (!ok({ action: "listMembers" }) || !ok({ action: "adminNames" }) || !ok({ action: "adminReleases" }) || !ok({ action: "adminDiagnostics" })) {
    throw new Error("List actions need no fields.");
  }
  if (!ok({ action: "setMemberRole", userId, role: "admin" }) || ok({ action: "setMemberRole", userId, role: "owner" }) || ok({ action: "setMemberRole", userId: "x", role: "member" })) {
    throw new Error("Roles are admin or member, for a member id.");
  }
  if (!ok({ action: "setTester", userId, tester: false }) || ok({ action: "setTester", userId, tester: "yes" })) throw new Error("Tester takes a boolean.");
  if (!ok({ action: "removeMember", userId }) || ok({ action: "removeMember", userId: `${userId}'--` })) throw new Error("Removal takes a member id.");
  if (!ok({ action: "releaseName", userId, gameName: "Seo_Py" }) || ok({ action: "releaseName", userId, gameName: "나원" })) throw new Error("Names follow the game name rule.");
  if (!ok({ action: "deleteReservation", minecraftUuid: userId }) || ok({ action: "deleteReservation", minecraftUuid: "0f8fad5bd9cb469fa16570867728950e" })) {
    throw new Error("Reservations are addressed by a dashed UUID.");
  }
  if (!ok({ action: "activateRelease", releaseId: userId }) || !ok({ action: "openDiagnostics", diagnosticId: userId }) || ok({ action: "openDiagnostics" })) {
    throw new Error("Release and diagnostics ids are UUIDs.");
  }
  for (const action of ADMIN_ACTIONS) {
    if (parseAdminRequest({ action }) === null && !["setTester", "setMemberRole", "removeMember", "releaseName", "deleteReservation", "activateRelease", "openDiagnostics"].includes(action)) {
      throw new Error(`${action} is listed but not parsed.`);
    }
  }
  if (ADMIN_ACTIONS.has("gameAuth") || ADMIN_ACTIONS.has("uploadDiagnostics") || ADMIN_ACTIONS.has("extendGameAuth")) {
    throw new Error("Member actions must not be treated as admin actions.");
  }
});

Deno.test("database refusals become short messages with the right status", async () => {
  const lastAdmin = refusal({ message: "LAST_ADMIN" }, "x");
  if (lastAdmin.status !== 409 || (await lastAdmin.json()).message !== "마지막 관리자는 바꿀 수 없어요.") throw new Error("LAST_ADMIN is a 409.");
  if (refusal({ message: "NOT_ADMIN" }, "x").status !== 403) throw new Error("NOT_ADMIN is a 403.");
  if (refusal({ message: "CANNOT_CHANGE_SELF" }, "x").status !== 409) throw new Error("CANNOT_CHANGE_SELF is a 409.");
  const unknown = refusal({ message: "relation does not exist" }, "역할을 바꾸지 못했습니다.");
  if (unknown.status !== 500 || (await unknown.json()).message !== "역할을 바꾸지 못했습니다.") throw new Error("Unknown errors keep the fallback and hide details.");
});

Deno.test("credentials in logs are masked", () => {
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
  const gameToken = "q3Zr8Xk2bT0vLmN9pQwE4sYhG7uJ1aFcD6eKiOoP5lA";
  const input = [
    `Authorization: Bearer ${jwt}`,
    `token ${jwt}`,
    `--username Seo_Py --accessToken ${gameToken} --userType msa`,
    `{"accessToken":"${gameToken}","selectedProfile":"abc"}`,
    `displaySessionToken=abcdefghijklmnop`,
    `bwe-e-ep://auth/callback?code=ab12cd34-ef56&sb_flow_id=1234abcd`,
    `invite BWEEP-0123456789AB-CDEF01234567`,
    `raw ${gameToken} end`,
    `C:\\Users\\서준\\AppData\\Roaming\\Bweeep\\instances`,
    `mail seo@example.com`
  ].join("\n");
  const output = redactSecrets(input);
  for (const secret of [jwt, gameToken, "abcdefghijklmnop", "ab12cd34-ef56", "1234abcd", "BWEEP-0123456789AB", "서준", "seo@example.com"]) {
    if (output.includes(secret)) throw new Error(`${secret} was not masked:\n${output}`);
  }
  for (const kept of ["--username Seo_Py", "--userType msa", "selectedProfile", "AppData\\Roaming\\Bweeep"]) {
    if (!output.includes(kept)) throw new Error(`${kept} should stay readable:\n${output}`);
  }
  const hashes = "sha256 3F2A9C0B1D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8 mods/create-1.21.1-6.0.8.jar";
  if (redactSecrets(hashes) !== hashes) throw new Error("File hashes and names are not credentials.");
});

Deno.test("diagnostics keep only the end of each log", () => {
  const long = `${"old line\n".repeat(20_000)}crash here`;
  const tail = tailBytes(long);
  if (new TextEncoder().encode(tail).length > MAX_LOG_BYTES || !tail.endsWith("crash here") || tail.startsWith("ld line")) {
    throw new Error("The tail must fit and start at a line.");
  }
  if (!isDiagnosticsLog("짧은 로그") || isDiagnosticsLog(long) || isDiagnosticsLog(42)) throw new Error("Only text up to 128KB is accepted.");
  const text = composeDiagnostics({ userId, launcherVersion: "0.1.37", gameLog: "Bearer abcdefghijklmnopqrstuvwxyz", launcherLog: "", sentAt: new Date(0) });
  if (!text.includes("===== 게임 로그 끝부분 =====") || !text.includes("(없음)") || text.includes("abcdefghijklmnopqrstuvwxyz")) {
    throw new Error(`Diagnostics text is not composed as expected:\n${text}`);
  }
});
