// Shader packs and shader settings follow the player from server to server:
// one shared zip folder, the chosen pack and its options shared like options.txt,
// the newer unshared change wins over the shared copy, a pack's own defaults never do.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { captureSharedOptions, prepareUserContent, sharedContentFolder } from "../dist/src/main/user-content.js";

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-shader-settings-"));
const fabric = { loader: { kind: "fabric" }, minecraftVersion: "1.21.1", files: [] };
const forge = { loader: { kind: "forge" }, minecraftVersion: "1.20.1", files: [] };
const read = (file) => fsp.readFile(file, "utf8");
const exists = (file) => fsp.stat(file).then(() => true, () => false);
const write = async (file, text, time) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
  if (time) await fsp.utimes(file, time, time);
};
// Later than anything the steps above wrote, so each edit is strictly newer than the last.
const later = (seconds) => new Date(Date.now() + seconds * 1000);

try {
  const instanceA = path.join(root, "a");
  const instanceB = path.join(root, "b");
  await Promise.all([fsp.mkdir(instanceA), fsp.mkdir(instanceB)]);

  // --- First launch, nothing shared yet: works and leaves nothing behind --------
  const first = await prepareUserContent(root, instanceA, fabric);
  assert.equal(first.copiedShaders, 0);
  assert.ok(!(await exists(path.join(instanceA, "config", "iris.properties"))), "nothing shared, nothing restored");

  // --- The shared folder: opened from the launcher, one for every loader --------
  const shared = await sharedContentFolder(root, "shaderpacks");
  assert.equal(shared, path.join(root, ".bweeep-user-content", "shaderpacks"));
  await assert.rejects(sharedContentFolder(root, "mods"));
  await write(path.join(shared, "Complementary.zip"), "complementary");

  // --- Server A: the zip arrives, the player picks it and tunes it ---------------
  await prepareUserContent(root, instanceA, fabric);
  assert.equal(await read(path.join(instanceA, "shaderpacks", "Complementary.zip")), "complementary");
  await write(path.join(instanceA, "config", "iris.properties"), "shaderPack=Complementary.zip\nenableShaders=true\n");
  await write(path.join(instanceA, "shaderpacks", "Complementary.zip.txt"), "shadowQuality=3\n");
  await write(path.join(instanceA, "optionsshaders.txt"), "shaderPack=Complementary.zip\n");
  await captureSharedOptions(root, instanceA);

  // --- Server B (another loader and version) starts with the same setup ----------
  const forgeStatus = await prepareUserContent(root, instanceB, forge);
  assert.equal(forgeStatus.copiedShaders, 1, "the zip is there on the other loader too");
  assert.equal(await read(path.join(instanceB, "shaderpacks", "Complementary.zip")), "complementary");
  assert.equal(await read(path.join(instanceB, "config", "iris.properties")), "shaderPack=Complementary.zip\nenableShaders=true\n");
  assert.equal(await read(path.join(instanceB, "shaderpacks", "Complementary.zip.txt")), "shadowQuality=3\n");
  assert.equal(await read(path.join(instanceB, "optionsshaders.txt")), "shaderPack=Complementary.zip\n");

  // --- A change made on B reaches A, including Oculus' own file -------------------
  await write(path.join(instanceB, "shaderpacks", "Complementary.zip.txt"), "shadowQuality=5\n");
  await write(path.join(instanceB, "config", "oculus.properties"), "shaderPack=Complementary.zip\n");
  await captureSharedOptions(root, instanceB);
  await prepareUserContent(root, instanceA, fabric);
  assert.equal(await read(path.join(instanceA, "shaderpacks", "Complementary.zip.txt")), "shadowQuality=5\n");
  assert.equal(await read(path.join(instanceA, "config", "oculus.properties")), "shaderPack=Complementary.zip\n", "harmless on a loader without Oculus");

  // --- A change the last session never shared is kept, not overwritten -----------
  const store = path.join(root, ".bweeep-user-content", "settings", "shaders");
  await write(path.join(store, "config", "iris.properties"), "shaderPack=Old.zip\n", later(100));
  await write(path.join(instanceA, "config", "iris.properties"), "shaderPack=Unsaved.zip\n", later(200));
  await prepareUserContent(root, instanceA, fabric);
  assert.equal(await read(path.join(instanceA, "config", "iris.properties")), "shaderPack=Unsaved.zip\n", "newer unshared change survives the launch");
  assert.equal(await read(path.join(store, "config", "iris.properties")), "shaderPack=Unsaved.zip\n", "and is shared from then on");
  await prepareUserContent(root, instanceB, forge);
  assert.equal(await read(path.join(instanceB, "config", "iris.properties")), "shaderPack=Unsaved.zip\n");

  // --- A file the pack's own defaults wrote never beats the player's choice ------
  const packInstance = path.join(root, "pack");
  const packDefault = "shaderPack=PackDefault.zip\n";
  await write(path.join(store, "config", "iris.properties"), "shaderPack=Players.zip\n", later(300));
  await write(path.join(packInstance, "config", "iris.properties"), packDefault, later(400));
  await write(
    path.join(packInstance, ".bweeep", "mrpack-overrides.json"),
    JSON.stringify({ version: 2, files: { "config/iris.properties": createHash("sha256").update(packDefault).digest("hex") } })
  );
  await prepareUserContent(root, packInstance, fabric);
  assert.equal(await read(path.join(packInstance, "config", "iris.properties")), "shaderPack=Players.zip\n", "the pack's fresh default is replaced by the player's choice");

  // --- Removing a zip takes it out of every instance, settings files stay --------
  await fsp.rm(path.join(shared, "Complementary.zip"));
  await prepareUserContent(root, instanceA, fabric);
  assert.ok(!(await exists(path.join(instanceA, "shaderpacks", "Complementary.zip"))), "no stale zip");
  assert.ok(await exists(path.join(instanceA, "shaderpacks", "Complementary.zip.txt")), "its option file is the player's, left alone");

  // --- Zips left in the old per-loader folders move into the shared one ----------
  const legacyRoot = path.join(root, "legacy");
  const legacyShared = path.join(legacyRoot, ".bweeep-user-content", "shaderpacks");
  await write(path.join(legacyShared, "forge-1.20.1", "Old.zip"), "from forge");
  await write(path.join(legacyShared, "fabric-1.21.1", "Old.zip"), "from fabric");
  await write(path.join(legacyShared, "fabric-1.21.1", "Only.zip"), "only on fabric");
  await write(path.join(legacyShared, "forge-1.20.1", "notes.md"), "keep me");
  const legacyInstance = path.join(root, "legacy-instance");
  await fsp.mkdir(legacyInstance);
  await prepareUserContent(legacyRoot, legacyInstance, fabric);
  assert.deepEqual((await fsp.readdir(legacyInstance + "/shaderpacks")).sort(), ["Only.zip", "Old.zip"].sort());
  assert.ok(await exists(path.join(legacyShared, "Old.zip")) && await exists(path.join(legacyShared, "Only.zip")));
  assert.ok(await exists(path.join(legacyShared, "forge-1.20.1", "notes.md")), "a folder with other files is not touched");
  assert.ok(!(await exists(path.join(legacyShared, "fabric-1.21.1", "Only.zip"))), "moved up");
  console.log("shader-folder-and-settings-follow-the-player=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
