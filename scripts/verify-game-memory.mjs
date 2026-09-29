import assert from "node:assert/strict";
import { autoMemoryMb, memoryChoicesMb, recommendedMemoryMb, resolveGameMemory } from "../dist/src/shared/game-memory.js";
import { assertManifest } from "../dist/src/main/manifest-validation.js";
import { toServerPreset } from "../dist/src/main/catalog.js";

const jar = (name) => ({ path: `mods/${name}.jar`, size: 1, sha256: "a".repeat(64), url: "https://example.com/x.jar" });
const manifest = (overrides = {}) => ({
  schemaVersion: 1,
  id: "pack",
  name: "Pack",
  version: "1",
  minecraftVersion: "26.3",
  java: { majorVersion: 25, component: "java-runtime-epsilon" },
  loader: { kind: "fabric", version: "0.19.5" },
  server: { host: "server.fri4666.com", port: 25565 },
  gameAuth: "yggdrasil",
  files: [],
  ...overrides
});
const mods = (count) => Array.from({ length: count }, (_, index) => jar(`mod-${index}`));

// The pack's own value first; without one every pack keeps the old 6GB, whatever it lists.
assert.equal(recommendedMemoryMb(manifest()), 6144);
assert.equal(recommendedMemoryMb(manifest({ files: mods(10) })), 6144);
assert.equal(recommendedMemoryMb(manifest({ loader: { kind: "forge", version: "47.4.0" } })), 6144);
assert.equal(recommendedMemoryMb(manifest({ recommendedMemoryMb: 4096 })), 4096);
assert.equal(recommendedMemoryMb(manifest({ loader: { kind: "forge", version: "47.4.0" }, recommendedMemoryMb: 8192 })), 8192);
assert.equal(recommendedMemoryMb(manifest({ recommendedMemoryMb: 12.5 })), 6144, "a broken value is ignored");
assert.equal(toServerPreset(manifest({ recommendedMemoryMb: 5120 })).recommendedMemoryMb, 5120);

// The manifest field is an optional whole number of MB.
assertManifest(manifest({ recommendedMemoryMb: 6144 }));
for (const bad of [0, 512, 6144.5, "6144", 70000, -1]) {
  assert.throws(() => assertManifest(manifest({ recommendedMemoryMb: bad })), /권장 메모리/, `rejects ${bad}`);
}

// Automatic: the recommendation, leaving 4GB to the PC, never under 2GB.
assert.equal(autoMemoryMb(6144, 32768), 6144);
assert.equal(autoMemoryMb(6144, 16088), 6144);
assert.equal(autoMemoryMb(6144, 8000), 3840, "8GB PC keeps 4GB for Windows");
assert.equal(autoMemoryMb(3072, 8000), 3072);
assert.equal(autoMemoryMb(6144, 4000), 2048, "never under 2GB");

// The slider: whole GB from 2GB up to the PC's memory minus 2GB, at most 16GB.
assert.deepEqual(memoryChoicesMb(8000), [2048, 3072, 4096, 5120]);
assert.deepEqual(memoryChoicesMb(3000), [2048]);
assert.equal(memoryChoicesMb(65536).at(-1), 16384);

// One launch: -Xmx from the setting or automatic, -Xms never above it.
assert.deepEqual(resolveGameMemory({ recommendedMb: 6144, totalMb: 16384 }), { minMb: 2048, maxMb: 6144, auto: true });
assert.deepEqual(resolveGameMemory({ recommendedMb: 6144, totalMb: 16384, requestedMb: null }), { minMb: 2048, maxMb: 6144, auto: true });
assert.deepEqual(resolveGameMemory({ recommendedMb: 6144, totalMb: 16384, requestedMb: 4096 }), { minMb: 2048, maxMb: 4096, auto: false });
assert.deepEqual(resolveGameMemory({ recommendedMb: 3072, totalMb: 16384, requestedMb: 10240 }), { minMb: 2048, maxMb: 10240, auto: false });
// Another PC's (or a tampered) value snaps to what this PC offers.
assert.equal(resolveGameMemory({ recommendedMb: 6144, totalMb: 8000, requestedMb: 32768 }).maxMb, 5120);
assert.equal(resolveGameMemory({ recommendedMb: 6144, totalMb: 8000, requestedMb: 100 }).maxMb, 2048);
assert.equal(resolveGameMemory({ recommendedMb: 6144, totalMb: 8000, requestedMb: 3500 }).maxMb, 3072);
for (const totalMb of [2000, 4096, 8000, 16384, 65536]) {
  for (const requestedMb of [null, 1, 2048, 5000, 99999]) {
    const memory = resolveGameMemory({ recommendedMb: 6144, totalMb, requestedMb });
    assert.ok(memory.minMb <= memory.maxMb && memory.maxMb >= 2048 && memory.maxMb <= 16384, JSON.stringify({ totalMb, requestedMb, memory }));
  }
}

console.log("game-memory=passed");
