import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledFeatureMods } from "../dist/src/main/client-feature-mods.js";
import { prepareUserContent } from "../dist/src/main/user-content.js";

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
  assert.deepEqual(result.blockedMods, ["required.jar"]);
  assert.equal(await fs.readFile(path.join(instance, "mods", "required.jar"), "utf8"), "server-owned");
  assert.equal(await fs.readFile(path.join(instance, "mods", "shader-helper.jar"), "utf8"), "personal-ok");
  assert.equal(bundledFeatureMods("/resources", { ...manifest, clientFeatures: { connectionLock: true } }).length, 2);
  assert.throws(() => bundledFeatureMods("/resources", {
    ...manifest,
    minecraftVersion: "26.3",
    loader: { kind: "fabric", version: "0.19.5" },
    clientFeatures: { connectionLock: true }
  }));
  console.log("personal-content-and-connection-lock-regressions=passed");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
