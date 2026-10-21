// Offline fixtures for runtime checksum reuse, launch corruption checks, and
// independent Java / Minecraft preparation. Never touches the real game profile.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { LaunchPrecheck, MinecraftFolder, Version } from "@xmcl/core";
import { createNodeInstallRuntime } from "@xmcl/installer";

const dist = path.resolve(process.env.BWEEP_TEST_DIST ?? "dist");
const { HashCache } = await import(pathToFileURL(path.join(dist, "src/main/hash-cache.js")));
const { cachedLaunchPrechecks, prepareGameFiles, installAndLaunch } = await import(pathToFileURL(path.join(dist, "src/main/minecraft-runtime.js")));
const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bweeep-runtime-preparation-"));
const digest = (bytes, algorithm = "sha1") => crypto.createHash(algorithm).update(bytes).digest("hex");
const originalReadStream = fs.createReadStream;
let reads = 0;
fs.createReadStream = (...args) => { reads += 1; return originalReadStream(...args); };

try {
  const file = path.join(root, "library.jar");
  const cachePath = path.join(root, "hashes.json");
  await fsp.writeFile(file, "good");
  let cache = await HashCache.load(cachePath);
  assert.equal(await cache.checksum("library.jar", file, "sha1"), digest("good"));
  assert.equal(reads, 1);
  assert.equal(await cache.checksum("library.jar", file, "sha1"), digest("good"));
  assert.equal(reads, 1, "an exact unchanged file is not read a second time");
  await cache.save();
  cache = await HashCache.load(cachePath);
  assert.equal(await cache.checksum("library.jar", file, "sha1"), digest("good"));
  assert.equal(reads, 1, "the exact checksum cache survives a launcher restart");

  // Force equal cached mtime/size but stale ctime: content changes are still read.
  const old = JSON.parse(await fsp.readFile(cachePath, "utf8"));
  await fsp.writeFile(file, "evil");
  const changed = await fsp.stat(file);
  old["library.jar"].mtimeMs = changed.mtimeMs;
  old["library.jar"].ctimeMs = changed.ctimeMs - 10;
  await fsp.writeFile(cachePath, JSON.stringify(old));
  cache = await HashCache.load(cachePath);
  assert.equal(await cache.checksum("library.jar", file, "sha1"), digest("evil"));
  assert.equal(reads, 2, "ctime invalidates same-size, equal-mtime cached content");
  assert.equal(await cache.checksum("library.jar", file, "sha256"), digest("evil", "sha256"));
  assert.equal(reads, 3, "a digest for a different algorithm cannot be reused");
  await cache.save();
  const legacy = JSON.parse(await fsp.readFile(cachePath, "utf8"));
  delete legacy["library.jar"].ctimeMs;
  await fsp.writeFile(cachePath, JSON.stringify(legacy));
  cache = await HashCache.load(cachePath);
  await cache.checksum("library.jar", file, "sha256");
  assert.equal(reads, 4, "legacy stamps without ctime are verified once");
  assert.equal(await cache.checksum("missing", path.join(root, "missing"), "sha1"), null);
  assert.equal(await cache.checksum("directory", root, "sha1"), null);
  console.log("runtime-checksum-cache=passed");

  const instance = path.join(root, "instance");
  const folder = MinecraftFolder.from(instance);
  const version = { minecraftVersion: "1.20.1", downloads: { client: { sha1: digest("client") } }, libraries: [
    { name: "fixture:library:1", download: { path: "fixture/library/1/library-1.jar", sha1: digest("library") } }
  ] };
  const clientPath = folder.getVersionJar(version.minecraftVersion);
  const libraryPath = folder.getLibraryByPath(version.libraries[0].download.path);
  for (const [target, content] of [[clientPath, "client"], [libraryPath, "library"]]) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  cache = await HashCache.load(path.join(instance, "hashes.json"));
  const checks = cachedLaunchPrechecks(instance, cache);
  assert.equal(checks[2], LaunchPrecheck.checkNatives, "native validation/extraction is retained");
  assert.equal(checks[3], LaunchPrecheck.linkAssets, "legacy asset linking is retained");
  for (const check of checks.slice(0, 2)) await check(folder, version, {});
  const afterFirstChecks = reads;
  for (const check of checks.slice(0, 2)) await check(folder, version, {});
  assert.equal(reads, afterFirstChecks, "launch checks reuse verified installer digests");
  version.downloads.client.sha1 = digest("another client");
  await assert.rejects(checks[0](folder, version, {}), { error: "CorruptedVersionJar", version: "1.20.1" });
  version.downloads.client.sha1 = digest("client");
  await fsp.writeFile(libraryPath, "corrupt");
  await assert.rejects(checks[1](folder, version, {}), (error) => error.error === "MissingLibraries" && error.libraries[0] === version.libraries[0] && error.version === version);
  await fsp.rm(clientPath);
  await assert.rejects(checks[0](folder, version, {}), { error: "CorruptedVersionJar" });
  await fsp.rm(libraryPath);
  version.libraries[0].download.sha1 = "";
  await assert.rejects(checks[1](folder, version, {}), { error: "MissingLibraries" });
  console.log("runtime-launch-integrity=passed");

  // Linux fixture: a deliberately slow Java probe, with a complete tiny base.
  // Base completion must be observable before that probe completes.
  if (process.platform !== "win32") {
    const javaPath = path.join(instance, ".bweeep/runtime/bin/java");
    await fsp.mkdir(path.dirname(javaPath), { recursive: true });
    await fsp.writeFile(javaPath, '#!/bin/sh\nsleep 0.3\necho \'openjdk version "17.0.1"\' >&2\n', { mode: 0o755 });
    const jar = Buffer.from(zipSync({ "fixture.txt": Buffer.from("client") }));
    const index = Buffer.from(JSON.stringify({ objects: {} }));
    await fsp.writeFile(clientPath, jar);
    const indexPath = folder.getAssetsIndex("fixture-assets");
    await fsp.mkdir(path.dirname(indexPath), { recursive: true });
    await fsp.writeFile(indexPath, index);
    const rawVersion = { id: "1.20.1", type: "release", mainClass: "fixture.Main", arguments: { game: [], jvm: [] }, libraries: [], assets: "fixture-assets",
      assetIndex: { id: "fixture-assets", sha1: digest(index), size: index.length, url: "https://example.invalid/index" },
      downloads: { client: { sha1: digest(jar), size: jar.length, url: "https://example.invalid/client" } },
      javaVersion: { majorVersion: 17, component: "fixture" }, minimumLauncherVersion: 21, time: "2026-01-01T00:00:00Z", releaseTime: "2026-01-01T00:00:00Z" };
    await fsp.writeFile(folder.getVersionJson("1.20.1"), JSON.stringify(rawVersion));
    await fsp.writeFile(path.join(instance, ".bweeep/installed-versions.json"), JSON.stringify({ "minecraft:1.20.1": "1.20.1" }));
    const events = [];
    const prepared = await prepareGameFiles({ minecraftVersion: "1.20.1", java: { majorVersion: 17, component: "fixture" }, loader: { kind: "vanilla", version: "" } }, instance, (event) => events.push(event));
    assert.equal(prepared.version, "1.20.1");
    assert.equal(prepared.javaPath, javaPath);
    const completed = events.filter((event) => event.message === "완료").map((event) => event.stage);
    assert.ok(completed.indexOf("Minecraft 기본 파일") >= 0);
    assert.ok(completed.indexOf("Minecraft 기본 파일") < completed.indexOf("Java 런타임"), "the independent base preparation runs during the Java probe");
    assert.ok(events.some((event) => event.stage === "게임 리소스" && event.message === "0개 준비"), "empty asset sets complete without a fabricated percentage");
    const afterPrepare = reads;
    const parsed = await Version.parse(folder, "1.20.1");
    for (const check of cachedLaunchPrechecks(instance, prepared.runtimeHashes).slice(0, 2)) await check(folder, parsed, {});
    assert.equal(reads, afterPrepare, "the final launch precheck reuses the installer's actual verified JAR digest");
    await prepareGameFiles({ minecraftVersion: "1.20.1", java: { majorVersion: 17, component: "fixture" }, loader: { kind: "vanilla", version: "" } }, instance, () => {});
    assert.equal(reads, afterPrepare, "a later preparation reuses the persisted exact runtime digest");
    console.log("runtime-independent-preparation=passed");

    const manifest = { minecraftVersion: "1.20.1", java: { majorVersion: 17, component: "fixture" }, loader: { kind: "vanilla", version: "" }, server: { host: "example.invalid", port: 25565 }, files: [] };
    const originalSave = HashCache.prototype.save;
    let cacheSaveFailures = 0;
    HashCache.prototype.save = async function () {
      cacheSaveFailures += 1;
      throw Object.assign(new Error("fixture cache disk is full"), { code: "ENOSPC" });
    };
    try {
      const withoutWritableCache = await prepareGameFiles(manifest, instance, () => {});
      assert.equal(withoutWritableCache.version, "1.20.1", "a performance-cache write failure does not fail valid preparation");
      let reportExit;
      const exited = new Promise((resolve) => { reportExit = resolve; });
      const launched = await installAndLaunch(manifest, instance, async () => ({ identity: { id: "00000000000000000000000000000001", name: "fixture", accessToken: "fixture-token" }, ticket: "" }), [], () => {}, reportExit, [], undefined, Promise.resolve(withoutWritableCache));
      assert.ok(launched.pid > 0, "a successful child spawn is returned despite the cache write failing");
      let exitTimeout;
      try {
        await Promise.race([exited, new Promise((_, reject) => { exitTimeout = setTimeout(() => reject(new Error("fixture child exit observer was not attached")), 3000); })]);
      } finally { clearTimeout(exitTimeout); }
      assert.ok(cacheSaveFailures >= 2, "both preparation and post-spawn cache writes were exercised");
      const authorizationFailure = new Error("fixture authorization failed");
      await assert.rejects(installAndLaunch(manifest, instance, async () => { throw authorizationFailure; }, [], () => {}, () => {}, [], undefined, Promise.resolve(withoutWritableCache)), (error) => error === authorizationFailure, "real launch failures still propagate unchanged");
    } finally { HashCache.prototype.save = originalSave; }
    console.log("runtime-cache-write-failure-keeps-spawn-tracked=passed");
  }
} finally {
  fs.createReadStream = originalReadStream;
  await fsp.rm(root, { recursive: true, force: true });
}
