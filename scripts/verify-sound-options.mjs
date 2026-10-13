// The player's volumes and settings must follow them to a server whose launch
// finds no (or an incomplete) shared options.txt: the shared copy is seeded from
// the newest of their other servers, volume lines it lacks are filled in without
// touching lines it has, nothing is invented when there is nothing to inherit,
// and a running game's options.txt is copied to the shared store while it runs.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  addSoundLines,
  createSharedOptionsSync,
  isUsableOptions,
  optionsSourceLabel,
  parseSoundLines,
  prepareSharedOptions
} from "../dist/src/main/shared-options.js";
import { captureSharedOptions, prepareUserContent } from "../dist/src/main/user-content.js";

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-sound-options-"));
const settings = path.join(root, ".bweeep-user-content", "settings");
const sharedFile = path.join(settings, "options.txt");
const read = (file) => fsp.readFile(file, "latin1");
const exists = (file) => fsp.stat(file).then(() => true, () => false);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (...items) => `${items.join("\n")}\n`;
const write = async (file, text, when) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, "latin1");
  if (when) await fsp.utimes(file, new Date(when), new Date(when));
};
const reset = async () => {
  for (const entry of await fsp.readdir(root)) await fsp.rm(path.join(root, entry), { recursive: true, force: true });
};
const instance = (pack) => path.join(root, pack);
const day = (n) => Date.UTC(2026, 9, n);
const fabric = { id: "cobblemon-official", loader: { kind: "fabric" }, minecraftVersion: "1.21.1", files: [] };
const forge = { id: "society-sunlit-valley", loader: { kind: "forge" }, minecraftVersion: "1.20.1", files: [] };

const quiet = lines("version:3465", "mouseSensitivity:0.8", "soundCategory_master:0.9", "soundCategory_music:0", "soundCategory_record:0.3", "key_key.jump:key.keyboard.x");
const olderQuiet = lines("version:3465", "mouseSensitivity:0.1", "soundCategory_master:0.2", "soundCategory_music:0.2");
const noSound = lines("version:3955", "mouseSensitivity:0.5", "key_key.jump:key.keyboard.space");

try {
  // --- Reading and writing option lines --------------------------------------------------
  assert.ok(isUsableOptions("version:3955\n"));
  assert.ok(!isUsableOptions(""));
  assert.ok(!isUsableOptions("\u0000\u0000\u0000"));
  assert.deepEqual([...parseSoundLines("soundCategory_master:0.5\r\nsoundCategory_music:abc\r\nsoundCategory_ui:1.0\nmouseSensitivity:0.5")], [["master", "0.5"], ["ui", "1.0"]]);
  assert.equal(addSoundLines("a:1\r\n", new Map([["master", "0.5"]])), "a:1\r\nsoundCategory_master:0.5\r\n", "uses the file's own line ending");
  assert.equal(addSoundLines("a:1", new Map([["master", "0.5"]])), "a:1\nsoundCategory_master:0.5\n", "a missing last newline is added first");
  assert.equal(addSoundLines("a:1\n", new Map()), "a:1\n");
  assert.equal(optionsSourceLabel({ source: "options.seeded-from", pack: "x" }), "options.seeded-from:x");
  assert.equal(optionsSourceLabel({ source: "options.shared", sound: "none" }), "options.shared");
  console.log("sound-options-lines=passed");

  // --- No shared file: seeded from the newest other server, through a real launch step ----
  await reset();
  await write(path.join(instance("vanilla-survival"), "options.txt"), olderQuiet, day(1));
  await write(path.join(instance("society-sunlit-valley"), "options.txt"), quiet, day(5));
  await write(path.join(instance("empty-pack"), "options.txt"), "", day(9));
  await write(path.join(instance("broken-pack"), "options.txt"), "\u0000\u0000", day(10));
  await fsp.mkdir(instance("cobblemon-official"), { recursive: true });
  const seeded = await prepareUserContent(root, instance("cobblemon-official"), fabric);
  assert.equal(seeded.optionsSource, "options.seeded-from:society-sunlit-valley", "the newest usable file wins; empty and garbage files are skipped");
  assert.equal(await read(sharedFile), quiet, "the shared copy is the other server's file, byte for byte");
  assert.equal(await read(path.join(instance("cobblemon-official"), "options.txt")), quiet, "the new server starts with the player's volumes, sensitivity and keys");
  assert.equal((await fsp.stat(sharedFile)).mtimeMs, day(5), "the shared copy keeps the time of the file it came from");
  console.log("sound-options-seeded=passed");

  // --- The instance being started is not "another server" -------------------------------
  await reset();
  await write(path.join(instance("cobblemon-official"), "options.txt"), quiet, day(5));
  const self = await prepareSharedOptions(root, instance("cobblemon-official"), settings);
  assert.deepEqual(self, { source: "options.instance-own" }, "its own file is kept and nothing is copied from it");
  assert.ok(!(await exists(sharedFile)));
  console.log("sound-options-not-self=passed");

  // --- A shared file with volumes is never touched, other servers or not ----------------
  await reset();
  const sharedWithSound = "version:3955\r\nmouseSensitivity:0.3\r\nsoundCategory_master:0.4\r\nkey_key.jump:key.keyboard.x";
  await write(sharedFile, sharedWithSound, day(2));
  await write(path.join(instance("society-sunlit-valley"), "options.txt"), quiet, day(9));
  const kept = await prepareUserContent(root, instance("cobblemon-official"), fabric);
  assert.equal(kept.optionsSource, "options.shared");
  assert.equal(await read(sharedFile), sharedWithSound, "byte for byte: CRLF, missing last newline and all");
  assert.equal((await fsp.stat(sharedFile)).mtimeMs, day(2), "not even rewritten");
  assert.match(await read(path.join(instance("cobblemon-official"), "options.txt")), /^soundCategory_master:0\.4\r?$/m, "the shared volume, not the other server's, reaches the game");
  console.log("sound-options-shared-untouched=passed");

  // --- A shared file without volume lines gets only those lines --------------------------
  await reset();
  await write(sharedFile, noSound.replace(/\n/g, "\r\n"), day(2));
  await write(path.join(instance("vanilla-survival"), "options.txt"), noSound, day(8));
  await write(path.join(instance("old-pack"), "options.txt"), olderQuiet, day(3));
  await write(path.join(instance("society-sunlit-valley"), "options.txt"), quiet, day(6));
  const filled = await prepareUserContent(root, instance("cobblemon-official"), fabric);
  assert.equal(filled.optionsSource, "options.sound-filled:society-sunlit-valley", "the newest server that has volumes, even if a newer one has none");
  assert.equal(
    await read(sharedFile),
    `${noSound.replace(/\n/g, "\r\n")}soundCategory_master:0.9\r\nsoundCategory_music:0\r\nsoundCategory_record:0.3\r\n`,
    "the shared lines stay as they were; only the three volume lines are appended, in the file's CRLF"
  );
  const gameFile = await read(path.join(instance("cobblemon-official"), "options.txt"));
  assert.match(gameFile, /^mouseSensitivity:0\.5\r?$/m, "sensitivity stays the shared file's, not the other server's 0.8");
  assert.match(gameFile, /^soundCategory_music:0\r?$/m);
  // Nobody has volumes: the file is left exactly as it is.
  await reset();
  await write(sharedFile, noSound, day(2));
  await write(path.join(instance("vanilla-survival"), "options.txt"), noSound, day(8));
  assert.deepEqual(await prepareSharedOptions(root, instance("cobblemon-official"), settings), { source: "options.shared", sound: "none" });
  assert.equal(await read(sharedFile), noSound);
  console.log("sound-options-filled=passed");

  // --- Nothing anywhere: nothing is invented -------------------------------------------
  await reset();
  await fsp.mkdir(instance("cobblemon-official"), { recursive: true });
  const fresh = await prepareUserContent(root, instance("cobblemon-official"), fabric);
  assert.equal(fresh.optionsSource, "options.fresh-yosbr");
  assert.ok(!(await exists(sharedFile)), "no shared file made up");
  assert.ok(!(await exists(path.join(instance("cobblemon-official"), "options.txt"))), "no options.txt made up: YOSBR and the game start from their own defaults");
  console.log("sound-options-nothing-invented=passed");

  // --- An empty or half-written shared file: seeded when possible, otherwise it must not wipe the game's file
  await reset();
  await write(sharedFile, "", day(2));
  await write(path.join(instance("society-sunlit-valley"), "options.txt"), quiet, day(4));
  assert.equal((await prepareUserContent(root, instance("cobblemon-official"), fabric)).optionsSource, "options.seeded-from:society-sunlit-valley");
  assert.equal(await read(sharedFile), quiet);
  await reset();
  await write(sharedFile, "", day(2));
  await write(path.join(instance("cobblemon-official"), "options.txt"), noSound, day(3));
  const own = await prepareUserContent(root, instance("cobblemon-official"), fabric);
  assert.equal(own.optionsSource, "options.instance-own");
  assert.equal(await read(path.join(instance("cobblemon-official"), "options.txt")), noSound, "an unusable shared file is not copied over the game's own options.txt");
  console.log("sound-options-unusable-shared=passed");

  // --- It follows the player across loaders, and the pack's start keys still apply afterwards
  await reset();
  await write(path.join(instance("society-sunlit-valley"), "options.txt"), lines("version:3465", "soundCategory_master:0.35", "soundCategory_music:0.1", "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.m"), day(6));
  const withKeys = { ...fabric, defaultKeys: { "key.cobblemon.summary": "key.keyboard.i", "gui.xaero_open_map": "key.keyboard.m" } };
  const crossed = await prepareUserContent(root, instance("cobblemon-official"), withKeys);
  assert.equal(crossed.optionsSource, "options.seeded-from:society-sunlit-valley");
  const crossedText = await read(path.join(instance("cobblemon-official"), "options.txt"));
  assert.match(crossedText, /^soundCategory_master:0\.35$/m);
  assert.match(crossedText, /^key_key\.cobblemon\.summary:key\.keyboard\.i$/m, "seed/fill happens first, key defaults after");
  await prepareUserContent(root, instance("society-sunlit-valley"), forge);
  assert.match(await read(path.join(instance("society-sunlit-valley"), "options.txt")), /^soundCategory_master:0\.35$/m, "the same volumes come back on the Forge server");
  console.log("sound-options-across-loaders=passed");

  // --- Copying while the game runs ------------------------------------------------------
  await reset();
  const running = instance("cobblemon-official");
  await write(path.join(running, "options.txt"), quiet, day(1));
  await captureSharedOptions(root, running);
  const baseline = await fsp.stat(sharedFile);
  let calls = 0;
  const sync = createSharedOptionsSync(running, async () => { calls += 1; await captureSharedOptions(root, running); }, { intervalMs: 20 });
  sync.start();
  await wait(150);
  assert.equal(calls, 0, "nothing changed since the launch, so nothing is copied");
  assert.equal((await fsp.stat(sharedFile)).mtimeMs, baseline.mtimeMs, "the shared file was not rewritten");
  // The player changes a volume in the game.
  const changed = quiet.replace("soundCategory_master:0.9", "soundCategory_master:0.15");
  await write(path.join(running, "options.txt"), changed, Date.now() + 5000);
  await wait(200);
  assert.equal(calls, 1, "one copy for one change");
  assert.equal(await read(sharedFile), changed, "the change reached the shared store while the game is still running");
  await wait(150);
  assert.equal(calls, 1, "an unchanged file is not copied again");
  // An empty or garbage file (the game mid-write) is not copied.
  await write(path.join(running, "options.txt"), "", Date.now() + 6000);
  await wait(120);
  await write(path.join(running, "options.txt"), "\u0000\u0000\u0000", Date.now() + 7000);
  await wait(120);
  assert.equal(calls, 1);
  assert.equal(await read(sharedFile), changed, "the shared copy still has the last good file");
  // Later good change is copied, then stop() ends it for good.
  const changedAgain = changed.replace("soundCategory_music:0", "soundCategory_music:0.6");
  await write(path.join(running, "options.txt"), changedAgain, Date.now() + 8000);
  await wait(150);
  assert.equal(calls, 2);
  sync.stop();
  await write(path.join(running, "options.txt"), changedAgain.replace("0.6", "0.7"), Date.now() + 9000);
  await wait(150);
  assert.equal(calls, 2, "nothing is copied after the game ended");
  assert.equal(sync.captures, 2);
  // A game that ended before the copy started never starts it.
  const early = createSharedOptionsSync(running, async () => { calls += 1; }, { intervalMs: 10 });
  early.stop();
  early.start();
  await write(path.join(running, "options.txt"), changedAgain.replace("0.6", "0.8"), Date.now() + 10000);
  await wait(100);
  assert.equal(calls, 2, "stop before start keeps it off");
  console.log("sound-options-periodic=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
