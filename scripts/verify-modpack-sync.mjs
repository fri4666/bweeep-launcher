// Modpack sync against a local HTTP server: files already on disk are kept
// across pack versions, downloads run in parallel, retry, resume a partial
// file, stop early when the disk is full, and pack config files the player
// edited are never overwritten.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { strToU8, zipSync } from "fflate";
import * as yauzl from "yauzl";
const { syncModpack } = await import(process.env.BWEEP_SYNC_MODULE ?? "../dist/src/main/sync.js");

// A caller can isolate every fixture with TMPDIR; otherwise avoid memory-backed /tmp.
const testCache = process.env.TMPDIR ? tmpdir() : path.join(homedir(), ".cache");
await fsp.mkdir(testCache, { recursive: true });
const root = await fsp.mkdtemp(path.join(testCache, "bweeep-sync-check-"));
const sha = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
const quiet = () => undefined;
const readJson = async (file) => JSON.parse(await fsp.readFile(file, "utf8"));

// --- Local file server ------------------------------------------------------
const bodies = new Map();
const failures = new Map();
const requests = [];
let active = 0;
let maxActive = 0;
let rangeSupport = true;
const server = http.createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, "http://x").pathname.slice(1));
  requests.push({ name, range: request.headers.range ?? null });
  active += 1;
  maxActive = Math.max(maxActive, active);
  try {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const left = failures.get(name) ?? 0;
    if (left > 0) {
      failures.set(name, left - 1);
      response.writeHead(500).end();
      return;
    }
    const body = bodies.get(name);
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const range = rangeSupport ? /^bytes=(\d+)-$/.exec(request.headers.range ?? "") : null;
    if (range) {
      const start = Number(range[1]);
      if (start >= body.length) {
        response.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
        return;
      }
      response.writeHead(206, { "content-range": `bytes ${start}-${body.length - 1}/${body.length}`, "content-length": body.length - start });
      response.end(body.subarray(start));
      return;
    }
    response.writeHead(200, { "content-length": body.length });
    response.end(body);
  } finally {
    active -= 1;
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function packFile(name, bytes, algorithm = "sha512") {
  bodies.set(name, bytes);
  return { path: `mods/${name}`, size: bytes.length, [algorithm]: sha(algorithm, bytes), url: `${base}/${encodeURIComponent(name)}` };
}

const manifestBase = {
  schemaVersion: 1,
  id: "sync-pack",
  name: "Sync Pack",
  minecraftVersion: "26.3",
  java: { majorVersion: 25, component: "java-runtime-epsilon" },
  loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "example.invalid", port: 25565 },
  gameAuth: "yggdrasil"
};
const options = { fetch: (url, init) => fetch(url, init), retryDelayMs: 20 };
const sync = (version, files, extra = {}) => syncModpack(
  { instanceDir: root, manifest: { ...manifestBase, version, files } },
  quiet,
  { ...options, ...extra }
);
const instance = path.join(root, "sync-pack");

try {
  // 1. First install: every file, at most 6 at a time.
  const files = Array.from({ length: 10 }, (_, index) => packFile(`mod-${index}.jar`, crypto.randomBytes(64 * 1024 + index), index % 2 ? "sha256" : "sha512"));
  let result = await sync("1", files);
  assert.equal(result.downloaded, 10);
  assert.ok(maxActive > 1 && maxActive <= 6, `downloads run in parallel, at most 6 (saw ${maxActive})`);
  for (const file of files) {
    assert.equal(sha(file.sha256 ? "sha256" : "sha512", await fsp.readFile(path.join(instance, file.path))), file.sha256 ?? file.sha512);
  }
  console.log("modpack-sync-parallel-downloads=passed");

  // 2. A new pack version with the same files downloads nothing.
  requests.length = 0;
  result = await sync("2", files);
  assert.equal(result.downloaded, 0, "files whose hash matches are kept across pack versions");
  assert.equal(result.skipped, 10);
  assert.equal(requests.length, 0);
  console.log("modpack-sync-skip-by-hash-across-versions=passed");

  // 3. Unchanged size and time: the cached hash is trusted, the file is not read again.
  const first = path.join(instance, files[0].path);
  const stat = await fsp.stat(first);
  await fsp.writeFile(first, crypto.randomBytes(stat.size));
  await fsp.utimes(first, stat.atime, stat.mtime);
  result = await sync("2", files);
  assert.equal(result.downloaded, 0, "a file with the same size and time is not re-hashed");
  // A changed time makes the launcher hash it again and replace the bad copy.
  await fsp.utimes(first, new Date(), new Date(Date.now() + 5_000));
  result = await sync("2", files);
  assert.equal(result.downloaded, 1);
  assert.equal(sha("sha512", await fsp.readFile(first)), files[0].sha512);
  console.log("modpack-sync-hash-cache=passed");

  // 4. Resume: a partial download continues with a Range request.
  const big = packFile("big.jar", crypto.randomBytes(300 * 1024));
  const bigTarget = path.join(instance, big.path);
  await fsp.writeFile(`${bigTarget}.part`, bodies.get("big.jar").subarray(0, 100 * 1024));
  requests.length = 0;
  result = await sync("3", [...files, big]);
  assert.equal(result.downloaded, 1);
  assert.deepEqual(requests.map((request) => request.range), [`bytes=${100 * 1024}-`], "the part is resumed, not restarted");
  assert.equal(sha("sha512", await fsp.readFile(bigTarget)), big.sha512);
  await fsp.access(`${bigTarget}.part`).then(() => assert.fail("the .part file is renamed away"), () => undefined);

  // A server without Range support sends the whole file again; the result is still exact.
  rangeSupport = false;
  await fsp.rm(bigTarget);
  await fsp.writeFile(`${bigTarget}.part`, bodies.get("big.jar").subarray(0, 50 * 1024));
  result = await sync("3", [...files, big]);
  assert.equal(result.downloaded, 1);
  assert.equal(sha("sha512", await fsp.readFile(bigTarget)), big.sha512);
  rangeSupport = true;

  // A corrupted part fails its hash, is thrown away and downloaded fresh.
  await fsp.rm(bigTarget);
  await fsp.writeFile(`${bigTarget}.part`, crypto.randomBytes(120 * 1024));
  requests.length = 0;
  result = await sync("3", [...files, big]);
  assert.equal(result.downloaded, 1);
  assert.equal(sha("sha512", await fsp.readFile(bigTarget)), big.sha512);
  assert.deepEqual(requests.map((request) => request.range), [`bytes=${120 * 1024}-`, null], "after a bad resume the file starts over");
  console.log("modpack-sync-resume=passed");

  // 5. Retry: two failures are absorbed, three are not.
  const flaky = packFile("flaky.jar", crypto.randomBytes(10 * 1024));
  failures.set("flaky.jar", 2);
  result = await sync("4", [...files, big, flaky]);
  assert.equal(result.downloaded, 1, "the file arrives on the third try");
  const broken = packFile("broken.jar", crypto.randomBytes(10 * 1024));
  failures.set("broken.jar", 3);
  await assert.rejects(sync("5", [...files, big, flaky, broken]), /HTTP 500/);
  console.log("modpack-sync-retry=passed");

  // 6. Wrong bytes from the server never land.
  const wrong = { ...packFile("wrong.jar", crypto.randomBytes(8 * 1024)), sha512: "0".repeat(128) };
  await assert.rejects(sync("6", [...files, wrong], { tries: 2 }), /해시 불일치/);
  await fsp.access(path.join(instance, wrong.path)).then(() => assert.fail("a file with the wrong hash was kept"), () => undefined);
  console.log("modpack-sync-strict-hash=passed");

  // 7. Not enough disk: stop before downloading anything, in one short line.
  const huge = packFile("huge.jar", crypto.randomBytes(4 * 1024));
  requests.length = 0;
  await assert.rejects(sync("7", [...files, huge], { freeBytes: async () => 1024 }), (error) => /^저장 공간이 부족해요 · [\d.]+GB 더 필요해요$/.test(error.message));
  assert.equal(requests.length, 0);
  console.log("modpack-sync-disk-space=passed");

  // 8. Crash Assistant is never installed, and a copy an older launcher put there is removed.
  const crashAssistant = packFile("CrashAssistant-forge-1.19-1.20.1-1.11.10.jar", crypto.randomBytes(4 * 1024));
  const crashTarget = path.join(instance, crashAssistant.path);
  await fsp.writeFile(crashTarget, bodies.get("CrashAssistant-forge-1.19-1.20.1-1.11.10.jar"));
  const managedPath = path.join(instance, ".bweeep", "managed-files.json");
  const managed = JSON.parse(await fsp.readFile(managedPath, "utf8"));
  await fsp.writeFile(managedPath, JSON.stringify([...managed, crashAssistant.path]));
  requests.length = 0;
  result = await sync("8", [...files, crashAssistant]);
  assert.equal(requests.length, 0, "Crash Assistant is not downloaded");
  assert.equal(await fsp.access(crashTarget).then(() => true, () => false), false, "an installed Crash Assistant is removed");
  console.log("modpack-sync-skips-crash-assistant=passed");

  // --- Pack config overrides --------------------------------------------------
  const archives = path.join(instance, ".bweeep", "mrpack");
  const syncOverrides = async (version, overrides) => {
    const entries = {
      "modrinth.index.json": strToU8(JSON.stringify({ formatVersion: 1, game: "minecraft", versionId: version, name: "pack", dependencies: { minecraft: "26.3", "fabric-loader": "0.19.5" }, files: [] }))
    };
    for (const [name, text] of Object.entries(overrides)) entries[`overrides/${name}`] = strToU8(text);
    const zip = Buffer.from(zipSync(entries, { mtime: "2026-01-01T00:00:00Z" }));
    const sha512 = sha("sha512", zip);
    await fsp.mkdir(archives, { recursive: true });
    await fsp.writeFile(path.join(archives, `${sha512}.mrpack`), zip);
    return syncModpack({ instanceDir: root, manifest: { ...manifestBase, version, files: [], mrpack: { url: "https://example.invalid/pack.mrpack", size: zip.length, sha512 } } }, quiet, options);
  };
  const read = (name) => fsp.readFile(path.join(instance, name), "utf8");
  const exists = (name) => fsp.access(path.join(instance, name)).then(() => true, () => false);

  await syncOverrides("o1", { "config/a.toml": "A1", "config/b.toml": "B1", "config/gone.toml": "G1", "config/kept.toml": "K1", "options.txt": "pack-options" });
  assert.equal(await read("config/a.toml"), "A1");
  assert.equal(await read("options.txt"), "pack-options");
  await fsp.writeFile(path.join(instance, "config/a.toml"), "A-player");
  await fsp.writeFile(path.join(instance, "config/kept.toml"), "K-player");
  await fsp.writeFile(path.join(instance, "options.txt"), "player-options");
  // Same pack again: nothing the player changed moves.
  await syncOverrides("o1", { "config/a.toml": "A1", "config/b.toml": "B1", "config/gone.toml": "G1", "config/kept.toml": "K1", "options.txt": "pack-options" });
  assert.equal(await read("config/a.toml"), "A-player", "a player-edited config survives a relaunch");
  // A new pack version: untouched files follow it, edited ones stay, dropped untouched ones go.
  await syncOverrides("o2", { "config/a.toml": "A2", "config/b.toml": "B2", "config/c.toml": "C2", "options.txt": "pack-options-2" });
  assert.equal(await read("config/a.toml"), "A-player", "a player-edited config survives a pack update");
  assert.equal(await read("config/b.toml"), "B2", "an untouched config follows the pack");
  assert.equal(await read("config/c.toml"), "C2");
  assert.equal(await exists("config/gone.toml"), false, "an untouched config the pack dropped is removed");
  assert.equal(await read("config/kept.toml"), "K-player", "an edited config the pack dropped is kept");
  assert.equal(await read("options.txt"), "player-options", "options.txt is never replaced");
  // A deleted default comes back.
  await fsp.rm(path.join(instance, "config/b.toml"));
  await syncOverrides("o2", { "config/a.toml": "A2", "config/b.toml": "B2", "config/c.toml": "C2", "options.txt": "pack-options-2" });
  assert.equal(await read("config/b.toml"), "B2");
  // The player puts the pack's text back: the file follows pack updates again.
  await fsp.writeFile(path.join(instance, "config/a.toml"), "A2");
  await syncOverrides("o2", { "config/a.toml": "A2", "config/b.toml": "B2", "config/c.toml": "C2" });
  await syncOverrides("o3", { "config/a.toml": "A3", "config/b.toml": "B2", "config/c.toml": "C2" });
  assert.equal(await read("config/a.toml"), "A3");

  // Records from older launchers list paths only: a file that differs from the pack is the player's.
  await fsp.writeFile(path.join(instance, ".bweeep", "mrpack-overrides.json"), JSON.stringify(["config/a.toml", "config/b.toml", "config/c.toml"]));
  await fsp.writeFile(path.join(instance, "config/b.toml"), "B-player");
  await syncOverrides("o4", { "config/a.toml": "A4", "config/b.toml": "B4", "config/c.toml": "C2" });
  assert.equal(await read("config/a.toml"), "A3", "without a recorded hash a differing file is left alone");
  assert.equal(await read("config/b.toml"), "B-player");
  assert.equal(await read("config/c.toml"), "C2");
  await syncOverrides("o5", { "config/a.toml": "A4", "config/b.toml": "B4", "config/c.toml": "C5" });
  assert.equal(await read("config/c.toml"), "C5", "a file that matched the pack under the old record follows updates again");
  console.log("modpack-overrides-keep-player-edits=passed");

  // --- An unchanged archive is not opened again ---------------------------------
  const statePath = path.join(instance, ".bweeep", "mrpack-state.json");
  const tempDirPath = path.join(instance, ".bweeep", "mrpack-tmp");
  const cdnFetch = (url, init) => fetch(url.replace("https://cdn.test", base), init);
  const bigText = "0123456789abcdef".repeat(256 * 1024 / 16 * 3); // 3 MB: streamed, not buffered
  const modBytes = crypto.randomBytes(20 * 1024);
  bodies.set("pack-mod.jar", modBytes);
  const packMod = { path: "mods/pack-mod.jar", hashes: { sha512: sha("sha512", modBytes) }, downloads: ["https://cdn.test/pack-mod.jar"], fileSize: modBytes.length };
  const archiveNames = async () => (await fsp.readdir(archives)).filter((name) => name.endsWith(".mrpack"));
  const syncArchive = async (version, overrides, { fetchWith = cdnFetch } = {}) => {
    const entries = {
      "modrinth.index.json": strToU8(JSON.stringify({ formatVersion: 1, game: "minecraft", versionId: version, name: "pack", dependencies: { minecraft: "26.3", "fabric-loader": "0.19.5" }, files: [packMod] }))
    };
    for (const [name, text] of Object.entries(overrides)) entries[`overrides/${name}`] = strToU8(text);
    const zip = Buffer.from(zipSync(entries, { level: 0, mtime: "2026-01-01T00:00:00Z" }));
    const sha512 = sha("sha512", zip);
    await fsp.mkdir(archives, { recursive: true });
    const archivePath = path.join(archives, `${sha512}.mrpack`);
    // The archive lands on disk like a finished download; a launch that keeps it never fetches it.
    await fsp.writeFile(archivePath, zip);
    return { sha512, archivePath, result: await syncModpack({ instanceDir: root, manifest: { ...manifestBase, version, files: [], mrpack: { url: "https://cdn.test/pack.mrpack", size: zip.length, sha512 } } }, quiet, { ...options, fetch: fetchWith }) };
  };
  const overridesV1 = { "config/x.toml": "X1", "config/y.toml": "Y1", "saves/world/big.dat": bigText };
  let pass = await syncArchive("s1", overridesV1);
  assert.equal(await read("config/x.toml"), "X1");
  assert.equal(await read("saves/world/big.dat"), bigText, "a big override is streamed into place intact");
  assert.equal(await fsp.access(tempDirPath).then(() => true, () => false), false, "no temporary files are left behind");
  assert.ok(await fsp.access(statePath).then(() => true, () => false), "a finished run leaves its state");
  assert.equal((await readJson(statePath)).overrides.length, 3);
  assert.equal((await archiveNames()).length, 1, "only the archive in use is kept");
  await fsp.access(path.join(instance, "mods", "pack-mod.jar"));

  // Player edit + same archive again with the archive file gone: nothing is fetched, nothing reopened.
  await fsp.writeFile(path.join(instance, "config/x.toml"), "X-player");
  await fsp.rm(pass.archivePath);
  requests.length = 0;
  const offline = async () => assert.fail("an unchanged launch must not fetch the archive");
  const again = await syncModpack({ instanceDir: root, manifest: { ...manifestBase, version: "s1b", files: [], mrpack: { url: "https://cdn.test/pack.mrpack", size: 1, sha512: pass.sha512 } } }, quiet, { ...options, fetch: offline });
  assert.equal(again.downloaded, 0);
  assert.equal(again.skipped, 1, "the mod list comes from the saved state");
  assert.equal(await read("config/x.toml"), "X-player");
  assert.equal(requests.length, 0);
  assert.equal((await archiveNames()).length, 0, "the fast path did not bring the archive back");

  // A different loader version in the manifest is not waved through by the saved state.
  await assert.rejects(syncModpack({ instanceDir: root, manifest: { ...manifestBase, loader: { kind: "fabric", version: "9.9.9" }, version: "s1c", files: [], mrpack: { url: "https://cdn.test/pack.mrpack", size: 1, sha512: pass.sha512 } } }, quiet, { ...options, fetch: offline }), /모드팩을 내려받지 못했습니다|offline|unchanged/);

  // A deleted default comes back, which needs the archive again.
  pass = await syncArchive("s1", overridesV1);
  await fsp.rm(path.join(instance, "config/y.toml"));
  await syncArchive("s1", overridesV1);
  assert.equal(await read("config/y.toml"), "Y1", "a deleted default is restored on the next launch");
  assert.equal(await read("config/x.toml"), "X-player", "a player's edit still wins");

  // Repair only the missing defaults. Existing entries (including a large one)
  // are neither decompressed nor hashed; all previous override hashes survive.
  const recordPath = path.join(instance, ".bweeep", "mrpack-overrides.json");
  const beforeRepair = await readJson(recordPath);
  await fsp.writeFile(path.join(instance, "config/retained-record.toml"), "retained");
  beforeRepair.files["config/retained-record.toml"] = sha("sha256", "retained");
  await fsp.writeFile(recordPath, JSON.stringify(beforeRepair));
  await fsp.rm(path.join(instance, "config/y.toml"));
  const openedEntries = [];
  const hashedPaths = [];
  const originalOpen = yauzl.ZipFile.prototype.openReadStream;
  const originalRead = fs.createReadStream;
  yauzl.ZipFile.prototype.openReadStream = function (entry, ...args) {
    openedEntries.push(entry.fileName);
    return originalOpen.call(this, entry, ...args);
  };
  fs.createReadStream = function (target, ...args) {
    hashedPaths.push(String(target));
    return originalRead.call(this, target, ...args);
  };
  try {
    await syncArchive("s1", overridesV1);
  } finally {
    yauzl.ZipFile.prototype.openReadStream = originalOpen;
    fs.createReadStream = originalRead;
  }
  assert.deepEqual(openedEntries, ["modrinth.index.json", "overrides/config/y.toml"], "only the index and missing default are decompressed");
  for (const name of ["config/x.toml", "saves/world/big.dat"]) {
    assert.equal(hashedPaths.includes(path.join(instance, name)), false, `${name} is not re-hashed during repair`);
  }
  assert.deepEqual(await readJson(recordPath), beforeRepair, "repair preserves the complete override record, including older entries");
  assert.equal(await read("config/retained-record.toml"), "retained", "repair does not remove an older recorded default");
  assert.deepEqual((await readJson(statePath)).overrides, ["config/x.toml", "config/y.toml", "saves/world/big.dat"], "repair retains the complete archive state");
  assert.equal(await read("config/x.toml"), "X-player");
  assert.equal(await read("config/y.toml"), "Y1");
  console.log("modpack-missing-default-only-repair=passed");

  // A path replaced by a directory is an error, not a complete installation.
  await fsp.rm(path.join(instance, "config/y.toml"));
  await fsp.mkdir(path.join(instance, "config/y.toml"));
  await assert.rejects(syncArchive("s1", overridesV1), /파일이 아닙니다/);
  await fsp.rmdir(path.join(instance, "config/y.toml"));
  if (process.platform !== "win32") {
    await fsp.symlink(path.join(instance, "config"), path.join(instance, "config/y.toml"));
    await assert.rejects(syncArchive("s1", overridesV1), /파일이 아닙니다/, "a directory symlink is not a completed default");
    await fsp.unlink(path.join(instance, "config/y.toml"));
  }

  // Missing archive repair must still validate downloaded bytes before use.
  const archiveBytes = await fsp.readFile(pass.archivePath);
  const sameRequest = { instanceDir: root, manifest: { ...manifestBase, version: "s1", files: [], mrpack: { url: "https://cdn.test/pack.mrpack", size: archiveBytes.length, sha512: pass.sha512 } } };
  bodies.set("pack.mrpack", Buffer.alloc(archiveBytes.length));
  await fsp.rm(pass.archivePath);
  await assert.rejects(syncModpack(sameRequest, quiet, { ...options, fetch: cdnFetch }), /모드팩을 내려받지 못했습니다/);
  assert.equal(await exists("config/y.toml"), false, "an invalid archive restores nothing");
  bodies.set("pack.mrpack", archiveBytes);
  await syncModpack(sameRequest, quiet, { ...options, fetch: cdnFetch });
  assert.equal(await read("config/y.toml"), "Y1", "a verified re-downloaded archive restores the missing default");
  assert.equal(await read("config/x.toml"), "X-player");
  console.log("modpack-repair-validates-missing-archive=passed");

  // Invalid saved state falls back to the verified archive and rebuilds state.
  await fsp.writeFile(statePath, JSON.stringify({ version: 1, overrides: ["../outside"] }));
  await syncModpack(sameRequest, quiet, { ...options, fetch: cdnFetch });
  assert.equal((await readJson(statePath)).overrides.length, 3);
  assert.equal(await read("config/x.toml"), "X-player");
  assert.equal(await exists(tempDirPath), false);
  console.log("modpack-repair-rejects-directory-and-invalid-state=passed");

  // A changed archive applies again: untouched files follow, edited ones stay, the old archive goes.
  const oldArchive = pass.archivePath;
  const overridesV2 = { "config/x.toml": "X2", "config/y.toml": "Y2", "saves/world/big.dat": `${bigText}!` };
  pass = await syncArchive("s2", overridesV2);
  assert.equal(await read("config/y.toml"), "Y2");
  assert.equal(await read("config/x.toml"), "X-player");
  assert.equal(await read("saves/world/big.dat"), `${bigText}!`);
  assert.equal(await fsp.access(oldArchive).then(() => true, () => false), false, "the previous archive is removed");
  assert.equal((await archiveNames()).length, 1);
  assert.equal((await readJson(statePath)).archive, pass.sha512);

  // Normalized duplicate paths must retain archive order with parallel work.
  await syncArchive("s3", { "config/duplicate.toml": "first", "config/./duplicate.toml": "second", "config/other.toml": "other" });
  assert.equal(await read("config/duplicate.toml"), "first", "a later alias sees the first entry, as in a sequential apply");
  assert.equal(await read("config/other.toml"), "other");
  assert.equal(await exists(tempDirPath), false, "parallel work leaves no temporary files");

  // A failed handler waits for other streams before cleanup and never settles
  // the archive state. A retry can complete the partly applied update.
  const settledState = await fsp.readFile(statePath, "utf8");
  const failingOverrides = { "saves/world/big.dat": `${bigText}!!`, "config/fail.toml": "file", "config/after-fail.toml": "after" };
  await fsp.mkdir(path.join(instance, "config/fail.toml"));
  await assert.rejects(syncArchive("s4", failingOverrides), /EISDIR|illegal operation on a directory/);
  assert.equal(await exists(tempDirPath), false, "all in-flight entry work settles before temporary files are removed");
  assert.equal(await fsp.readFile(statePath, "utf8"), settledState, "a failed update does not commit its state");
  await fsp.rmdir(path.join(instance, "config/fail.toml"));
  await syncArchive("s4", failingOverrides);
  assert.equal(await read("config/fail.toml"), "file");
  assert.equal(await exists(tempDirPath), false);
  console.log("modpack-parallel-override-order-and-cleanup=passed");

  // Many adjacent small entries share reads; a larger entry crosses the cache
  // blocks without changing bytes. Every archive handle closes before return.
  const cachedOverrides = Object.fromEntries(Array.from({ length: 220 }, (_, index) => [`config/cache/file-${index}.json`, `entry-${index}:${"x".repeat(1800)}`]));
  cachedOverrides["config/cache/boundary.dat"] = crypto.randomBytes(400 * 1024).toString("base64");
  const originalFileOpen = fsp.open;
  let archiveHandles = 0;
  let archiveCloses = 0;
  const readSizes = [];
  fsp.open = async function (target, flags, ...args) {
    const file = await originalFileOpen.call(this, target, flags, ...args);
    if (flags === "r" && String(target).endsWith(".mrpack")) {
      archiveHandles += 1;
      const originalFileRead = file.read.bind(file);
      const originalFileClose = file.close.bind(file);
      file.read = function (...readArgs) { readSizes.push(readArgs[2]); return originalFileRead(...readArgs); };
      file.close = async function () { archiveCloses += 1; return originalFileClose(); };
    }
    return file;
  };
  let cachedPass;
  try { cachedPass = await syncArchive("s5", cachedOverrides); } finally { fsp.open = originalFileOpen; }
  assert.equal(await read("config/cache/boundary.dat"), cachedOverrides["config/cache/boundary.dat"]);
  assert.equal(archiveHandles, 2, "one metadata pass and one direct apply handle");
  assert.equal(archiveCloses, archiveHandles, "all archive handles close");
  assert.ok(readSizes.length < 50, `small header/data reads are combined (${readSizes.length} reads for 221 overrides)`);
  assert.ok(readSizes.every((size) => size <= 128 * 1024), "individual reads stay bounded");

  // Warm checks list a shared parent once instead of stat-ing every child.
  const originalReaddir = fsp.readdir;
  const originalStat = fsp.stat;
  let cacheListings = 0;
  let cacheStats = 0;
  fsp.readdir = function (target, ...args) {
    if (String(target) === path.join(instance, "config/cache")) cacheListings += 1;
    return originalReaddir.call(this, target, ...args);
  };
  fsp.stat = function (target, ...args) {
    if (String(target).startsWith(path.join(instance, "config/cache/"))) cacheStats += 1;
    return originalStat.call(this, target, ...args);
  };
  try { await syncArchive("s5", cachedOverrides); } finally { fsp.readdir = originalReaddir; fsp.stat = originalStat; }
  assert.equal(cacheListings, 1);
  assert.equal(cacheStats, 0, "normal files use directory types, symlinks still need stat");
  console.log("modpack-grouped-checks-and-bounded-archive-cache=passed");

  // Windows also supports case-sensitive directories: a folded match is not
  // enough to prove the requested path exists. This fixture lives on ext4.
  if (process.platform === "linux") {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const exactPath = path.join(instance, "config/cache/file-0.json");
    const foldedPath = path.join(instance, "config/cache/FILE-0.json");
    await fsp.rename(exactPath, foldedPath);
    await fsp.writeFile(foldedPath, "case-sensitive user file");
    try {
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
      await syncArchive("s5", cachedOverrides);
    } finally { Object.defineProperty(process, "platform", originalPlatform); }
    assert.equal(await read("config/cache/file-0.json"), cachedOverrides["config/cache/file-0.json"], "a differently cased file does not hide a missing default");
    assert.equal(await read("config/cache/FILE-0.json"), "case-sensitive user file", "the other file remains intact");
    console.log("modpack-windows-case-sensitive-directory=passed");
  }

  // A ZIP64 footer takes the same validating yauzl path as a normal archive.
  const normalZip = await fsp.readFile(cachedPass.archivePath);
  const footerAt = normalZip.length - 22;
  assert.equal(normalZip.readUInt32LE(footerAt), 0x06054b50);
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  const entryCount = BigInt(normalZip.readUInt16LE(footerAt + 10));
  zip64.writeBigUInt64LE(entryCount, 24);
  zip64.writeBigUInt64LE(entryCount, 32);
  zip64.writeBigUInt64LE(BigInt(normalZip.readUInt32LE(footerAt + 12)), 40);
  zip64.writeBigUInt64LE(BigInt(normalZip.readUInt32LE(footerAt + 16)), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(footerAt), 8);
  locator.writeUInt32LE(1, 16);
  const footer = Buffer.from(normalZip.subarray(footerAt));
  footer.writeUInt16LE(0xffff, 8);
  footer.writeUInt16LE(0xffff, 10);
  footer.writeUInt32LE(0xffffffff, 12);
  footer.writeUInt32LE(0xffffffff, 16);
  const rawSync = async (zip) => {
    const digest = sha("sha512", zip);
    await fsp.writeFile(path.join(archives, `${digest}.mrpack`), zip);
    return syncModpack({ instanceDir: root, manifest: { ...manifestBase, version: "raw", files: [], mrpack: { url: "https://cdn.test/raw.mrpack", size: zip.length, sha512: digest } } }, quiet, { ...options, fetch: cdnFetch });
  };
  await rawSync(Buffer.concat([normalZip.subarray(0, footerAt), zip64, locator, footer]));
  assert.equal(await read("config/cache/boundary.dat"), cachedOverrides["config/cache/boundary.dat"]);
  console.log("modpack-cached-reader-zip64=passed");

  // A pinned archive can still contain a malformed deflate stream. The entry
  // error must close all streams/handles, leave no temp files and not settle state.
  const badZip = Buffer.from(zipSync({
    "modrinth.index.json": strToU8(JSON.stringify({ formatVersion: 1, dependencies: { minecraft: "26.3", "fabric-loader": "0.19.5" }, files: [] })),
    "overrides/config/corrupt.txt": strToU8("bad compressed content".repeat(100))
  }, { level: 6, mtime: "2026-01-01T00:00:00Z" }));
  let localAt = 0;
  while (badZip.readUInt32LE(localAt) === 0x04034b50) {
    const nameLength = badZip.readUInt16LE(localAt + 26);
    const dataAt = localAt + 30 + nameLength + badZip.readUInt16LE(localAt + 28);
    if (badZip.toString("utf8", localAt + 30, localAt + 30 + nameLength).startsWith("overrides/")) {
      badZip[dataAt] = 0x07; // Reserved deflate block type.
      break;
    }
    localAt = dataAt + badZip.readUInt32LE(localAt + 18);
  }
  const beforeBadZip = await fsp.readFile(statePath, "utf8");
  let badTimeout;
  try {
    await assert.rejects(Promise.race([rawSync(badZip), new Promise((_, reject) => { badTimeout = setTimeout(() => reject(new Error("archive close timed out")), 3000); })]), /invalid block type/);
  } finally { clearTimeout(badTimeout); }
  assert.equal(await fsp.readFile(statePath, "utf8"), beforeBadZip);
  assert.equal(await exists(tempDirPath), false);
  assert.equal(await exists("config/corrupt.txt"), false);
  console.log("modpack-corrupt-entry-stream-cleanup=passed");
  console.log("modpack-unchanged-archive-skipped=passed");
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true });
}
