#!/usr/bin/env node
// Checks the admin tab's server side, game token extension, refusal reasons
// and diagnostics uploads against the throwaway local Supabase stack. No
// Minecraft is started: joins are sent to the Yggdrasil API directly.
//
//   bash scripts/local-supabase.sh start
//   node scripts/verify-admin-access.mjs
//   bash scripts/local-supabase.sh stop
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO, "package.json"));
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_DIR = process.env.BWEEP_LOCAL_SUPABASE ?? "/tmp/bweeep-local-supabase";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail && !ok ? ` - ${detail}` : ""}`);
};
const opts = { auth: { autoRefreshToken: false, persistSession: false } };
const PACK = "admin-check-pack";

const status = JSON.parse(execFileSync("npx", ["-y", "supabase@2", "status", "-o", "json"], {
  cwd: SUPABASE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
}));
if (!/^http:\/\/127\.0\.0\.1:/.test(status.API_URL)) throw new Error(`refusing non-local Supabase ${status.API_URL}`);
const local = { url: status.API_URL, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY };
const db = createClient(local.url, local.serviceKey, opts);
const users = [];

try {
  await main();
} catch (error) {
  check("run finished without errors", false, error?.stack ?? String(error));
} finally {
  await db.from("launcher_releases").delete().eq("pack_id", PACK);
  for (const userId of users) await db.auth.admin.deleteUser(userId).catch(() => {});
}
const failed = results.filter((result) => !result.ok);
console.log(`\nadmin access: ${results.length - failed.length}/${results.length} passed${failed.length ? "" : " - ALL PASS"}`);
process.exit(failed.length ? 1 : 0);

async function main() {
  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  for (const leftover of existing?.users ?? []) {
    if (/^admin-check-[a-f0-9]{8}@bweeep\.test$/.test(leftover.email ?? "")) await db.auth.admin.deleteUser(leftover.id);
  }
  await db.from("launcher_releases").delete().eq("pack_id", PACK);

  const boss = await createUser("AdminBoss", "admin");
  const member = await createUser("MemberMia", "member");
  const other = await createUser("MemberNoa", "member");
  const outsider = await createUser("OutsiderOz", null);

  // --- every admin action is refused to members and outsiders
  const adminCalls = [
    { action: "listMembers" },
    { action: "setTester", userId: other.userId, tester: true },
    { action: "setMemberRole", userId: member.userId, role: "admin" },
    { action: "removeMember", userId: other.userId },
    { action: "adminNames" },
    { action: "releaseName", userId: other.userId, gameName: "MemberNoa" },
    { action: "deleteReservation", minecraftUuid: other.userId },
    { action: "adminReleases" },
    { action: "activateRelease", releaseId: other.userId },
    { action: "adminDiagnostics" },
    { action: "openDiagnostics", diagnosticId: other.userId }
  ];
  for (const body of adminCalls) {
    const asMember = await call(member, body);
    const asOutsider = await call(outsider, body);
    check(`${body.action}: refused to a member and an outsider`, asMember.status === 403 && asOutsider.status === 403, `${asMember.status}/${asOutsider.status}`);
  }
  check("a member's refused role change did nothing", (await db.from("launcher_members").select("role").eq("user_id", member.userId).single()).data?.role === "member");

  // --- members (the 0.1.36 listMembers/setTester shape still works)
  let members = await call(boss, { action: "listMembers" });
  const row = (list, user) => list.body?.members?.find((entry) => entry.userId === user.userId);
  check("admin lists members with name, game name, role and tester", members.status === 200 && row(members, member)?.name === "MemberMia"
    && row(members, boss)?.role === "admin" && row(members, boss)?.tester === true && "lastPlayedAt" in (row(members, member) ?? {}), JSON.stringify(members.body));
  members = await call(boss, { action: "setTester", userId: member.userId, tester: true });
  check("admin makes a tester (0.1.36 request shape)", members.status === 200 && row(members, member)?.tester === true);
  const selfDemote = await call(boss, { action: "setMemberRole", userId: boss.userId, role: "member" });
  check("admin cannot demote themselves", selfDemote.status === 409 && selfDemote.body?.code === "CANNOT_CHANGE_SELF", JSON.stringify(selfDemote.body));
  const selfRemove = await call(boss, { action: "removeMember", userId: boss.userId });
  check("admin cannot remove themselves", selfRemove.status === 409, `${selfRemove.status}`);
  members = await call(boss, { action: "setMemberRole", userId: other.userId, role: "admin" });
  check("admin promotes a member", members.status === 200 && row(members, other)?.role === "admin");
  members = await call(boss, { action: "setMemberRole", userId: other.userId, role: "member" });
  check("admin demotes another admin", members.status === 200 && row(members, other)?.role === "member");

  // --- game token extension
  const auth = await call(member, { action: "gameAuth" });
  check("member gets a game token", auth.status === 200 && /^[A-Za-z0-9_-]{43}$/.test(auth.body?.accessToken ?? ""), JSON.stringify(auth.body));
  const otherAuth = await call(other, { action: "gameAuth" });
  const extended = await call(member, { action: "extendGameAuth", accessToken: auth.body.accessToken });
  const hoursLeft = (Date.parse(extended.body?.expiresAt ?? "") - Date.now()) / 3_600_000;
  check("member extends their own token to about 12 hours", extended.status === 200 && hoursLeft > 11.9 && hoursLeft <= 12.01, `${extended.status} ${hoursLeft}`);
  const foreign = await call(member, { action: "extendGameAuth", accessToken: otherAuth.body.accessToken });
  check("member cannot extend someone else's token", foreign.status === 404, `${foreign.status}`);
  check("bad token shape is refused", (await call(member, { action: "extendGameAuth", accessToken: "short" })).status === 400);
  check("outsider cannot extend", (await call(outsider, { action: "extendGameAuth", accessToken: auth.body.accessToken })).status === 403);

  // --- refusal reasons through the real Yggdrasil API
  const since = new Date().toISOString();
  const apiRoot = `${local.url}/functions/v1/yggdrasil`;
  const join = (token, profile, serverId, root = apiRoot) => fetch(`${root}/sessionserver/session/minecraft/join`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: token, selectedProfile: profile, serverId })
  });
  const noFailure = await call(member, { action: "lastAuthFailure", since });
  check("no refusal yet", noFailure.status === 200 && noFailure.body?.failure === null, JSON.stringify(noFailure.body));
  const ok = await join(auth.body.accessToken, auth.body.profile.id, "srv-ok");
  const hasJoined = await fetch(`${apiRoot}/sessionserver/session/minecraft/hasJoined?username=${auth.body.profile.name}&serverId=srv-ok`);
  check("a good join still passes", ok.status === 204 && hasJoined.status === 200, `${ok.status}/${hasJoined.status}`);
  check("a good join records nothing", (await call(member, { action: "lastAuthFailure", since })).body?.failure === null);

  const otherProfile = otherAuth.body.profile.id;
  const mismatch = await join(auth.body.accessToken, otherProfile, "srv-a");
  check("join with another profile is refused as before", mismatch.status === 403);
  let last = await call(member, { action: "lastAuthFailure", since });
  check("the launcher reads profile_mismatch", last.body?.failure?.reason === "profile_mismatch", JSON.stringify(last.body));

  await join(otherAuth.body.accessToken, otherProfile, "srv-t");
  const testers = await fetch(`${apiRoot}/testers/sessionserver/session/minecraft/hasJoined?username=${otherAuth.body.profile.name}&serverId=srv-t`);
  check("a non-tester is still turned away from a test server", testers.status === 204);
  last = await call(other, { action: "lastAuthFailure", since });
  check("the launcher reads testers_only", last.body?.failure?.reason === "testers_only", JSON.stringify(last.body));

  const oldToken = auth.body.accessToken;
  const renewed = await call(member, { action: "gameAuth" });
  await join(oldToken, auth.body.profile.id, "srv-b");
  last = await call(member, { action: "lastAuthFailure", since });
  check("a replaced token is reported as revoked, not unknown", last.body?.failure?.reason === "token_revoked", JSON.stringify(last.body));
  await call(member, { action: "revokeGameAuth" });
  check("a revoked token cannot be extended", (await call(member, { action: "extendGameAuth", accessToken: renewed.body.accessToken })).status === 404);
  await join(randomBytes(32).toString("base64url"), auth.body.profile.id, "srv-c");
  check("an unknown token is not blamed on the member", (await call(member, { action: "lastAuthFailure", since })).body?.failure?.reason === "token_revoked");
  const future = await call(member, { action: "lastAuthFailure", since: new Date(Date.now() + 3_600_000).toISOString() });
  check("older refusals are not shown for a later run", future.body?.failure === null, JSON.stringify(future.body));

  // --- diagnostics
  const secret = randomBytes(32).toString("base64url").replace(/^/, "Ab1");
  const upload = await call(member, {
    action: "uploadDiagnostics",
    gameLog: `[12:00:00] [main/INFO]: Setting user: MemberMia\n--accessToken ${secret}\nDisconnected: Failed to log in`,
    launcherLog: `{"event":"launch.failed","message":"Bearer ${secret}"}`
  });
  check("member sends diagnostics", upload.status === 200, JSON.stringify(upload.body));
  const again = await call(member, { action: "uploadDiagnostics", gameLog: "x", launcherLog: "y" });
  check("a second upload within 10 minutes is refused", again.status === 429, `${again.status}`);
  check("oversized logs are refused", (await call(other, { action: "uploadDiagnostics", gameLog: "a".repeat(128 * 1024 + 1), launcherLog: "" })).status === 400);
  const diagnostics = await call(boss, { action: "adminDiagnostics" });
  const sent = diagnostics.body?.uploads?.find((item) => item.userId === member.userId);
  check("admin sees the upload and the refusals", Boolean(sent) && diagnostics.body.failures.some((item) => item.reason === "testers_only" && item.owner === "MemberNoa"), JSON.stringify(diagnostics.body));
  const opened = await call(boss, { action: "openDiagnostics", diagnosticId: sent?.id });
  const text = opened.body?.url ? await (await fetch(opened.body.url)).text() : "";
  check("admin opens the file through a signed URL", opened.status === 200 && text.includes("게임 로그 끝부분") && text.includes("Failed to log in"), `${opened.status} ${text.slice(0, 200)}`);
  check("the stored file has no token in it", text.length > 0 && !text.includes(secret));
  const direct = await fetch(`${local.url}/storage/v1/object/launcher-diagnostics/${sent?.id}.txt`, { headers: { apikey: local.anonKey, authorization: `Bearer ${member.accessToken}` } });
  const publicPath = await fetch(`${local.url}/storage/v1/object/public/launcher-diagnostics/${sent?.id}.txt`);
  check("the file cannot be read without the signed URL", !direct.ok && !publicPath.ok, `${direct.status}/${publicPath.status}`);

  // --- names and reservations
  await call(member, { action: "setGameProfile", gameName: "MiaOld" });
  await call(member, { action: "gameAuth" });
  await call(member, { action: "setGameProfile", gameName: "MiaNew" });
  await call(member, { action: "gameAuth" });
  let names = await call(boss, { action: "adminNames" });
  check("admin sees the name the member left", names.body?.holds?.some((hold) => hold.gameName === "MiaOld" && hold.owner === "MemberMia" && hold.kind === "released"), JSON.stringify(names.body));
  check("the name is held for others", (await call(other, { action: "setGameProfile", gameName: "MiaOld" })).status === 409);
  names = await call(boss, { action: "releaseName", userId: member.userId, gameName: "MiaOld" });
  check("admin releases the hold", names.status === 200 && !names.body.holds.some((hold) => hold.gameName === "MiaOld"));
  check("the released name can be taken", (await call(other, { action: "setGameProfile", gameName: "MiaOld" })).status === 200);
  const reservedUuid = crypto.randomUUID();
  await db.from("launcher_minecraft_uuid_reservations").insert({ minecraft_uuid: reservedUuid, game_name: "OldMia", user_id: member.userId, source: "admin-check" });
  names = await call(boss, { action: "adminNames" });
  check("admin sees reservations with their owner", names.body?.reservations?.some((item) => item.minecraftUuid === reservedUuid && item.owner === "MemberMia"));
  names = await call(boss, { action: "deleteReservation", minecraftUuid: reservedUuid });
  check("admin deletes a reservation", names.status === 200 && !names.body.reservations.some((item) => item.minecraftUuid === reservedUuid));

  // --- server pack releases
  const manifest = (version, gameAuth) => ({ schemaVersion: 1, id: PACK, name: "Admin Check", version, minecraftVersion: "26.3",
    java: { majorVersion: 25, component: "java-runtime-epsilon" }, loader: { kind: "vanilla", version: "26.3" },
    server: { host: "127.0.0.1", port: 25999 }, gameAuth, files: [] });
  const inserted = await db.from("launcher_releases").insert([
    { pack_id: PACK, version: "1", manifest: manifest("1", "yggdrasil"), active: true, created_by: boss.userId },
    { pack_id: PACK, version: "2", manifest: manifest("2", "yggdrasil"), active: false, created_by: boss.userId },
    { pack_id: PACK, version: "0", manifest: manifest("0", "offline"), active: false, created_by: boss.userId }
  ]).select("id, version");
  const releaseId = (version) => inserted.data?.find((item) => item.version === version)?.id;
  let releases = await call(boss, { action: "adminReleases" });
  const packRows = (list) => list.body?.releases?.filter((item) => item.packId === PACK) ?? [];
  check("admin lists the pack's releases", packRows(releases).length === 3 && packRows(releases).find((item) => item.version === "0")?.gameAuth === "offline", JSON.stringify(releases.body));
  releases = await call(boss, { action: "activateRelease", releaseId: releaseId("2") });
  check("admin switches to version 2", releases.status === 200 && packRows(releases).filter((item) => item.active).map((item) => item.version).join() === "2", JSON.stringify(releases.body));
  const offline = await call(boss, { action: "activateRelease", releaseId: releaseId("0") });
  check("an offline release cannot be switched on", offline.status === 409, `${offline.status}`);
  releases = await call(boss, { action: "activateRelease", releaseId: releaseId("1") });
  check("admin rolls back to version 1", packRows(releases).filter((item) => item.active).map((item) => item.version).join() === "1");
  const catalog = await call(member, { action: "catalog" });
  check("the catalog serves the rolled-back version", catalog.body?.manifests?.some((item) => item.manifest.id === PACK && item.version === "1"), JSON.stringify(catalog.body)?.slice(0, 300));

  // --- removal and the admin log
  members = await call(boss, { action: "removeMember", userId: other.userId });
  check("admin removes a member", members.status === 200 && !row(members, other));
  const removedStatus = await call(other, { action: "status" });
  check("the removed member loses access", removedStatus.body?.allowed === false, JSON.stringify(removedStatus.body));
  const log = await db.from("launcher_admin_actions").select("action").eq("actor_id", boss.userId);
  const actions = new Set((log.data ?? []).map((item) => item.action));
  check("every change is in the admin log", ["set_tester", "set_role", "release_name", "delete_reservation", "activate_release", "remove_member", "open_diagnostics"].every((action) => actions.has(action)), [...actions].join());
}

async function createUser(name, role) {
  const email = `admin-check-${randomBytes(4).toString("hex")}@bweeep.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: name, user_name: name.toLowerCase() } });
  if (error) throw error;
  users.push(data.user.id);
  if (role) {
    const inserted = await db.from("launcher_members").insert({ user_id: data.user.id, role });
    if (inserted.error) throw inserted.error;
  }
  const client = createClient(local.url, local.anonKey, opts);
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const user = { name, userId: data.user.id, accessToken: signed.data.session.access_token };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await call(user, { action: "status" })).status === 200) break;
    await sleep(2000);
  }
  return user;
}

async function call(user, body) {
  const response = await fetch(`${local.url}/functions/v1/launcher-access`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: local.anonKey, authorization: `Bearer ${user.accessToken}`, "x-bweeep-launcher-version": "0.1.37" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
