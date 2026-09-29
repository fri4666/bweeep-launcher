// Modpack sync against a local HTTP server: files already on disk are kept
// across pack versions, downloads run in parallel, retry, resume a partial
// file, stop early when the disk is full, and pack config files the player
// edited are never overwritten.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { syncModpack } from "../dist/src/main/sync.js";

// Under ~/.cache rather than /tmp, which is memory-backed on the dev machine.
await fsp.mkdir(path.join(homedir(), ".cache"), { recursive: true });
const root = await fsp.mkdtemp(path.join(homedir(), ".cache", "bweeep-sync-check-"));
const sha = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
const quiet = () => undefined;

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
    const zip = Buffer.from(zipSync(entries));
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
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true });
}
