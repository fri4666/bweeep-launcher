import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { addUserContentFolders, prepareUserContent, removeUserContentFolder } from "../dist/src/main/user-content.js";

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-user-content-"));
const manifest = { loader: { kind: "fabric" }, minecraftVersion: "1.21.1", files: [] };
try {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const instance = path.join(root, "instance");
  await Promise.all([fsp.mkdir(first), fsp.mkdir(second), fsp.mkdir(instance)]);
  await Promise.all([
    fsp.writeFile(path.join(first, "shared.jar"), "first"),
    fsp.writeFile(path.join(second, "shared.jar"), "second"),
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
  console.log("user-content-folder-selection-regression=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
