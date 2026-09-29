import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { authOutageFromMessage, authOutageMessages, classifyAuthOutage, isAuthOutageResponse } from "../dist/src/shared/auth-outage.js";
import { AuthServiceUnavailableError, OfflineAccess } from "../dist/src/main/offline-access.js";
import { InstalledVersions } from "../dist/src/main/installed-versions.js";

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bweeep-offline-"));

// Which launcher-access failures count as the service being down.
assert.equal(isAuthOutageResponse(0, false), true);
for (const status of [502, 503, 504]) assert.equal(isAuthOutageResponse(status, true), true);
assert.equal(isAuthOutageResponse(546, false), true);
assert.equal(isAuthOutageResponse(500, true), false, "the function's own error message is an ordinary failure");
assert.equal(isAuthOutageResponse(400, false), false);
assert.equal(isAuthOutageResponse(403, true), false);

// Down service or no internet.
assert.equal(classifyAuthOutage({ status: 503, systemOnline: true, gameServerReachable: false }), "auth");
assert.equal(classifyAuthOutage({ status: 0, systemOnline: false, gameServerReachable: true }), "network");
assert.equal(classifyAuthOutage({ status: 0, systemOnline: true, gameServerReachable: true }), "auth");
assert.equal(classifyAuthOutage({ status: 0, systemOnline: true, gameServerReachable: false }), "network");
assert.equal(authOutageFromMessage(authOutageMessages.auth), "auth");
assert.equal(authOutageFromMessage("게임을 시작하지 못했습니다."), null);

const alice = { id: "user-a", username: "alice", globalName: "앨리스", avatarUrl: null };
const bob = { id: "user-b", username: "bob", globalName: null, avatarUrl: null };
const pack = (id) => ({ schemaVersion: 1, id, name: id, version: "1", minecraftVersion: "26.3", java: { majorVersion: 25, component: "x" }, loader: { kind: "fabric", version: "1" }, server: { host: "127.0.0.1", port: 1 }, gameAuth: "yggdrasil", files: [] });
const down = (status = 503) => new AuthServiceUnavailableError(status);

const gameServer = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => gameServer.listen(0, "127.0.0.1", resolve));
const reachable = { host: "127.0.0.1", port: gameServer.address().port };
const unreachable = { host: "127.0.0.1", port: 1 };

function offlineAccess(options = {}) {
  return new OfflineAccess(path.join(root, "offline-snapshot.json"), {
    savedUserId: async () => options.savedUserId ?? alice.id,
    gameServers: () => options.servers ?? [unreachable],
    systemOnline: () => options.online ?? true
  });
}

// Nothing saved yet: an outage is still an error.
await assert.rejects(offlineAccess().listManifests(alice, async () => { throw down(); }), AuthServiceUnavailableError);
assert.equal(await offlineAccess().accessDuringOutage(alice, down()), null);

// A good start saves the server list and access.
const access = offlineAccess();
assert.deepEqual((await access.listManifests(alice, async () => [pack("vanilla"), pack("sunlit")])).map((item) => item.id), ["vanilla", "sunlit"]);
await access.rememberAccess({ loggedIn: true, allowed: true, isAdmin: false, testAllowed: true, reason: "ok", user: { ...alice, gameName: "alice_mc" } });

// Down later: the last list and access come back, marked with the outage.
assert.deepEqual((await access.listManifests(alice, async () => { throw down(); })).map((item) => item.id), ["vanilla", "sunlit"]);
const during = await access.accessDuringOutage(alice, down(503));
assert.deepEqual(during, {
  loggedIn: true,
  allowed: true,
  isAdmin: false,
  testAllowed: true,
  reason: authOutageMessages.auth,
  user: { ...alice, gameName: "alice_mc" },
  outage: "auth"
});
// No answer at all: a game server that answers means the auth server is down, none means no internet.
assert.equal((await offlineAccess({ servers: [reachable] }).accessDuringOutage(alice, down(0))).outage, "auth");
assert.equal((await offlineAccess({ servers: [unreachable] }).accessDuringOutage(alice, down(0))).outage, "network");
assert.equal((await offlineAccess({ online: false, servers: [reachable] }).accessDuringOutage(alice, down(0))).outage, "network");

// Other failures are not hidden behind the saved data.
await assert.rejects(access.listManifests(alice, async () => { throw new Error("사용 가능한 서버 모드팩이 없습니다."); }), /사용 가능한/);
assert.equal(await access.accessDuringOutage(alice, new Error("로그인 세션을 서버에서 인증하지 못했습니다.")), null);

// A launch refused during an outage says so in one line; other launch errors pass through.
assert.equal((await access.launchError(down(503))).message, authOutageMessages.auth);
assert.equal((await offlineAccess({ online: false }).launchError(down(0))).message, authOutageMessages.network);
const other = new Error("모드팩 정보를 가져오지 못했습니다.");
assert.equal(await access.launchError(other), other);

// Start-up: the saved session's user opens the launcher while Supabase is down.
assert.deepEqual(await offlineAccess().restoreUser(async () => { throw down(0); }), { ...alice, gameName: "alice_mc" });
assert.equal(await offlineAccess({ savedUserId: bob.id }).restoreUser(async () => { throw down(0); }), null, "another account's session");
assert.deepEqual(await offlineAccess().restoreUser(async () => bob), bob);
await assert.rejects(offlineAccess().restoreUser(async () => { throw new Error("broken"); }), /broken/);

// Another account never sees this one's list.
await assert.rejects(offlineAccess().listManifests(bob, async () => { throw down(); }), AuthServiceUnavailableError);
await offlineAccess().listManifests(bob, async () => [pack("bob-only")]);
await assert.rejects(offlineAccess().listManifests(alice, async () => { throw down(); }), AuthServiceUnavailableError);
assert.equal(await offlineAccess().accessDuringOutage(alice, down()), null);

// Logging out removes it; a damaged file is ignored.
await offlineAccess().clear();
await assert.rejects(fsp.stat(path.join(root, "offline-snapshot.json")), /ENOENT/);
await fsp.writeFile(path.join(root, "offline-snapshot.json"), "{not json");
await assert.rejects(offlineAccess().listManifests(alice, async () => { throw down(); }), AuthServiceUnavailableError);

// Installed game versions skip the metadata download on later launches.
{
  const installed = InstalledVersions.forInstance(path.join(root, "instance"));
  let installs = 0;
  const install = async () => { installs += 1; return "fabric-loader-0.19.5-26.3"; };
  const usable = new Set(["fabric-loader-0.19.5-26.3"]);
  const isUsable = async (id) => usable.has(id);
  assert.deepEqual(await installed.reuseOrInstall("fabric:26.3:0.19.5", isUsable, install), { versionId: "fabric-loader-0.19.5-26.3", reused: false });
  assert.deepEqual(await installed.reuseOrInstall("fabric:26.3:0.19.5", isUsable, async () => { throw new Error("network"); }), { versionId: "fabric-loader-0.19.5-26.3", reused: true });
  assert.equal(installs, 1);
  // A version whose files are gone is installed again.
  usable.clear();
  await installed.reuseOrInstall("fabric:26.3:0.19.5", isUsable, install);
  assert.equal(installs, 2);
  // A failed install is not remembered.
  await assert.rejects(installed.reuseOrInstall("forge:1.20.1:47.4.0", async () => true, async () => { throw new Error("maven down"); }), /maven down/);
  let forgeInstalls = 0;
  await installed.reuseOrInstall("forge:1.20.1:47.4.0", async () => true, async () => { forgeInstalls += 1; return "1.20.1-forge-47.4.0"; });
  assert.equal(forgeInstalls, 1);
  // Damaged records only mean installing again.
  await fsp.writeFile(path.join(root, "instance", ".bweeep", "installed-versions.json"), "[]");
  await installed.reuseOrInstall("forge:1.20.1:47.4.0", async () => true, async () => { forgeInstalls += 1; return "1.20.1-forge-47.4.0"; });
  assert.equal(forgeInstalls, 2);
  await fsp.writeFile(path.join(root, "instance", ".bweeep", "installed-versions.json"), JSON.stringify({ "forge:1.20.1:47.4.0": "../../evil" }));
  await installed.reuseOrInstall("forge:1.20.1:47.4.0", async () => true, async () => { forgeInstalls += 1; return "1.20.1-forge-47.4.0"; });
  assert.equal(forgeInstalls, 3, "a recorded id that is not a version name is ignored");
}

gameServer.close();
await fsp.rm(root, { recursive: true, force: true });
console.log("offline-access=passed");
