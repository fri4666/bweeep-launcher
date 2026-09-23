import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledFeatureMods } from "../dist/src/main/client-feature-mods.js";
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
    fs.writeFile(path.join(personalMods, "shader-helper.jar"), "personal-ok"),
    fs.writeFile(path.join(instance, "mods", "required.jar"), "server-owned")
  ]);

  const result = await prepareUserContent(root, instance, manifest);
  assert.equal(await fs.readFile(path.join(instance, "mods", "required.jar"), "utf8"), "personal-conflict");
  assert.equal(await fs.readFile(path.join(instance, "mods", "shader-helper.jar"), "utf8"), "personal-ok");
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
  assert.throws(() => bundledFeatureMods("/resources", {
    ...manifest,
    loader: { kind: "forge", version: "47.3.0" },
    clientFeatures: { connectionLock: true }
  }));
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "fabric", version: "0.19.5" },
    clientFeatures: { connectionLock: true }
  }).length, 1);
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "1.21.4",
    loader: { kind: "fabric", version: "0.18.1" },
    clientFeatures: { connectionLock: true }
  }).length, 1);
  const tycoonLockJar = await fs.readFile(new URL("../resources/client-mods/bweeep-connection-lock-1214-0.1.0.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(tycoonLockJar).digest("hex"),
    "bf0ffad350cc2f6df055d899a73cf956d943be97a911659543c01f304ff07876"
  );
  const fabricLockJar = await fs.readFile(new URL("../resources/client-mods/bweeep-fabric-lock-26.3-0.1.0.jar", import.meta.url));
  assert.equal(
    crypto.createHash("sha256").update(fabricLockJar).digest("hex"),
    "5fe104672975a1f42d7640fd9508235c6e83c779585b4bd84037df9179354f5a"
  );
  assert.throws(() => bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "fabric", version: "0.19.4" },
    clientFeatures: { connectionLock: true }
  }));
  assert.equal(bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "vanilla", version: "none" },
    clientFeatures: { connectionLock: false }
  }).length, 0);
  assert.throws(() => bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "vanilla", version: "none" },
    clientFeatures: { connectionLock: true }
  }));
  console.log("personal-content-and-connection-lock-regressions=passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
