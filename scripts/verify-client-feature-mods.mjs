import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledFeatureMods, removeStaleLockMod } from "../dist/src/main/client-feature-mods.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientMods = path.join(root, "resources", "client-mods");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-lock-mod-"));
const manifest = (extra = {}) => ({
  schemaVersion: 1,
  id: "vanilla-survival",
  name: "Vanilla",
  version: "1",
  minecraftVersion: "26.3",
  java: { majorVersion: 25, component: "java-runtime-epsilon" },
  loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "127.0.0.1", port: 25565 },
  files: [],
  ...extra
});

async function instanceWith(files) {
  const dir = await fs.mkdtemp(path.join(temp, "instance-"));
  await fs.mkdir(path.join(dir, "mods"));
  for (const [name, source] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, "mods", name), source.startsWith("jar:") ? await fs.readFile(path.join(clientMods, source.slice(4))) : source);
  }
  return dir;
}
const exists = (dir, name) => fs.stat(path.join(dir, "mods", name)).then(() => true, () => false);

try {
  const yggdrasil = manifest({ gameAuth: "yggdrasil" });
  assert.deepEqual(bundledFeatureMods(clientMods, yggdrasil), []);

  // A lock mod the launcher placed earlier is removed once the pack no longer bundles one.
  let dir = await instanceWith({ "bweeep-client.jar": "jar:bweeep-fabric-lock-26.3-0.2.0.jar", "fabric-api.jar": "jar:bweeep-fabric-api-26.3.jar", "sodium.jar": "player mod" });
  assert.equal(await removeStaleLockMod(dir, yggdrasil, []), true);
  assert.equal(await exists(dir, "bweeep-client.jar"), false);
  assert.equal(await exists(dir, "fabric-api.jar"), true, "fabric-api.jar is never removed");
  assert.equal(await exists(dir, "sodium.jar"), true);

  // Every lock mod the launcher ever shipped is recognised.
  for (const jar of ["bweeep-client-1.2.0.jar", "bweeep-fabric-0.2.0.jar", "bweeep-connection-lock-1214-0.1.0.jar"]) {
    dir = await instanceWith({ "bweeep-client.jar": `jar:${jar}` });
    assert.equal(await removeStaleLockMod(dir, yggdrasil, []), true, jar);
  }

  // A file with that name but other contents is not the launcher's and stays.
  dir = await instanceWith({ "bweeep-client.jar": "someone else's jar" });
  assert.equal(await removeStaleLockMod(dir, yggdrasil, []), false);
  assert.equal(await exists(dir, "bweeep-client.jar"), true);

  // Nothing is removed while the pack still bundles a lock mod or ships that path itself.
  const offline = manifest();
  dir = await instanceWith({ "bweeep-client.jar": "jar:bweeep-fabric-lock-26.3-0.2.0.jar" });
  assert.equal(await removeStaleLockMod(dir, offline, bundledFeatureMods(clientMods, offline)), false);
  assert.equal(await exists(dir, "bweeep-client.jar"), true);
  const shipsIt = manifest({ gameAuth: "yggdrasil", files: [{ path: "mods/bweeep-client.jar", size: 1, sha256: "0".repeat(64), url: "https://example.invalid/x.jar" }] });
  assert.equal(await removeStaleLockMod(dir, shipsIt, []), false);
  assert.equal(await exists(dir, "bweeep-client.jar"), true);

  // No mods folder or no file: nothing to do.
  assert.equal(await removeStaleLockMod(path.join(temp, "missing"), yggdrasil, []), false);
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log("stale-lock-mod-cleanup=passed");
