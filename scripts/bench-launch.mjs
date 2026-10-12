// Launch-time benchmark on a simulated network (a developer tool, not part of CI).
//
//   node scripts/bench-launch.mjs [--bandwidth 12] [--latency 60] [--only first,again,update,overlap]
//
// A local server stands in for the CDNs: every request waits `latency` ms before
// the first byte, and all responses share one `bandwidth` MB/s line. The pack
// is shaped like the Cobblemon pack: a ~100 MB mrpack (about 2,300 override
// files, three of them big), 77 mods, plus 3,600 small game files (assets).
// It runs the launcher's real sync and download code from dist/, so build first.
// Numbers are for this machine and this fake line only, not for a player's PC.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { homedir } from "node:os";
import { strToU8, zipSync } from "fflate";
import { syncModpack } from "../dist/src/main/sync.js";
import { downloadInstallFilesWithSystemNetwork } from "../dist/src/main/system-network.js";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const BANDWIDTH = Number(argument("bandwidth", "12")) * 1024 * 1024;
const LATENCY = Number(argument("latency", "60"));
const only = new Set(argument("only", "first,again,update,overlap").split(","));
const sha = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");

await fsp.mkdir(path.join(homedir(), ".cache"), { recursive: true });
const root = await fsp.mkdtemp(path.join(homedir(), ".cache", "bweeep-bench-"));

// --- A shared line: all responses draw from one byte budget -----------------
let sentBytes = 0;
let lineStart = Date.now();
const lineWait = async () => {
  const ahead = sentBytes / BANDWIDTH * 1000 - (Date.now() - lineStart);
  if (ahead > 5) await new Promise((resolve) => setTimeout(resolve, ahead));
};
const bodies = new Map();
const served = { requests: 0, bytes: 0 };
const server = http.createServer(async (request, response) => {
  const name = decodeURIComponent(new URL(request.url, "http://x").pathname.slice(1));
  const body = bodies.get(name);
  served.requests += 1;
  await new Promise((resolve) => setTimeout(resolve, LATENCY));
  if (!body) return response.writeHead(404).end();
  response.writeHead(200, { "content-length": body.length });
  for (let offset = 0; offset < body.length; offset += 256 * 1024) {
    const chunk = body.subarray(offset, offset + 256 * 1024);
    sentBytes += chunk.length;
    served.bytes += chunk.length;
    await lineWait();
    if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
  }
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// The launcher only accepts https addresses; the fetcher maps the fake host to the local server.
const fetcher = (url, init) => fetch(url.replace("https://cdn.bench.test", base).replace("https://assets.bench.test", base), init);

// --- The pack ----------------------------------------------------------------
const random = (size) => crypto.randomBytes(size);
const mods = Array.from({ length: 77 }, (_, index) => ({ name: `mod-${index}.jar`, bytes: random(index % 7 === 0 ? 4 * 1024 * 1024 : 400 * 1024 + index * 1000) }));
const overrides = {};
for (let index = 0; index < 2300; index += 1) overrides[`overrides/config/c${index % 40}/file-${index}.json`] = [strToU8(JSON.stringify({ index, pad: "x".repeat(2000 + (index % 900)) })), { level: 0 }];
for (let index = 0; index < 3; index += 1) overrides[`overrides/saves/tutorial/region/r.${index}.mca`] = [random(32 * 1024 * 1024), { level: 0 }];
overrides["overrides/options.txt"] = [strToU8("version:3955\nmouseSensitivity:0.5\n"), { level: 0 }];

function buildPack(modList, tag) {
  const index = {
    formatVersion: 1, game: "minecraft", versionId: tag, name: "Bench Pack",
    dependencies: { minecraft: "1.21.1", "fabric-loader": "0.19.5" },
    files: modList.map((mod) => {
      bodies.set(mod.name, mod.bytes);
      return { path: `mods/${mod.name}`, hashes: { sha512: sha("sha512", mod.bytes) }, downloads: [`https://cdn.bench.test/${encodeURIComponent(mod.name)}`], fileSize: mod.bytes.length };
    })
  };
  const archive = Buffer.from(zipSync({ "modrinth.index.json": [strToU8(JSON.stringify(index)), { level: 0 }], ...overrides }));
  bodies.set(`pack-${tag}.mrpack`, archive);
  return { url: `https://cdn.bench.test/pack-${tag}.mrpack`, size: archive.length, sha512: sha("sha512", archive) };
}
const manifestFor = (mrpack, version) => ({
  schemaVersion: 1, id: "bench-pack", name: "Bench", version, minecraftVersion: "1.21.1",
  java: { majorVersion: 21, component: "java-runtime-delta" }, loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "example.invalid", port: 25565 }, gameAuth: "yggdrasil", files: [], mrpack
});

// --- Game files: thousands of small objects -----------------------------------
const gameFiles = Array.from({ length: 3600 }, (_, index) => {
  const bytes = random(2000 + (index % 5) * 3000);
  const name = `asset-${index}.bin`;
  bodies.set(name, bytes);
  return { path: path.join(root, "game", "assets", name), urls: [`https://assets.bench.test/${name}`], size: bytes.length, checksum: { algorithm: "sha1", value: sha("sha1", bytes) } };
});

const sync = (mrpack, version, dir = "inst") => syncModpack({ instanceDir: path.join(root, dir), manifest: manifestFor(mrpack, version) }, () => undefined, { fetch: fetcher });
const resetLine = () => { sentBytes = 0; lineStart = Date.now(); served.requests = 0; served.bytes = 0; };
const timed = async (label, work) => {
  resetLine();
  const started = performance.now();
  const result = await work();
  const seconds = (performance.now() - started) / 1000;
  const mb = served.bytes / 1048576;
  console.log(`${label.padEnd(40)} ${seconds.toFixed(2).padStart(7)} s   (${served.requests} requests, ${mb.toFixed(0)} MB sent)`);
  return { seconds, result };
};

console.log(`line: ${BANDWIDTH / 1048576} MB/s shared, ${LATENCY} ms before the first byte; pack ${mods.length} mods, ${Object.keys(overrides).length} overrides`);
const results = {};
try {
  const v1 = buildPack(mods, "v1");
  console.log(`mrpack ${(v1.size / 1048576).toFixed(0)} MB, mods ${(mods.reduce((sum, mod) => sum + mod.bytes.length, 0) / 1048576).toFixed(0)} MB, game files ${gameFiles.length}`);

  if (only.has("first")) {
    results.firstSync = (await timed("first install: modpack sync only", () => sync(v1, "1", "first"))).seconds;
    results.firstGameFiles = (await timed("first install: game files only", () => downloadInstallFilesWithSystemNetwork(gameFiles, undefined, fetcher))).seconds;
    await fsp.rm(path.join(root, "game"), { recursive: true, force: true });
    results.firstSequential = results.firstSync + results.firstGameFiles;
    console.log(`  -> one after the other: ${results.firstSequential.toFixed(2)} s`);
  }
  if (only.has("overlap")) {
    await fsp.rm(path.join(root, "overlap"), { recursive: true, force: true });
    results.firstOverlapped = (await timed("first install: sync + game files together", () => Promise.all([
      sync(v1, "1", "overlap"),
      downloadInstallFilesWithSystemNetwork(gameFiles, undefined, fetcher)
    ]))).seconds;
    await fsp.rm(path.join(root, "game"), { recursive: true, force: true });
  }
  if (only.has("again")) {
    await sync(v1, "1", "again");
    const runs = [];
    for (let run = 0; run < 3; run += 1) runs.push((await timed(`unchanged launch #${run + 1}`, () => sync(v1, "1", "again"))).seconds);
    results.unchangedLaunch = Math.min(...runs);
    assert.ok(true);
  }
  if (only.has("update")) {
    await sync(v1, "1", "update");
    const changed = mods.map((mod, index) => (index < 4 ? { name: mod.name, bytes: random(mod.bytes.length) } : mod));
    const v2 = buildPack(changed, "v2");
    results.updateLaunch = (await timed("pack update (4 mods changed)", () => sync(v2, "2", "update"))).seconds;
    results.afterUpdateLaunch = (await timed("launch right after the update", () => sync(v2, "2", "update"))).seconds;
  }
  console.log("\nsummary " + JSON.stringify(Object.fromEntries(Object.entries(results).map(([key, value]) => [key, Number(value.toFixed(2))]))));
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true });
}
