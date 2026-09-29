import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { moveInstall, planInstallMove } from "../dist/src/main/install-move.js";

// Moving the install location in temporary folders: same volume (rename),
// forced and real cross-volume copies, failures halfway, and refused targets.

const LAUNCHER = [".bweeep-user-content", "sunlit-valley", "vanilla-263"];
const PLAYER_OWN = ["notes.txt", "My Stuff", "pack-no-mark"];

async function write(file, contents) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents);
}

async function makeInstall(root, { playerFiles = true } = {}) {
  await write(path.join(root, ".bweeep-user-content", "settings", "options.txt"), "sensitivity:0.42");
  await write(path.join(root, ".bweeep-user-content", "mods", "fabric-26.3", "zoom.jar"), "zoom jar");
  await write(path.join(root, "vanilla-263", "bweeep-manifest.json"), "{}");
  await write(path.join(root, "vanilla-263", ".bweeep", "file-hashes.json"), "{}");
  await write(path.join(root, "vanilla-263", "saves", "world", "level.dat"), crypto.randomBytes(3 * 1024 * 1024));
  await write(path.join(root, "vanilla-263", "mods", "fabric-api.jar"), crypto.randomBytes(4096));
  await fsp.mkdir(path.join(root, "vanilla-263", "resourcepacks"), { recursive: true });
  await write(path.join(root, "sunlit-valley", ".bweeep", "runtime", "bin", "java"), "java");
  if (playerFiles) {
    await write(path.join(root, "notes.txt"), "not the launcher's");
    await write(path.join(root, "My Stuff", "photo.png"), "mine");
    await write(path.join(root, "pack-no-mark", "readme.txt"), "looks like an instance name, is not one");
  }
}

async function tree(root, relative = "") {
  const result = {};
  const target = path.join(root, relative);
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return result;
  if (stat.isDirectory()) {
    result[relative || "."] = "dir";
    for (const entry of (await fsp.readdir(target)).sort()) Object.assign(result, await tree(root, relative ? `${relative}/${entry}` : entry));
  } else {
    result[relative] = `${stat.size}:${crypto.createHash("sha256").update(await fsp.readFile(target)).digest("hex")}:${Math.floor(stat.mtimeMs)}`;
  }
  return result;
}

const pick = (snapshot, names) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => names.some((name) => key === name || key.startsWith(`${name}/`))));
const exists = (target) => fsp.lstat(target).then(() => true, () => false);

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-install-move-"));
try {
  // Same volume: renamed, player files untouched, the old folder stays because it is not empty.
  const old = path.join(root, "old");
  await makeInstall(old);
  const before = await tree(old);
  const renamePlan = await planInstallMove(old, path.join(root, "renamed"));
  assert.equal(renamePlan.problem, undefined);
  assert.equal(renamePlan.sameVolume, true);
  assert.deepEqual(renamePlan.entries, LAUNCHER);
  const renameProgress = [];
  const renamed = await moveInstall(renamePlan, (percent) => renameProgress.push(percent));
  await renamed.removeOriginals();
  assert.equal(renameProgress.at(-1), 100);
  assert.deepEqual(pick(await tree(path.join(root, "renamed")), LAUNCHER), pick(before, LAUNCHER));
  assert.deepEqual((await fsp.readdir(old)).sort(), [...PLAYER_OWN].sort());
  assert.deepEqual(pick(await tree(old), PLAYER_OWN), pick(before, PLAYER_OWN));
  console.log("install-move-same-volume-rename=passed");

  // Copy (as across volumes) into a folder that does not exist yet.
  const copySource = path.join(root, "copy-source");
  await makeInstall(copySource, { playerFiles: false });
  const copyBefore = await tree(copySource);
  const copyTarget = path.join(root, "made", "for", "copy");
  const copyPlan = await planInstallMove(copySource, copyTarget, { forceCopy: true });
  assert.equal(copyPlan.sameVolume, false);
  assert.ok(copyPlan.bytes > 3 * 1024 * 1024);
  const copyProgress = [];
  const copied = await moveInstall(copyPlan, (percent) => copyProgress.push(percent), { forceCopy: true });
  assert.deepEqual(await tree(copySource), copyBefore, "originals stay until the new location is saved");
  assert.deepEqual(await tree(copyTarget), copyBefore, "copies match in size, hash and time");
  assert.ok(copyProgress.every((percent, index) => index === 0 || percent >= copyProgress[index - 1]) && copyProgress.at(-1) === 100 && copyProgress.length > 3);
  await copied.removeOriginals();
  assert.equal(await exists(copySource), false, "an old folder left empty is removed");
  console.log("install-move-copy-verify-and-switch=passed");

  // A copy failing halfway removes only what it created; the original stays whole.
  const failSource = path.join(root, "fail-source");
  await makeInstall(failSource);
  const failBefore = await tree(failSource);
  const failPlan = await planInstallMove(failSource, path.join(root, "fail-made", "new"), { forceCopy: true });
  await assert.rejects(() => moveInstall(failPlan, () => {}, {
    forceCopy: true,
    fault: (step, name) => { if (step === "copy" && name === "vanilla-263/saves/world/level.dat") throw new Error("disk pulled out"); }
  }), /disk pulled out/);
  assert.equal(await exists(path.join(root, "fail-made")), false, "folders made for the new location are taken back");
  assert.deepEqual(await tree(failSource), failBefore);

  // A rename failing halfway renames the moved folders back.
  const renameFailPlan = await planInstallMove(failSource, path.join(root, "rename-fail"));
  await assert.rejects(() => moveInstall(renameFailPlan, () => {}, {
    fault: (step, name) => { if (step === "rename" && name === "vanilla-263") throw new Error("file in use"); }
  }), /file in use/);
  assert.equal(await exists(path.join(root, "rename-fail")), false);
  assert.deepEqual(await tree(failSource), failBefore);
  console.log("install-move-failure-rollback=passed");

  // Refused targets.
  const refused = path.join(root, "refused");
  await makeInstall(refused);
  assert.equal((await planInstallMove(refused, refused)).problem, "지금 위치와 같아요");
  assert.equal((await planInstallMove(refused, path.join(refused, "inside"))).problem, "지금 위치와 겹치는 폴더예요");
  assert.equal((await planInstallMove(refused, root)).problem, "지금 위치와 겹치는 폴더예요");
  await fsp.symlink(refused, path.join(root, "link-to-refused"));
  assert.equal((await planInstallMove(refused, path.join(root, "link-to-refused", "deeper"))).problem, "지금 위치와 겹치는 폴더예요", "a link does not hide an overlap");
  await write(path.join(root, "occupied", "vanilla-263", "bweeep-manifest.json"), "{}");
  assert.equal((await planInstallMove(refused, path.join(root, "occupied"))).problem, "새 위치에 이미 붸에엡 파일이 있어요");
  await write(path.join(root, "a-file"), "x");
  assert.equal((await planInstallMove(refused, path.join(root, "a-file"))).problem, "폴더가 아니에요");
  const full = await planInstallMove(refused, path.join(root, "full"), { forceCopy: true, freeBytes: async () => 1024 });
  assert.match(full.problem ?? "", /^새 위치에 공간이 부족해요 · [\d.]+GB 더 필요해요$/);
  assert.equal((await planInstallMove(refused, path.join(root, "full"), { freeBytes: async () => 1024 })).problem, undefined, "a rename needs no free space");
  await fsp.symlink(path.join(root, "My Stuff"), path.join(refused, "vanilla-263", "linked"));
  assert.equal((await planInstallMove(refused, path.join(root, "linked"), { forceCopy: true, freeBytes: async () => null })).problem, "바로가기 링크가 있어 옮길 수 없어요");
  await assert.rejects(() => moveInstall(full, () => {}), /공간이 부족/);
  const empty = await planInstallMove(path.join(root, "never-installed"), path.join(root, "elsewhere"));
  assert.deepEqual(empty.entries, []);
  console.log("install-move-refusals=passed");

  // A real second volume when this machine has one (/dev/shm is its own tmpfs on Linux).
  const shm = "/dev/shm";
  const shmStat = await fsp.stat(shm).catch(() => null);
  if (shmStat && shmStat.dev !== (await fsp.stat(root)).dev) {
    const other = await fsp.mkdtemp(path.join(shm, "bweeep-install-move-"));
    try {
      const source = path.join(root, "cross-source");
      await makeInstall(source);
      const sourceBefore = await tree(source);
      const crossPlan = await planInstallMove(source, path.join(other, "moved"));
      assert.equal(crossPlan.sameVolume, false);
      const cross = await moveInstall(crossPlan, () => {});
      await cross.removeOriginals();
      assert.deepEqual(pick(await tree(path.join(other, "moved")), LAUNCHER), pick(sourceBefore, LAUNCHER));
      assert.deepEqual((await fsp.readdir(source)).sort(), [...PLAYER_OWN].sort());
      console.log("install-move-real-cross-volume=passed");
    } finally {
      await fsp.rm(other, { recursive: true, force: true });
    }
  } else {
    console.log("install-move-real-cross-volume=skipped (no second volume)");
  }
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
