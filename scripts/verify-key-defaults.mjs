// A pack's starting keys reach players who already have an options.txt:
// missing keys are filled in, colliding keys move once and a later rebind stays,
// the keys the manifest names are put on their value once, and everything else
// in the file (other lines, other keys, line endings) is left alone.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { applyKeyDefaults, applyKeyDefaultsToText, parseKeyDefaults } from "../dist/src/main/key-defaults.js";
import { assertManifest } from "../dist/src/main/manifest-validation.js";
import { captureSharedOptions, prepareUserContent } from "../dist/src/main/user-content.js";

const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-key-defaults-"));
const read = (file) => fsp.readFile(file, "utf8");
const exists = (file) => fsp.stat(file).then(() => true, () => false);
const write = async (file, text) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
};
const lines = (...items) => `${items.join("\n")}\n`;

try {
  // --- Reading a pack's options.txt: only safe key bindings count -------------------
  const defaults = parseKeyDefaults("version:3955\r\nkey_gui.xaero_open_map:key.keyboard.n\r\nkey_key.jump:key.keyboard.space\r\nkey_bad:rm -rf\r\nmouseSensitivity:0.5\r\nkey_gui.zoom:key.keyboard.unknown\r\n");
  assert.deepEqual([...defaults], [["gui.xaero_open_map", "key.keyboard.n"], ["key.jump", "key.keyboard.space"], ["gui.zoom", "key.keyboard.unknown"]]);

  // --- Fill-in: keys the player's file lacks get the pack's default -----------------
  const pack = new Map([["gui.xaero_open_map", "key.keyboard.n"], ["key.cobblemon.summary", "key.keyboard.m"]]);
  const filled = applyKeyDefaultsToText(lines("version:3465", "mouseSensitivity:0.7", "key_key.jump:key.keyboard.x"), new Map([...pack, ["key.jump", "key.keyboard.space"]]), new Set());
  assert.deepEqual(filled.filled, ["gui.xaero_open_map", "key.cobblemon.summary"]);
  assert.equal(filled.text, lines("version:3465", "mouseSensitivity:0.7", "key_key.jump:key.keyboard.x", "key_gui.xaero_open_map:key.keyboard.n", "key_key.cobblemon.summary:key.keyboard.m"), "the player's own jump key and sensitivity stay");
  assert.deepEqual(filled.repaired, []);

  // --- Collision, pack file only: both on M, the pack puts the map on N ------------
  const polluted = lines("version:3955", "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.m", "key_key.sneak:key.keyboard.left.shift");
  const fixed = applyKeyDefaultsToText(polluted, pack, new Set());
  assert.deepEqual(fixed.repaired, [{ key: "gui.xaero_open_map", from: "key.keyboard.m", to: "key.keyboard.n" }]);
  assert.equal(fixed.text, lines("version:3955", "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.n", "key_key.sneak:key.keyboard.left.shift"));
  // The move is a one-time thing: a key already moved once is not touched again.
  const again = applyKeyDefaultsToText(polluted, pack, new Set(["gui.xaero_open_map"]));
  assert.equal(again.text, polluted);
  assert.deepEqual(again.repaired, []);
  assert.equal(applyKeyDefaultsToText(fixed.text, pack, new Set(["gui.xaero_open_map"])).text, fixed.text, "the result is stable");

  // --- No collision: the very same bytes come back ----------------------------------
  const calm = lines("version:3955", "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.b");
  assert.equal(applyKeyDefaultsToText(calm, pack, new Set()).text, calm);
  // A collision whose pack default is taken by another key is left (a move would only shift the clash).
  const taken = lines("key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.m", "key_key.custom:key.keyboard.n");
  assert.equal(applyKeyDefaultsToText(taken, pack, new Set()).text, taken);
  // A key with no pack default is never moved, and unbound keys are not collisions.
  const noDefault = lines("key_key.a:key.keyboard.v", "key_key.b:key.keyboard.v", "key_key.c:key.keyboard.unknown", "key_key.d:key.keyboard.unknown");
  assert.equal(applyKeyDefaultsToText(noDefault, pack, new Set()).text, noDefault.concat(["key_gui.xaero_open_map:key.keyboard.n", "key_key.cobblemon.summary:key.keyboard.m"].map((line) => `${line}\n`).join("")));
  // A pack default of "unbound" always avoids the clash (Iris reload on R next to Cobblemon's throw key).
  const iris = applyKeyDefaultsToText(lines("key_key.cobblemon.throwpartypokemon:key.keyboard.r", "key_iris.keybind.reload:key.keyboard.r"), new Map([["key.cobblemon.throwpartypokemon", "key.keyboard.r"], ["iris.keybind.reload", "key.keyboard.unknown"]]), new Set());
  assert.equal(iris.text, lines("key_key.cobblemon.throwpartypokemon:key.keyboard.r", "key_iris.keybind.reload:key.keyboard.unknown"));
  // Modifier suffixes are part of the binding: Ctrl+O is not O.
  const modifier = lines("key_a:key.keyboard.o:CONTROL", "key_b:key.keyboard.o");
  assert.equal(applyKeyDefaultsToText(modifier, new Map([["b", "key.keyboard.p"]]), new Set()).text, modifier);

  // --- Keys the manifest names: summary on I, the map on M ---------------------------
  const chosen = new Map([["key.cobblemon.summary", "key.keyboard.i"], ["gui.xaero_open_map", "key.keyboard.m"]]);
  const withChosen = new Map([["key.cobblemon.summary", "key.keyboard.m"], ["gui.xaero_open_map", "key.keyboard.n"], ...chosen]);
  // Both on M, the way the friend's file looks after a launch.
  const both = applyKeyDefaultsToText(polluted, withChosen, new Set(), chosen);
  assert.equal(both.text, lines("version:3955", "key_key.cobblemon.summary:key.keyboard.i", "key_gui.xaero_open_map:key.keyboard.m", "key_key.sneak:key.keyboard.left.shift"));
  assert.deepEqual(both.repaired, [{ key: "key.cobblemon.summary", from: "key.keyboard.m", to: "key.keyboard.i" }]);
  assert.deepEqual([...both.settled].sort(), ["gui.xaero_open_map", "key.cobblemon.summary"], "the map already on M is settled too");
  // A new player's file from the pack's YOSBR (summary M, map N): no collision, still gets the owner's keys.
  const fresh = lines("key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.n");
  const freshResult = applyKeyDefaultsToText(fresh, withChosen, new Set(), chosen);
  assert.equal(freshResult.text, lines("key_key.cobblemon.summary:key.keyboard.i", "key_gui.xaero_open_map:key.keyboard.m"));
  // The order of the names does not matter: the map is named first but can only take M once summary left it.
  const reversed = new Map([["gui.xaero_open_map", "key.keyboard.m"], ["key.cobblemon.summary", "key.keyboard.i"]]);
  assert.equal(applyKeyDefaultsToText(lines("key_gui.xaero_open_map:key.keyboard.n", "key_key.cobblemon.summary:key.keyboard.m"), withChosen, new Set(), reversed).text,
    lines("key_gui.xaero_open_map:key.keyboard.m", "key_key.cobblemon.summary:key.keyboard.i"));
  // Once is once: after the first launch a rebind stays, collision or not.
  const rebound = lines("key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.m");
  assert.equal(applyKeyDefaultsToText(rebound, withChosen, new Set(["key.cobblemon.summary", "gui.xaero_open_map"]), chosen).text, rebound);
  // A key the owner wants that someone else already holds is left alone and not settled (no new clash).
  const held = lines("key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.n", "key_some.mod.action:key.keyboard.i");
  const heldResult = applyKeyDefaultsToText(held, withChosen, new Set(), chosen);
  assert.equal(heldResult.text, held);
  assert.ok(!heldResult.settled.includes("key.cobblemon.summary"));
  // Already on the owner's keys: the file stays byte for byte and both are settled.
  const done = lines("key_key.cobblemon.summary:key.keyboard.i", "key_gui.xaero_open_map:key.keyboard.m");
  const doneResult = applyKeyDefaultsToText(done, withChosen, new Set(), chosen);
  assert.equal(doneResult.text, done);
  assert.deepEqual([...doneResult.settled].sort(), ["gui.xaero_open_map", "key.cobblemon.summary"]);

  // --- Formatting survives: CRLF, no trailing newline, other lines -------------------
  const crlf = applyKeyDefaultsToText("version:1\r\nkey_x:key.keyboard.m\r\nkey_y:key.keyboard.m\r\n", new Map([["y", "key.keyboard.q"], ["z", "key.keyboard.t"]]), new Set());
  assert.equal(crlf.text, "version:1\r\nkey_x:key.keyboard.m\r\nkey_y:key.keyboard.q\r\nkey_z:key.keyboard.t\r\n");
  const bare = applyKeyDefaultsToText("version:1\nkey_x:key.keyboard.m", new Map([["z", "key.keyboard.t"]]), new Set());
  assert.equal(bare.text, "version:1\nkey_x:key.keyboard.m\nkey_z:key.keyboard.t", "no newline at the end stays that way");
  assert.equal(applyKeyDefaultsToText("", new Map([["z", "key.keyboard.t"]]), new Set()).text, "key_z:key.keyboard.t\n");

  // --- On disk: restored shared options + the pack's yosbr file + manifest keys ------
  const sharedDir = path.join(root, ".bweeep-user-content", "settings");
  const fabricPack = {
    id: "cobblemon-official", loader: { kind: "fabric" }, minecraftVersion: "1.21.1", files: [],
    defaultKeys: { "key.cobblemon.summary": "key.keyboard.i", "gui.xaero_open_map": "key.keyboard.m" }
  };
  const yosbr = lines(
    "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.n",
    "key_iris.keybind.reload:key.keyboard.unknown", "key_key.cobblemon.throwpartypokemon:key.keyboard.r"
  );
  // The friend's file after one launch of the pack: every collision is in it.
  await write(path.join(sharedDir, "options.txt"), lines(
    "version:3955", "mouseSensitivity:0.3", "soundCategory_master:0.4",
    "key_key.cobblemon.summary:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.m",
    "key_key.cobblemon.throwpartypokemon:key.keyboard.r", "key_iris.keybind.reload:key.keyboard.r"
  ));
  const instanceA = path.join(root, "instances", "cobblemon-official");
  await write(path.join(instanceA, "config", "yosbr", "options.txt"), yosbr);
  await prepareUserContent(root, instanceA, fabricPack);
  const afterA = await read(path.join(instanceA, "options.txt"));
  assert.match(afterA, /^key_key\.cobblemon\.summary:key\.keyboard\.i$/m, "summary moved to I");
  assert.match(afterA, /^key_gui\.xaero_open_map:key\.keyboard\.m$/m, "the map stays on M, not the pack's N");
  assert.match(afterA, /^key_iris\.keybind\.reload:key\.keyboard\.unknown$/m, "Iris reload unbound by the pack author's yosbr");
  assert.match(afterA, /^key_key\.cobblemon\.throwpartypokemon:key\.keyboard\.r$/m);
  assert.match(afterA, /^mouseSensitivity:0\.3$/m);
  assert.match(afterA, /^soundCategory_master:0\.4$/m);
  assert.equal(await read(path.join(sharedDir, "options.txt")), afterA, "the shared copy carries the fix at once");
  const record = JSON.parse(await read(path.join(instanceA, ".bweeep", "key-defaults-applied.json")));
  assert.deepEqual(record["cobblemon-official"], ["gui.xaero_open_map", "iris.keybind.reload", "key.cobblemon.summary"]);

  // The player rebinds summary on purpose: the next launch leaves it, collision or not.
  await write(path.join(instanceA, "options.txt"), afterA.replace("key_key.cobblemon.summary:key.keyboard.i", "key_key.cobblemon.summary:key.keyboard.m"));
  await captureSharedOptions(root, instanceA);
  await prepareUserContent(root, instanceA, fabricPack);
  const afterRebind = await read(path.join(instanceA, "options.txt"));
  assert.match(afterRebind, /^key_key\.cobblemon\.summary:key\.keyboard\.m$/m, "a deliberate rebind is not overridden again");
  assert.match(afterRebind, /^key_gui\.xaero_open_map:key\.keyboard\.m$/m);

  // A new player: YOSBR wrote the pack's file (summary M, map N); the first launch with the manifest sets I and M.
  const instanceC = path.join(root, "instances", "new-player");
  await write(path.join(instanceC, "options.txt"), lines("version:3955", ...yosbr.trim().split("\n")));
  await write(path.join(instanceC, "config", "yosbr", "options.txt"), yosbr);
  const first = await applyKeyDefaults(instanceC, path.join(root, "nowhere"), fabricPack);
  assert.deepEqual(first.repaired.map((item) => `${item.key}:${item.to}`).sort(), ["gui.xaero_open_map:key.keyboard.m", "key.cobblemon.summary:key.keyboard.i"]);
  const newText = await read(path.join(instanceC, "options.txt"));
  assert.match(newText, /^key_key\.cobblemon\.summary:key\.keyboard\.i$/m);
  assert.match(newText, /^key_gui\.xaero_open_map:key\.keyboard\.m$/m);
  assert.ok(!(await exists(path.join(root, "nowhere", "options.txt"))), "no shared copy is created when there is none");
  await write(path.join(instanceC, "options.txt"), newText.replace("key_gui.xaero_open_map:key.keyboard.m", "key_gui.xaero_open_map:key.keyboard.k"));
  await applyKeyDefaults(instanceC, path.join(root, "nowhere"), fabricPack);
  assert.match(await read(path.join(instanceC, "options.txt")), /^key_gui\.xaero_open_map:key\.keyboard\.k$/m, "second launch leaves the player's own map key");

  // Another server picks up the fixed keys and its own pack's starting keys.
  const instanceB = path.join(root, "instances", "society-sunlit-valley");
  await write(path.join(instanceB, "config", "yosbr", "options.txt"), lines("key_key.sunlit.thing:key.keyboard.j", "key_key.jump:key.keyboard.space"));
  await prepareUserContent(root, instanceB, { id: "society-sunlit-valley", loader: { kind: "forge" }, minecraftVersion: "1.20.1", files: [] });
  const afterB = await read(path.join(instanceB, "options.txt"));
  assert.match(afterB, /^key_key\.sunlit\.thing:key\.keyboard\.j$/m);
  assert.match(afterB, /^key_gui\.xaero_open_map:key\.keyboard\.m$/m, "the fix followed the player to another server");

  // --- Nothing to do: no options.txt, no pack keys ---------------------------------------
  const empty = path.join(root, "instances", "empty");
  await fsp.mkdir(empty, { recursive: true });
  assert.equal(await applyKeyDefaults(empty, sharedDir, fabricPack), null);
  assert.ok(!(await exists(path.join(empty, "options.txt"))), "no options.txt is created: YOSBR and the game start from scratch");
  const bare2 = path.join(root, "instances", "bare");
  await write(path.join(bare2, "options.txt"), "key_a:key.keyboard.m\nkey_b:key.keyboard.m\n");
  assert.equal(await applyKeyDefaults(bare2, sharedDir, { id: "bare" }), null, "no yosbr file and no manifest keys");
  assert.equal(await read(path.join(bare2, "options.txt")), "key_a:key.keyboard.m\nkey_b:key.keyboard.m\n");
  assert.ok(!(await exists(path.join(bare2, ".bweeep", "key-defaults-applied.json"))));

  // --- The manifest field is checked ---------------------------------------------------------
  const manifest = (defaultKeys) => ({
    schemaVersion: 1, id: "x", name: "x", version: "1", minecraftVersion: "1.21.1",
    java: { majorVersion: 21, component: "java-runtime-delta" }, loader: { kind: "fabric", version: "0.19.5" },
    server: { host: "server.example.com", port: 25565 }, files: [], defaultKeys
  });
  assertManifest(manifest(undefined));
  assertManifest(manifest({ "key.cobblemon.summary": "key.keyboard.i", "gui.xaero_open_map": "key.keyboard.m", z: "key.keyboard.unknown", w: "key.mouse.left" }));
  for (const bad of ["x", ["a"], { a: 1 }, { "a b": "key.keyboard.i" }, { a: "i" }, { a: "key.keyboard.i\nkey_evil:1" }, { a: "key.gamepad.a" }, null]) {
    assert.throws(() => assertManifest(manifest(bad)), /기본 키 설정/, JSON.stringify(bad));
  }

  console.log("key-defaults=passed");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
