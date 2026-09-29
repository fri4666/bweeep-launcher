import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledFeatureMods, verifyRemoteConnectionLock } from "../dist/src/main/client-feature-mods.js";
import { connectionGuardEnabled, connectionGuardJvmArgs } from "../dist/src/main/connection-guard.js";
import { writeModJar } from "./lib/test-jars.mjs";
import { assertManifest } from "../dist/src/main/manifest-validation.js";
import { syncModpack } from "../dist/src/main/sync.js";
import { captureSharedOptions, prepareUserContent } from "../dist/src/main/user-content.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-user-content-"));
try {
  const manifest = {
    schemaVersion: 1,
    id: "pack",
    name: "Pack",
    version: "test",
    minecraftVersion: "1.21.1",
    java: { majorVersion: 21, component: "java-runtime-delta" },
    loader: { kind: "neoforge", version: "21.1.228" },
    server: { host: "example.test", port: 25565 },
    files: [{ path: "mods/required.jar", size: 0, sha256: "0".repeat(64), url: "https://example.test/required.jar" }]
  };
  const personalMods = path.join(root, ".bweeep-user-content", "mods", "neoforge-1.21.1");
  const instance = path.join(root, "pack");
  await fs.mkdir(personalMods, { recursive: true });
  await fs.mkdir(path.join(instance, "mods"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(personalMods, "required.jar"), "personal-conflict"),
    writeModJar(path.join(personalMods, "shader-helper.jar"), "neoforge", "shader_helper"),
    fs.writeFile(path.join(instance, "mods", "required.jar"), "server-owned")
  ]);

  const result = await prepareUserContent(root, instance, manifest);
  // A personal jar never overwrites the server's own file of the same name.
  assert.equal(await fs.readFile(path.join(instance, "mods", "required.jar"), "utf8"), "server-owned");
  assert.equal(result.skippedMods.find((mod) => mod.name === "required.jar")?.reason, "서버 팩에 같은 이름의 파일이 있어요");
  assert.deepEqual(await fs.readFile(path.join(instance, "mods", "shader-helper.jar")), await fs.readFile(path.join(personalMods, "shader-helper.jar")));
  await Promise.all([
    fs.writeFile(path.join(instance, "options.txt"), "sensitivity:0.42\nkey_key.jump:key.keyboard.space"),
    fs.writeFile(path.join(instance, "optionsof.txt"), "ofFastRender:true")
  ]);
  await captureSharedOptions(root, instance);
  const switchedInstance = path.join(root, "switched-pack");
  await fs.mkdir(switchedInstance, { recursive: true });
  await prepareUserContent(root, switchedInstance, { ...manifest, id: "switched-pack" });
  assert.equal(await fs.readFile(path.join(switchedInstance, "options.txt"), "utf8"), "sensitivity:0.42\nkey_key.jump:key.keyboard.space");
  assert.equal(await fs.readFile(path.join(switchedInstance, "optionsof.txt"), "utf8"), "ofFastRender:true");
  assert.equal(bundledFeatureMods("/resources", { ...manifest, clientFeatures: { connectionLock: true } }).length, 2);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    loader: { kind: "fabric", version: "0.16.10" },
    clientFeatures: { connectionLock: true }
  }).length, 1);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    loader: { kind: "forge", version: "47.3.0" },
    clientFeatures: { connectionLock: false }
  }).length, 0);
  // Versions without a lock mod are covered by the connection guard agent instead of refusing to launch.
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    loader: { kind: "forge", version: "47.3.0" },
    clientFeatures: { connectionLock: true }
  }).length, 0);
  // Servers on the Bweeep Yggdrasil API need none of the version-specific mods.
  assert.equal(bundledFeatureMods("/resources", { ...manifest, gameAuth: "yggdrasil", clientFeatures: { connectionLock: true } }).length, 0);
  assert.equal(connectionGuardEnabled(manifest), true);
  assert.equal(connectionGuardEnabled({ ...manifest, clientFeatures: { connectionLock: false } }), false);
  assert.deepEqual(connectionGuardJvmArgs("/agent.jar", manifest), ["-javaagent:/agent.jar", "-Dbweeep.targetServer=example.test:25565", "-Dbweeep.exitOnLeave=true"]);
  const guardJar = await fs.readFile(new URL("../resources/java-agent/bweeep-guard-1.1.0.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(guardJar).digest("hex"),
    "57a2d566a946b86738d884c783795455ca52d5f9021c351adfe65341c30b55af"
  );
  const lockContents = Buffer.from("test remote bridge");
  const lockHash = crypto.createHash("sha256").update(lockContents).digest("hex");
  const remoteLockManifest = {
    ...manifest,
    minecraftVersion: "1.20.1",
    java: { majorVersion: 17, component: "java-runtime-gamma" },
    loader: { kind: "forge", version: "47.4.0" },
    files: [{ path: "mods/bweeep-connection-lock.jar", size: lockContents.length, sha256: lockHash, url: "https://example.test/bridge.jar" }],
    clientFeatures: { connectionLock: { protocolVersion: 1, path: "mods/bweeep-connection-lock.jar", sha256: lockHash, minecraftVersion: "1.20.1", loaderKind: "forge" } }
  };
  assertManifest(remoteLockManifest);
  assert.equal(bundledFeatureMods("/resources", remoteLockManifest).length, 0);
  assert.throws(() => assertManifest({ ...remoteLockManifest, files: [] }));
  const remoteInstance = path.join(root, "remote-bridge");
  await fs.mkdir(path.join(remoteInstance, "mods"), { recursive: true });
  const remoteJar = path.join(remoteInstance, "mods", "bweeep-connection-lock.jar");
  await fs.writeFile(remoteJar, lockContents);
  await verifyRemoteConnectionLock(remoteInstance, remoteLockManifest);
  await fs.writeFile(remoteJar, "personal replacement");
  await assert.rejects(() => verifyRemoteConnectionLock(remoteInstance, remoteLockManifest));
  const fabric263Mods = bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "fabric", version: "0.19.5" },
    clientFeatures: { connectionLock: true }
  });
  assert.equal(fabric263Mods.length, 2);
  assert.deepEqual(fabric263Mods.map((mod) => mod.targetName).sort(), ["bweeep-client.jar", "fabric-api.jar"]);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "1.21.4",
    loader: { kind: "fabric", version: "0.18.1" },
    clientFeatures: { connectionLock: true }
  }).length, 1);
  const tycoonManifestWithoutFeatureFlag = {
    ...manifest,
    minecraftVersion: "1.21.4",
    loader: { kind: "fabric", version: "0.18.1" }
  };
  assert.equal(bundledFeatureMods("/resources", tycoonManifestWithoutFeatureFlag).length, 1);
  assert.equal(bundledFeatureMods("/resources", {
    ...tycoonManifestWithoutFeatureFlag,
    clientFeatures: { connectionLock: false }
  }).length, 0);
  assert.equal(bundledFeatureMods("/resources", {
    ...tycoonManifestWithoutFeatureFlag,
    loader: { kind: "fabric", version: "0.18.2" }
  }).length, 0);
  const tycoonLockJar = await fs.readFile(new URL("../resources/client-mods/bweeep-connection-lock-1214-0.1.0.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(tycoonLockJar).digest("hex"),
    "60505e9e418f8c3c9ea60ac3124412b703e3642e22a083f3ef8a968156ee6c69"
  );
  const fabricLockJar = await fs.readFile(new URL("../resources/client-mods/bweeep-fabric-lock-26.3-0.2.0.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(fabricLockJar).digest("hex"),
    "27ed412e5bd1fb6d3b407776e9bd6c24c6297051a2862298289c51be1f98c472"
  );
  const fabricApiJar = await fs.readFile(new URL("../resources/client-mods/bweeep-fabric-api-26.3.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(fabricApiJar).digest("hex"),
    "86f16178a3cecc887a85a4cfe9a79d92fa7341d8f39b5951a4d6ad800ab657a6"
  );
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "fabric", version: "0.19.4" },
    clientFeatures: { connectionLock: true }
  }).length, 0);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "vanilla", version: "none" },
    clientFeatures: { connectionLock: false }
  }).length, 0);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "vanilla", version: "none" },
    clientFeatures: { connectionLock: true }
  }).length, 0);
  const versionRoot = path.join(root, "server-version");
  const instanceRoot = path.join(versionRoot, "instances");
  const higherPackFile = path.join(versionRoot, "pack-high.jar");
  const lowerPackFile = path.join(versionRoot, "pack-low.jar");
  await fs.mkdir(versionRoot, { recursive: true });
  await Promise.all([fs.writeFile(higherPackFile, "server-pack-version-10"), fs.writeFile(lowerPackFile, "server-pack-version-2")]);
  const makeVersionManifest = (version, file) => {
    const contents = version === "10.0" ? "server-pack-version-10" : "server-pack-version-2";
    return {
      schemaVersion: 1, id: "versioned-pack", name: "Versioned Pack", version,
      minecraftVersion: "1.20.1", java: { majorVersion: 17, component: "java-runtime-gamma" },
      loader: { kind: "forge", version: "47.4.0" }, server: { host: "example.test", port: 25565 },
      files: [{ path: "mods/managed.jar", size: Buffer.byteLength(contents), sha256: crypto.createHash("sha256").update(contents).digest("hex"), url: pathToFileURL(file).href }]
    };
  };
  const reportProgress = () => {};
  const higherManifest = makeVersionManifest("10.0", higherPackFile);
  const initialSync = await syncModpack({ instanceDir: instanceRoot, manifest: higherManifest }, reportProgress);
  assert.equal(initialSync.downloaded, 1);
  const managedPackPath = path.join(initialSync.instanceDir, "mods", "managed.jar");
  assert.equal(await fs.readFile(managedPackPath, "utf8"), "server-pack-version-10");

  const lowerManifest = makeVersionManifest("2.0", lowerPackFile);
  const downgradeSync = await syncModpack({ instanceDir: instanceRoot, manifest: lowerManifest }, reportProgress);
  assert.equal(downgradeSync.downloaded, 1, "a lower server manifest version must replace the newer local managed file");
  assert.equal(await fs.readFile(managedPackPath, "utf8"), "server-pack-version-2");
  assert.equal(JSON.parse(await fs.readFile(path.join(downgradeSync.instanceDir, "bweeep-manifest.json"), "utf8")).version, "2.0");

  const upgradeSync = await syncModpack({ instanceDir: instanceRoot, manifest: higherManifest }, reportProgress);
  assert.equal(upgradeSync.downloaded, 1, "a higher server manifest version must replace the lower local managed file");
  assert.equal(await fs.readFile(managedPackPath, "utf8"), "server-pack-version-10");
  console.log("server-manifest-version-upgrade-and-downgrade=passed");
  console.log("personal-content-and-connection-lock-regressions=passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
