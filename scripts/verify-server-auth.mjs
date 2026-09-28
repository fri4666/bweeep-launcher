#!/usr/bin/env node
// Checks, end to end, that a Minecraft server verifies launcher players
// through the Bweeep Yggdrasil API (authlib-injector) and shows their skins.
// Run it before switching a server (new version, loader or modpack) to
// gameAuth "yggdrasil". Everything runs on this machine: the local Supabase
// stack from scripts/local-supabase.sh, a copy of the server under
// ~/.cache/bweeep-server-auth and real game clients on virtual displays.
// Production servers are only read. /tmp is not used: on WSL it lives in RAM,
// and the game copies there once starved the production server of memory.
//
//   npm run build
//   bash scripts/local-supabase.sh start
//   node scripts/verify-server-auth.mjs scripts/server-auth-scenarios/vanilla-26.3.json
//
// Requires Linux with Xvfb, xdotool, ImageMagick and the JDKs named in the scenario.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(REPO, "package.json"));
const SUPABASE_DIR = process.env.BWEEP_LOCAL_SUPABASE ?? "/tmp/bweeep-local-supabase";
const AGENT = path.join(REPO, "resources", "authlib-injector", "authlib-injector-1.2.8.jar");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The game client part runs inside Electron, like the launcher, because the
// launcher's download and log modules use Electron APIs.
if (process.env.BWEEP_AUTH_CHECK_CLIENT) {
  const { app } = await import("electron");
  await runClient(JSON.parse(await fsp.readFile(process.env.BWEEP_AUTH_CHECK_CLIENT, "utf8")));
  app.exit(0);
  await new Promise(() => {});
}

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error("usage: node scripts/verify-server-auth.mjs <scenario.json>");
const scenario = JSON.parse(await fsp.readFile(scenarioPath, "utf8"));
const WORK = path.join(process.env.BWEEP_AUTH_WORK ?? path.join(os.homedir(), ".cache", "bweeep-server-auth"), scenario.name);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const children = [];
const users = [];
let admin;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`\n${signal}: stopping test processes`);
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  await main();
} catch (error) {
  check("scenario finished without errors", false, error?.stack ?? String(error));
} finally {
  await cleanup();
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${scenario.name}: ${results.length - failed.length}/${results.length} passed${failed.length ? "" : " - ALL PASS"}`);
console.log(`screenshots and logs: ${WORK}`);
process.exit(failed.length ? 1 : 0);

async function main() {
  const local = localSupabase();
  const { createClient } = require("@supabase/supabase-js");
  const opts = { auth: { autoRefreshToken: false, persistSession: false } };
  admin = createClient(local.url, local.serviceKey, opts);
  const apiRoot = `${local.url}/functions/v1/yggdrasil`;
  // An interrupted run can leave its local test accounts behind; their names would be taken.
  const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const leftover of existing?.users ?? []) {
    if (/^auth-check-[a-f0-9]{8}@bweeep\.test$/.test(leftover.email ?? "")) await admin.auth.admin.deleteUser(leftover.id);
  }
  await fsp.rm(WORK, { recursive: true, force: true });
  await fsp.mkdir(WORK, { recursive: true });

  // --- accounts: one colour per player so screenshots show whose skin is whose
  const palette = [
    { name: "AuthCheckRed", body: [210, 40, 40], model: "slim" },
    { name: "AuthCheckPurple", body: [150, 40, 200], model: "default" }
  ].slice(0, scenario.clients ?? 1);
  const players = [];
  for (const colour of palette) players.push(await createPlayer(local, colour));
  for (const player of players) {
    const skin = await callFunction(local, player, { action: "setSkin", png: makeSkin(player.body).toString("base64"), model: player.model });
    check(`${player.name}: skin saved`, skin.status === 200 && /^[a-f0-9]{64}$/.test(skin.body?.skin?.hash ?? ""), `${skin.status}`);
    const auth = await callFunction(local, player, { action: "gameAuth" });
    check(`${player.name}: game token issued`, auth.status === 200 && auth.body?.profile?.name === player.name, `${auth.status}`);
    player.game = auth.body;
    player.skinHash = skin.body?.skin?.hash;
    const texture = await fetch(`${local.url}/storage/v1/object/public/launcher-skins/${player.skinHash}.png`);
    check(`${player.name}: skin file is public`, texture.ok && texture.headers.get("content-type") === "image/png", `${texture.status}`);
  }
  const metadata = await (await fetch(apiRoot)).text();
  check("API metadata publishes the signing key", metadata.includes("BEGIN PUBLIC KEY"));

  // --- API-level rules that do not depend on the game version
  const bogus = await fetch(`${apiRoot}/sessionserver/session/minecraft/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: randomBytes(32).toString("base64url"), selectedProfile: players[0].game.profile.id, serverId: "probe" })
  });
  check("join with an unknown token is refused", bogus.status === 403, `${bogus.status}`);
  const unjoined = await fetch(`${apiRoot}/sessionserver/session/minecraft/hasJoined?username=${players[0].name}&serverId=never-joined`);
  check("hasJoined without a join is empty", unjoined.status === 204, `${unjoined.status}`);

  // --- server copy with authlib-injector, online-mode and RCON
  const server = await startServer(apiRoot);
  const logText = () => fs.readFileSync(path.join(server.dir, "logs", "latest.log"), "utf8");

  // --- real clients
  for (const [index, player] of players.entries()) {
    player.display = `:${170 + index}`;
    player.clientRoot = path.join(WORK, `client-${index}`);
    await startClient(player, { apiRoot, metadata, server });
  }
  for (const player of players) {
    const joined = await waitFor(() => logText().includes(`${player.name} joined the game`), 600_000);
    check(`${player.name}: joined the online-mode server`, joined);
    const uuid = toSignedUuid(player.game.profile.id);
    check(`${player.name}: server uses the account UUID ${uuid}`, logText().includes(`UUID of player ${player.name} is ${uuid}`));
  }

  // --- look at each other and check the skin colours on screen
  if (players.every((player) => logText().includes(`${player.name} joined the game`))) {
    const rcon = await connectRcon(server.rconPort, server.rconPassword);
    for (const command of [
      "time set noon", "weather clear", "forceload add -4 -4 8 8",
      "fill -4 200 -4 4 200 8 minecraft:white_concrete",
      ...players.map((player) => `gamemode creative ${player.name}`),
      `tp ${players[0].name} 0.5 201 0.5 0 0`,
      ...(players[1] ? [`tp ${players[1].name} 0.5 201 3.5 180 0`] : [])
    ]) await rcon.command(command);
    if (!players[1]) {
      // Alone: look at our own skin in the front third-person view.
      await key(players[0], "F5", "F5");
    }
    await sleep(8000);
    for (const [index, player] of players.entries()) {
      await key(player, "F1");
      await sleep(2000);
      const shot = path.join(WORK, `${player.name}.png`);
      execFileSync("import", ["-display", player.display, "-window", "root", shot]);
      const target = players[1] ? players[(index + 1) % players.length] : player;
      const share = colourShare(shot, target.body);
      check(`${player.name}: sees ${target.name}'s skin`, share > 0.01, `${(share * 100).toFixed(1)}% of the centre matches, ${shot}`);
    }
    rcon.close();
  }

  // --- the connection guard agent loads on this version and reports the connection
  for (const player of players) {
    const clientLog = readIfExists(path.join(player.clientRoot, "client.log"));
    check(`${player.name}: connection guard reports the join`, clientLog.includes("STAGE 선택 서버 입장"), clientLog.includes("다른 서버 차단") ? "blocked" : "");
  }
  // Clients are closed from here on; the remaining checks need the memory.
  for (const player of players) await stopClient(player);

  // --- the guard keeps the game on the selected server
  if (scenario.guardProbe !== false) {
    const before = logText().length;
    const probe = { name: "GuardProbe", display: ":178", clientRoot: path.join(WORK, "client-guard-probe"), offline: true, guardTarget: "127.0.0.3:25565" };
    await startClient(probe, { apiRoot, metadata, server });
    const blocked = await waitFor(() => readIfExists(path.join(probe.clientRoot, "client.log")).includes("STAGE 다른 서버 차단"), 420_000);
    await sleep(5000);
    check("a game whose selected server is elsewhere cannot join this one", blocked && !logText().slice(before).includes("GuardProbe"),
      readIfExists(path.join(probe.clientRoot, "client.log")).split("\n").filter((line) => /STAGE|ERROR/.test(line)).slice(-3).join(" | "));
    await stopClient(probe);
  }

  // --- names and UUIDs stay with their member (no OP or character takeover)
  const [owner, other] = players.length > 1 ? players : [players[0], await createPlayer(local, { name: "AuthCheckOther", body: [40, 40, 200], model: "default" })];
  const takeCurrent = await callFunction(local, other, { action: "setGameProfile", gameName: owner.name });
  check("another member's current name is refused", takeCurrent.status === 409, `${takeCurrent.status} ${takeCurrent.body?.message ?? ""}`);

  // --- renaming keeps the UUID; the Minecraft name follows the launcher profile
  const renamed = owner;
  const oldName = renamed.name;
  const newName = `${renamed.name.slice(0, 11)}Renm`;
  const renameResult = await callFunction(local, renamed, { action: "setGameProfile", gameName: newName });
  check("a member can rename to a free name", renameResult.status === 200, `${renameResult.status}`);
  const again = await callFunction(local, renamed, { action: "gameAuth" });
  check("renaming keeps the account UUID", again.body?.profile?.id === renamed.game.profile.id && again.body?.profile?.name === newName,
    `${again.body?.profile?.name} ${again.body?.profile?.id}`);
  const takeOld = await callFunction(local, other, { action: "setGameProfile", gameName: oldName });
  check("another member's earlier name is refused", takeOld.status === 409, `${takeOld.status}`);
  const newcomer = await createPlayer(local, { name: oldName, body: [0, 0, 0], model: "default" });
  const newcomerAuth = await callFunction(local, newcomer, { action: "gameAuth" });
  check("a new member whose Discord name matches an earlier name gets no account", newcomerAuth.status === 409, `${newcomerAuth.status}`);
  const ownerStill = await callFunction(local, renamed, { action: "setGameProfile", gameName: oldName });
  check("a member may go back to their own earlier name", ownerStill.status === 200, `${ownerStill.status}`);
  await callFunction(local, renamed, { action: "setGameProfile", gameName: newName });

  // Reserved UUIDs from a server's usercache: nobody gets an unowned one, only the owner gets theirs.
  const unowned = `Rsv${randomBytes(3).toString("hex")}`;
  const owned = `Own${randomBytes(3).toString("hex")}`;
  const ownedPlayer = await createPlayer(local, { name: owned, body: [0, 0, 0], model: "default" });
  const offlineUuid = async (name) => (await admin.rpc("launcher_offline_uuid", { p_name: name })).data;
  const reservations = await admin.from("launcher_minecraft_uuid_reservations").insert([
    { minecraft_uuid: await offlineUuid(unowned), game_name: unowned, user_id: null, source: "verify-server-auth" },
    { minecraft_uuid: await offlineUuid(owned), game_name: owned, user_id: ownedPlayer.userId, source: "verify-server-auth" }
  ]);
  check("reservations can be recorded", !reservations.error, reservations.error?.message ?? "");
  const unownedPlayer = await createPlayer(local, { name: unowned, body: [0, 0, 0], model: "default" });
  const unownedAuth = await callFunction(local, unownedPlayer, { action: "gameAuth" });
  check("a name reserved for nobody is refused", unownedAuth.status === 409, `${unownedAuth.status}`);
  const ownedAuth = await callFunction(local, ownedPlayer, { action: "gameAuth" });
  check("the owner of a reserved UUID receives exactly it", ownedAuth.body?.profile?.id === String(await offlineUuid(owned)).replaceAll("-", ""),
    `${ownedAuth.status} ${ownedAuth.body?.profile?.id}`);
  await admin.from("launcher_minecraft_uuid_reservations").delete().eq("source", "verify-server-auth");

  // --- game tokens: only the newest works, and the launcher revokes it on game exit
  const joinWith = (token, profileId, serverId) => fetch(`${apiRoot}/sessionserver/session/minecraft/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: token, selectedProfile: profileId, serverId })
  });
  const first = await callFunction(local, other, { action: "gameAuth" });
  const second = await callFunction(local, other, { action: "gameAuth" });
  const oldTokenJoin = await joinWith(first.body.accessToken, first.body.profile.id, "token-old");
  const newTokenJoin = await joinWith(second.body.accessToken, second.body.profile.id, "token-new");
  check("a newer game token retires the older one", oldTokenJoin.status === 403 && newTokenJoin.status === 204, `${oldTokenJoin.status}/${newTokenJoin.status}`);
  const expiresInHours = (Date.parse(second.body.expiresAt) - Date.now()) / 3_600_000;
  check("game tokens last at most 12 hours", expiresInHours > 11 && expiresInHours <= 12, expiresInHours.toFixed(2));

  // --- a server on /yggdrasil/testers only lets testers in
  const hasJoined = (root, name, serverId) => fetch(`${root}/sessionserver/session/minecraft/hasJoined?username=${name}&serverId=${serverId}`);
  const memberRoot = await hasJoined(apiRoot, second.body.profile.name, "token-new");
  const testerRootBefore = await hasJoined(`${apiRoot}/testers`, second.body.profile.name, "token-new");
  await admin.from("launcher_environment_access").insert({ user_id: other.userId, environment: "test", granted_by: other.userId });
  const testerRootAfter = await hasJoined(`${apiRoot}/testers`, second.body.profile.name, "token-new");
  check("a tester-only server refuses members who are not testers", memberRoot.status === 200 && testerRootBefore.status === 204 && testerRootAfter.status === 200,
    `${memberRoot.status}/${testerRootBefore.status}/${testerRootAfter.status}`);

  const revoke = await callFunction(local, other, { action: "revokeGameAuth" });
  const revokedJoin = await joinWith(second.body.accessToken, second.body.profile.id, "token-revoked");
  check("a revoked game token is refused", revoke.status === 200 && revokedJoin.status === 403, `${revoke.status}/${revokedJoin.status}`);

  // --- launchers older than 0.1.35 are told to update once a server uses this API
  const release = await admin.from("launcher_releases").insert({
    pack_id: "auth-check-pack", version: "1", active: true, created_by: other.userId,
    manifest: { ...JSON.parse(await fsp.readFile(path.resolve(REPO, scenario.manifest), "utf8")), id: "auth-check-pack", gameAuth: "yggdrasil" }
  }).select("id").single();
  const oldLauncher = await callFunction(local, other, { action: "catalog" });
  const newLauncher = await callFunction(local, other, { action: "catalog" }, { "x-bweeep-launcher-version": "0.1.35" });
  check("launchers older than 0.1.35 are asked to update", oldLauncher.status === 426 && newLauncher.status === 200, `${oldLauncher.status}/${newLauncher.status}`);
  if (release.data) await admin.from("launcher_releases").delete().eq("id", release.data.id);

  // --- skins: only pictures are stored, changes are rate limited, old files are removed
  const withText = insertPngChunk(makeSkin([1, 2, 3]), "tEXt", Buffer.from("Comment\0payload"));
  const textSkin = await callFunction(local, other, { action: "setSkin", png: withText.toString("base64"), model: "default" });
  check("a skin with extra data is refused", textSkin.status === 400, `${textSkin.status} ${textSkin.body?.message ?? ""}`);
  const firstSkin = await callFunction(local, other, { action: "setSkin", png: makeSkin([9, 9, 9]).toString("base64"), model: "default" });
  const tooSoon = await callFunction(local, other, { action: "setSkin", png: makeSkin([8, 8, 8]).toString("base64"), model: "default" });
  check("skin changes are rate limited", tooSoon.status === 429, `${firstSkin.status}/${tooSoon.status}`);
  await sleep(5500);
  const replaced = await callFunction(local, other, { action: "setSkin", png: makeSkin([7, 7, 7]).toString("base64"), model: "default" });
  const oldFile = await fetch(`${local.url}/storage/v1/object/public/launcher-skins/${firstSkin.body?.skin?.hash}.png`);
  check("a replaced skin file is deleted", replaced.status === 200 && !oldFile.ok, `${replaced.status}/${oldFile.status}`);

  // --- removing a member ends their tokens and tester access
  const beforeRemoval = await callFunction(local, other, { action: "gameAuth" });
  await admin.from("launcher_members").delete().eq("user_id", other.userId);
  const [{ count: tokensLeft }, { count: accessLeft }] = await Promise.all([
    admin.from("launcher_game_auth_tokens").select("user_id", { count: "exact", head: true }).eq("user_id", other.userId),
    admin.from("launcher_environment_access").select("user_id", { count: "exact", head: true }).eq("user_id", other.userId)
  ]);
  const removedLookup = await fetch(`${apiRoot}/api/users/profiles/minecraft/${beforeRemoval.body?.profile?.name}`);
  check("removing a member clears their tokens, tester access and profile", tokensLeft === 0 && accessLeft === 0 && removedLookup.status === 204,
    `${tokensLeft}/${accessLeft}/${removedLookup.status}`);

  // --- a launcher sign-out stops new joins right away
  const signOut = await fetch(`${local.url}/auth/v1/logout?scope=global`, {
    method: "POST",
    headers: { apikey: local.anonKey, authorization: `Bearer ${players[0].accessToken}` }
  });
  const afterSignOut = await fetch(`${apiRoot}/sessionserver/session/minecraft/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken: again.body.accessToken, selectedProfile: again.body.profile.id, serverId: "after-sign-out" })
  });
  check("after sign-out the game token is refused", signOut.status === 204 && afterSignOut.status === 403, `${signOut.status}/${afterSignOut.status}`);

  // --- an offline client using a member's name cannot join
  if (scenario.intruder) {
    const before = logText().length;
    const intruder = { name: players[1]?.name ?? players[0].name, display: ":179", clientRoot: path.join(WORK, "client-intruder"), offline: true };
    await startClient(intruder, { apiRoot, metadata, server });
    const newLines = () => logText().slice(before);
    const refused = await waitFor(() => /Failed to verify username|Disconnecting .*\(.*\)|lost connection/i.test(newLines()), 420_000);
    const joined = newLines().includes(`${intruder.name} joined the game`);
    check("an offline client using a member's name is refused", refused && !joined,
      newLines().split("\n").filter((line) => /verify|Disconnect|lost connection|joined/i.test(line)).slice(-2).join(" | "));
  }
}

function localSupabase() {
  const status = JSON.parse(execFileSync("npx", ["-y", "supabase@2", "status", "-o", "json"], {
    cwd: SUPABASE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
  }));
  if (!/^http:\/\/127\.0\.0\.1:/.test(status.API_URL)) throw new Error(`refusing non-local Supabase ${status.API_URL}`);
  return { url: status.API_URL, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY };
}

async function createPlayer(local, colour) {
  const { createClient } = require("@supabase/supabase-js");
  const email = `auth-check-${randomBytes(4).toString("hex")}@bweeep.test`;
  const password = randomBytes(18).toString("base64url");
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { full_name: colour.name, user_name: colour.name.toLowerCase() }
  });
  if (error) throw error;
  users.push(data.user.id);
  const member = await admin.from("launcher_members").insert({ user_id: data.user.id, role: "member" });
  if (member.error) throw member.error;
  const client = createClient(local.url, local.anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const player = { ...colour, userId: data.user.id, accessToken: signed.data.session.access_token };
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await callFunction(local, player, { action: "status" })).status === 200) break;
    await sleep(2000);
  }
  return player;
}

async function callFunction(local, player, body, extraHeaders = {}) {
  const response = await fetch(`${local.url}/functions/v1/launcher-access`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: local.anonKey, authorization: `Bearer ${player.accessToken}`, ...extraHeaders },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function startServer(apiRoot) {
  const spec = scenario.server;
  const dir = path.join(WORK, "server");
  requireMemory(spec.memoryMb ?? 2048, "server");
  execFileSync("rsync", ["-a", ...(spec.exclude ?? []).flatMap((item) => ["--exclude", item]), `${spec.source}/`, `${dir}/`]);
  for (const removed of spec.removeMods ?? []) await fsp.rm(path.join(dir, "mods", removed), { force: true });
  const port = scenario.port;
  const rconPort = port + 1;
  const rconPassword = randomBytes(12).toString("hex");
  await setProperties(path.join(dir, "server.properties"), {
    "server-port": port, "server-ip": "127.0.0.1", "online-mode": true, "enforce-secure-profile": false,
    "white-list": false, "enforce-whitelist": false, "level-name": "world-auth-check", "spawn-protection": 0,
    "enable-rcon": true, "rcon.port": rconPort, "rcon.password": rconPassword, "view-distance": 6, "simulation-distance": 4,
    "max-players": 8, motd: "Bweeep auth check"
  });
  await fsp.writeFile(path.join(dir, "eula.txt"), "eula=true\n");
  await fsp.rm(path.join(dir, "logs"), { recursive: true, force: true });
  if (execFileSync("ss", ["-ltn"], { encoding: "utf8" }).includes(`:${port} `)) throw new Error(`port ${port} is busy`);
  // JAVA_TOOL_OPTIONS reaches the JVM however the server's own start script launches it.
  const child = spawnLogged(spec.command[0], spec.command.slice(1), {
    cwd: dir,
    env: { ...process.env, JAVA_TOOL_OPTIONS: `-javaagent:${AGENT}=${apiRoot}` }
  }, path.join(WORK, "server.out"));
  const started = await waitFor(() => /Done \(/.test(readIfExists(path.join(dir, "logs", "latest.log"))), spec.startTimeoutMs ?? 600_000);
  check("server starts with authlib-injector and online-mode", started, readIfExists(path.join(WORK, "server.out")).split("\n").filter((line) => line.includes("authlib-injector") && line.includes("Version")).join(""));
  if (!started) throw new Error("server did not start");
  return { dir, port, rconPort, rconPassword, child };
}

async function startClient(player, { apiRoot, metadata, server }) {
  requireMemory(scenario.clientMemoryMb ?? 2500, `client ${player.name}`);
  const instanceRoot = path.join(player.clientRoot, "instances");
  const manifest = JSON.parse(await fsp.readFile(path.resolve(REPO, scenario.manifest), "utf8"));
  const instanceDir = path.join(instanceRoot, manifest.id);
  await fsp.mkdir(path.join(instanceDir, ".bweeep", "runtime", "bin"), { recursive: true });
  // BWEEP_CLIENT_CACHE may name an installed instance of the same pack; its
  // game files are reused, and each client still gets its own game directory.
  const cache = process.env.BWEEP_CLIENT_CACHE;
  for (const shared of cache ? ["assets", "libraries", "versions"] : []) {
    const source = path.join(cache, shared);
    if (!fs.existsSync(source)) continue;
    try { execFileSync("cp", ["-al", source, instanceDir]); } catch { execFileSync("cp", ["-a", source, instanceDir]); }
  }
  fs.symlinkSync(scenario.clientJava, path.join(instanceDir, ".bweeep", "runtime", "bin", "java"));
  // Skip first-run screens so quick play goes straight to the server.
  await fsp.writeFile(path.join(instanceDir, "options.txt"),
    "onboardAccessibility:false\nskipMultiplayerWarning:true\njoinedFirstServer:true\ntutorialStep:none\npauseOnLostFocus:false\nnarrator:0\n");
  const config = {
    manifest: { ...manifest, gameAuth: player.offline ? "offline" : "yggdrasil", server: { host: "127.0.0.1", port: server.port } },
    manifestOverrides: scenario.manifestOverrides ?? {},
    clientSkipMods: scenario.clientSkipMods ?? [],
    instanceRoot,
    identity: player.offline ? null : { id: player.game.profile.id, name: player.game.profile.name, accessToken: player.game.accessToken },
    offlineName: player.name,
    guardTarget: player.guardTarget ?? null,
    heapMb: scenario.clientHeapMb ?? 1536,
    apiRoot,
    metadata
  };
  const configPath = path.join(player.clientRoot, "client.json");
  await fsp.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  spawnLogged("Xvfb", [player.display, "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], {}, path.join(player.clientRoot, "xvfb.log"));
  await sleep(1000);
  // A CommonJS entry that loads this script once Electron is ready; awaiting
  // readiness inside an ES module entry would block Electron's startup.
  const appDir = path.join(player.clientRoot, "electron-app");
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "bweeep-auth-check-client", main: "main.cjs" }));
  await fsp.writeFile(path.join(appDir, "main.cjs"), `const { app } = require("electron");
app.whenReady().then(() => import(${JSON.stringify(import.meta.url)})).catch((error) => {
  console.error(error);
  app.exit(1);
});
`);
  player.process = spawnLogged(path.join(REPO, "node_modules", ".bin", "electron"), [
    "--no-sandbox", `--user-data-dir=${path.join(player.clientRoot, "electron-data")}`, appDir
  ], {
    env: { ...process.env, DISPLAY: player.display, BWEEP_AUTH_CHECK_CLIENT: configPath }
  }, path.join(player.clientRoot, "client.log"));
}

/** Stops a client and its game; the Electron process leads their process group. */
async function stopClient(player) {
  if (!player.process?.pid) return;
  try { process.kill(-player.process.pid, "SIGTERM"); } catch { /* already gone */ }
  await sleep(3000);
  try { process.kill(-player.process.pid, "SIGKILL"); } catch { /* already gone */ }
}

/** Inserts a chunk right after IHDR, with a valid CRC. */
function insertPngChunk(png, type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(zlib.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  const afterHeader = 8 + 12 + 13;
  return Buffer.concat([png.subarray(0, afterHeader), chunk, png.subarray(afterHeader)]);
}

async function runClient(config) {
  const { syncModpack } = await import(path.join(REPO, "dist/src/main/sync.js"));
  const { installAndLaunch } = await import(path.join(REPO, "dist/src/main/minecraft-runtime.js"));
  const { bundledFeatureMods } = await import(path.join(REPO, "dist/src/main/client-feature-mods.js"));
  const { createOfflineLaunchIdentity } = await import(path.join(REPO, "dist/src/main/launch-identity.js"));
  const { ensureAuthlibInjector, authlibInjectorJvmArgs, parseYggdrasilMetadata } = await import(path.join(REPO, "dist/src/main/authlib-injector.js"));
  const { connectionGuardEnabled, connectionGuardJvmArgs, ensureConnectionGuard } = await import(path.join(REPO, "dist/src/main/connection-guard.js"));
  const manifest = { ...config.manifest, ...config.manifestOverrides };
  const mods = bundledFeatureMods(path.join(REPO, "resources", "client-mods"), manifest);
  let stage = "";
  const progress = (event) => {
    if (event.stage && event.stage !== stage) { stage = event.stage; console.log(`STAGE ${event.stage}: ${event.message}`); }
    if (event.kind === "error") console.log(`ERROR ${event.message}`);
  };
  const synced = await syncModpack({ instanceDir: config.instanceRoot, manifest }, progress);
  // Some pack mods cannot run on a virtual display (for example IME mods that
  // need an input method); scenarios list them here. They do not touch login.
  for (const pattern of config.clientSkipMods ?? []) {
    const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
    for (const name of await fsp.readdir(path.join(synced.instanceDir, "mods")).catch(() => [])) {
      if (matcher.test(name)) {
        await fsp.rm(path.join(synced.instanceDir, "mods", name));
        console.log(`SKIPPED ${name}`);
      }
    }
  }
  const authorize = async () => {
    if (!config.identity) return { identity: createOfflineLaunchIdentity("offline-intruder", config.offlineName), ticket: "" };
    const agent = await ensureAuthlibInjector(path.join(REPO, "resources", "authlib-injector"), synced.instanceDir);
    const launch = { apiRoot: config.apiRoot, metadata: parseYggdrasilMetadata(config.metadata) };
    return { identity: config.identity, ticket: "", yggdrasil: { jvmArgs: authlibInjectorJvmArgs(agent, launch) } };
  };
  // The same guard the launcher adds. A probe client may name a different
  // selected server, to check that this one is then out of reach.
  const guardManifest = config.guardTarget
    ? { ...manifest, server: { host: config.guardTarget.split(":")[0], port: Number(config.guardTarget.split(":")[1]) } }
    : manifest;
  const guardArgs = connectionGuardEnabled(manifest)
    ? connectionGuardJvmArgs(await ensureConnectionGuard(path.join(REPO, "resources", "java-agent"), synced.instanceDir), guardManifest)
    : [];
  // The launcher's 2-6 GB heap is for players; a test client gets a small one.
  // These come after the launcher's own -Xms/-Xmx, so the JVM uses them.
  const heapArgs = [`-Xms512M`, `-Xmx${config.heapMb ?? 1536}M`];
  const exit = await new Promise((resolve) => {
    installAndLaunch(manifest, synced.instanceDir, authorize, mods, progress, resolve, [...guardArgs, ...heapArgs])
      .then((launched) => {
        console.log(`LAUNCHED ${JSON.stringify(launched)}`);
        // Let the kernel pick test clients before any production process under memory pressure.
        try { fs.writeFileSync(`/proc/${launched.pid}/oom_score_adj`, "1000"); } catch { /* best effort */ }
      })
      .catch((error) => resolve({ abnormal: true, message: String(error?.stack ?? error) }));
  });
  console.log(`GAME_EXIT ${JSON.stringify(exit)}`);
}

function spawnLogged(command, args, options, logFile) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", out, out] });
  try { fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000"); } catch { /* best effort */ }
  children.push(child);
  return child;
}

async function cleanup() {
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await sleep(3000);
  for (const child of children) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  for (const userId of users) await admin?.auth.admin.deleteUser(userId).catch(() => {});
  await fsp.rm(path.join(WORK, "server", "world-auth-check"), { recursive: true, force: true }).catch(() => {});
}

/** Refuses to start a test process unless memory is left over for the servers already running. */
function requireMemory(megabytes, what) {
  const reserve = 1536;
  const available = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024;
  if (available < megabytes + reserve) {
    throw new Error(`not enough free memory for the ${what}: ${Math.round(available)} MB available, ${megabytes} MB needed plus ${reserve} MB kept free`);
  }
}

async function setProperties(file, values) {
  const lines = readIfExists(file).split("\n").filter((line) => line && !Object.hasOwn(values, line.split("=")[0]));
  for (const [key, value] of Object.entries(values)) lines.push(`${key}=${value}`);
  await fsp.writeFile(file, `${lines.join("\n")}\n`);
}

function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

async function waitFor(predicate, timeoutMs, onTick = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (onTick) await onTick();
    await sleep(3000);
  }
  return predicate();
}

// Keys go to the focused window; without a window manager nothing focuses the game on its own.
async function key(player, ...keys) {
  const env = { ...process.env, DISPLAY: player.display };
  let window = "";
  try { window = execFileSync("xdotool", ["search", "--name", "Minecraft"], { env, encoding: "utf8" }).trim().split("\n")[0]; } catch { /* no window yet */ }
  for (const name of keys) {
    try {
      if (window) execFileSync("xdotool", ["windowfocus", "--sync", window], { env });
      execFileSync("xdotool", ["key", name], { env });
    } catch { /* window not ready */ }
    await sleep(700);
  }
}

function colourShare(file, [r, g, b]) {
  const width = 400, height = 400;
  const raw = execFileSync("convert", [file, "-gravity", "center", "-crop", `${width}x${height}+0+0`, "-depth", "8", "rgb:-"], { maxBuffer: 16 << 20 });
  let matches = 0;
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const [pr, pg, pb] = [raw[i], raw[i + 1], raw[i + 2]];
    // Shading darkens the skin, so compare hue ratios rather than exact values.
    const scale = Math.max(pr, pg, pb) / Math.max(r, g, b);
    if (scale > 0.25 && Math.abs(pr - r * scale) < 40 && Math.abs(pg - g * scale) < 40 && Math.abs(pb - b * scale) < 40) matches += 1;
  }
  return matches / (width * height);
}

function toSignedUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// 64x64 skin in one colour per part; the overlay layer stays transparent.
function makeSkin(body) {
  const w = 64, h = 64;
  const px = Buffer.alloc(w * h * 4);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  };
  const skinTone = [240, 200, 60], limbs = body.map((value) => Math.round(value * 0.7));
  fill(0, 0, 32, 16, skinTone);
  fill(0, 16, 56, 32, body);
  fill(16, 48, 48, 64, body);
  fill(40, 16, 56, 32, limbs);
  fill(32, 48, 48, 64, limbs);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const content = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(content));
    return Buffer.concat([length, content, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Minimal Source RCON client: enough to place players for the screenshot.
async function connectRcon(port, password) {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let buffer = Buffer.alloc(0);
  const waiters = [];
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
      const length = buffer.readInt32LE(0);
      const body = buffer.subarray(12, 4 + length - 2).toString("utf8");
      buffer = buffer.subarray(4 + length);
      waiters.shift()?.(body);
    }
  });
  const send = (type, body) => {
    const payload = Buffer.from(body, "utf8");
    const packet = Buffer.alloc(14 + payload.length);
    packet.writeInt32LE(10 + payload.length, 0);
    packet.writeInt32LE(1, 4);
    packet.writeInt32LE(type, 8);
    payload.copy(packet, 12);
    socket.write(packet);
    return new Promise((resolve) => waiters.push(resolve));
  };
  await send(3, password);
  return {
    async command(text) {
      const reply = await send(2, text);
      console.log(`  rcon> ${text}${reply ? ` -> ${reply.trim()}` : ""}`);
      return reply;
    },
    close() { socket.end(); }
  };
}
