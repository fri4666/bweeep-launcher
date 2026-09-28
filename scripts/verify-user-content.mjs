import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { addUserContentFolders, prepareUserContent, removeUserContentFolder } from "../dist/src/main/user-content.js";
import { writeModJar } from "./lib/test-jars.mjs";

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-user-content-"));
const manifest = { loader: { kind: "fabric" }, minecraftVersion: "1.21.1", files: [] };
try {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const instance = path.join(root, "instance");
  await Promise.all([fsp.mkdir(first), fsp.mkdir(second), fsp.mkdir(instance)]);
  await Promise.all([
    writeModJar(path.join(first, "shared.jar"), "fabric", "first_mod"),
    writeModJar(path.join(second, "shared.jar"), "fabric", "second_mod"),
    fsp.writeFile(path.join(first, "shared.zip"), "first"),
    fsp.writeFile(path.join(second, "shared.zip"), "second")
  ]);

  await addUserContentFolders(root, "mods", [first, second]);
  await addUserContentFolders(root, "shaderpacks", [first, second]);
  await prepareUserContent(root, instance, manifest);
  assert.equal((await fsp.readdir(path.join(instance, "mods"))).length, 2, "same-name mods from separate folders must both apply");
  assert.equal((await fsp.readdir(path.join(instance, "shaderpacks"))).length, 2, "same-name shaders from separate folders must both apply");

  await removeUserContentFolder(root, "mods", second);
  await prepareUserContent(root, instance, manifest);
  assert.equal((await fsp.readdir(path.join(instance, "mods"))).length, 1, "removing a saved folder must remove only its prior personal file");

  for (const [loader, minecraftVersion] of [["forge", "1.20.1"], ["neoforge", "1.21.1"]]) {
    const compatibleRoot = path.join(root, loader);
    const compatibleInstance = path.join(root, loader + "-instance");
    const compatibilityId = loader + "-" + minecraftVersion;
    const mods = path.join(compatibleRoot, ".bweeep-user-content", "mods", compatibilityId);
    const shaders = path.join(compatibleRoot, ".bweeep-user-content", "shaderpacks", compatibilityId);
    await Promise.all([fsp.mkdir(mods, { recursive: true }), fsp.mkdir(shaders, { recursive: true }), fsp.mkdir(compatibleInstance, { recursive: true })]);
    await Promise.all([writeModJar(path.join(mods, "personal.jar"), loader, `${loader}_personal`), fsp.writeFile(path.join(shaders, "personal.zip"), loader)]);
    const status = await prepareUserContent(compatibleRoot, compatibleInstance, {
      loader: { kind: loader }, minecraftVersion, files: []
    });
    assert.deepEqual(await fsp.readFile(path.join(compatibleInstance, "mods", "personal.jar")), await fsp.readFile(path.join(mods, "personal.jar")));
    assert.equal(await fsp.readFile(path.join(compatibleInstance, "shaderpacks", "personal.zip"), "utf8"), loader);
    assert.equal(status.copiedMods, 1);
    assert.equal(status.copiedShaders, 1);
  }

  // Personal jars that would stop the game are left out, with a reason.
  const checkRoot = path.join(root, "checks");
  const checkInstance = path.join(root, "checks-instance");
  const personal = path.join(checkRoot, ".bweeep-user-content", "mods", "fabric-1.21.1");
  await Promise.all([fsp.mkdir(personal, { recursive: true }), fsp.mkdir(path.join(checkInstance, "mods"), { recursive: true })]);
  await Promise.all([
    writeModJar(path.join(checkInstance, "mods", "sodium-pack.jar"), "fabric", "sodium"),
    writeModJar(path.join(personal, "sodium-personal.jar"), "fabric", "sodium"),
    writeModJar(path.join(personal, "forge-only.jar"), "forge", "forge_thing"),
    writeModJar(path.join(personal, "minimap-a.jar"), "fabric", "minimap"),
    writeModJar(path.join(personal, "minimap-b.jar"), "fabric", "minimap"),
    writeModJar(path.join(personal, "zoom.jar"), "fabric", "zoom"),
    fsp.writeFile(path.join(personal, "broken.jar"), "not a zip")
  ]);
  const checked = await prepareUserContent(checkRoot, checkInstance, manifest);
  const reasons = Object.fromEntries(checked.skippedMods.map((mod) => [mod.name, mod.reason]));
  assert.equal(reasons["sodium-personal.jar"], "서버 팩에 이미 있는 모드예요");
  assert.equal(reasons["forge-only.jar"], "Fabric용 모드가 아니에요");
  assert.equal(reasons["minimap-b.jar"], "같은 모드가 개인 모드에 두 번 들어 있어요");
  assert.equal(reasons["broken.jar"], "모드 파일을 읽지 못했어요");
  assert.deepEqual((await fsp.readdir(path.join(checkInstance, "mods"))).sort(), ["minimap-a.jar", "sodium-pack.jar", "zoom.jar"]);

  const blockedRun = await prepareUserContent(checkRoot, checkInstance, manifest, {
    findBlocked: async (jars) => new Set(jars.filter((jar) => jar.endsWith("zoom.jar")))
  });
  assert.equal(blockedRun.skippedMods.find((mod) => mod.name === "zoom.jar")?.reason, "이 서버에서 쓰지 않기로 한 모드예요");
  assert.ok(!(await fsp.readdir(path.join(checkInstance, "mods"))).includes("zoom.jar"), "a blocked jar from the last launch is taken out");

  const plain = await prepareUserContent(checkRoot, checkInstance, manifest, { withoutPersonalMods: true });
  assert.equal(plain.copiedMods, 0);
  assert.deepEqual(await fsp.readdir(path.join(checkInstance, "mods")), ["sodium-pack.jar"], "only the server pack is left");

  const vanilla = await prepareUserContent(checkRoot, checkInstance, { ...manifest, loader: { kind: "vanilla" } });
  assert.equal(vanilla.copiedMods, 0);

  console.log("user-content-folder-selection-regression=passed");
  console.log("forge-neoforge-personal-mods-and-shaders=passed");
  console.log("personal-mod-launch-checks=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
