// Cached, hash-pinned fixture archives only; no launcher, game, or network access.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { strToU8, zipSync } from "fflate";
import * as yauzl from "yauzl";

const { prepareMrpack, readOverrideRecord } = await import(process.env.BWEEP_MRPACK_MODULE ?? "../dist/src/main/mrpack.js");
assert.equal(process.platform, "linux", "Run these Windows-name fixtures in WSL so baseline regressions cannot access Windows devices or drives.");
const root = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-mrpack-security-"));
const expected = { minecraftVersion: "1.20.1", loader: { kind: "forge", version: "47.4.0" } };
const index = { formatVersion: 1, dependencies: { minecraft: expected.minecraftVersion, forge: expected.loader.version }, files: [] };
const quiet = () => undefined;
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
const stateAt = (instance) => path.join(instance, ".bweeep", "mrpack-state.json");
const recordAt = (instance) => path.join(instance, ".bweeep", "mrpack-overrides.json");
const exists = (file) => fsp.access(file).then(() => true, () => false);
let serial = 0;
let passed = 0;
let failed = 0;

async function check(name, run) {
  const originalOpen = fsp.open;
  const openArchives = new Set();
  fsp.open = async function (target, flags, ...args) {
    const file = await originalOpen.call(this, target, flags, ...args);
    if (flags === "r" && String(target).endsWith(".mrpack")) {
      openArchives.add(file);
      const close = file.close.bind(file);
      file.close = async () => { await close(); openArchives.delete(file); };
    }
    return file;
  };
  try {
    await run();
    assert.equal(openArchives.size, 0, "all archive handles close before settling");
    passed += 1;
    console.log(`${name}=passed`);
  } catch (error) {
    failed += 1;
    console.error(`${name}=FAILED: ${error.stack ?? error}`);
  } finally {
    fsp.open = originalOpen;
  }
}

function archive(overrides = {}, indexBytes = Buffer.from(JSON.stringify(index))) {
  return Buffer.from(zipSync({
    "modrinth.index.json": indexBytes,
    ...Object.fromEntries(Object.entries(overrides).map(([name, bytes]) => [`overrides/${name}`, typeof bytes === "string" ? strToU8(bytes) : bytes]))
  }, { level: 6, mtime: "2026-01-01T00:00:00Z" }));
}

async function fixture(bytes) {
  const instance = path.join(root, String(++serial));
  const digest = hash("sha512", bytes);
  const archiveDir = path.join(instance, ".bweeep", "mrpack");
  await fsp.mkdir(archiveDir, { recursive: true });
  await fsp.writeFile(path.join(archiveDir, `${digest}.mrpack`), bytes);
  const source = { url: "https://example.invalid/fixture.mrpack", size: bytes.length, sha512: digest };
  const prepare = () => prepareMrpack(source, instance, quiet, expected, { fetch: async () => { throw new Error("Unexpected network access"); } });
  return { instance, source, prepare, apply: async () => (await prepare()).applyOverrides(instance, quiet) };
}

function paddedIndex(size) {
  const empty = JSON.stringify({ ...index, padding: "" });
  return Buffer.from(JSON.stringify({ ...index, padding: "x".repeat(size - Buffer.byteLength(empty)) }));
}

// The production yauzl stream's destroy() ignores an error argument. Mirror that
// behavior so byte-limit rejection cannot depend on destroy(error) emitting it.
function syntheticStream(bytes, onDestroy) {
  const chunks = (function* () {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
  })();
  const stream = Readable.from(chunks, { objectMode: false });
  const destroy = stream.destroy.bind(stream);
  stream.destroy = () => { onDestroy(); return destroy(); };
  return stream;
}

async function withEntryStream(name, bytes, run) {
  const original = yauzl.ZipFile.prototype.openReadStream;
  let destroyed = false;
  let synthetic;
  yauzl.ZipFile.prototype.openReadStream = function (entry, ...args) {
    if (entry.fileName !== name) return original.call(this, entry, ...args);
    synthetic = syntheticStream(bytes, () => { destroyed = true; });
    args.at(-1)(null, synthetic);
  };
  let timer;
  const pending = run(() => destroyed);
  try {
    await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("entry byte-limit rejection timed out")), 10_000); })]);
  } finally {
    clearTimeout(timer);
    // Release a hanging collector too, so a failed regression leaves no handle.
    synthetic?.emit("error", new Error("synthetic stream finished"));
    await pending.catch(() => undefined);
    yauzl.ZipFile.prototype.openReadStream = original;
  }
}

const unsafe = [
  "C:outside.txt", "c:folder/outside.txt", "C:/outside.txt", "config/options.txt:stream",
  "/absolute.txt", "\\rooted.txt", "\\\\server\\share\\file", "\\\\?\\C:\\file",
  "../outside.txt", "config\\..\\outside.txt", "config/../../outside.txt", "null\0.txt",
  ".. /outside.txt", "config/.. /outside.txt", "config\\.. \\outside.txt", "config/. /outside.txt",
  "config/trailing./file.toml", "config/trailing /file.toml", "config/NUL", "config/Con.txt",
  "config/COM1.cfg", "config/lpt9.txt", "config/COM¹.cfg", "config/LPT³.cfg", "config/CONIN$", "config/CONOUT$.txt",
  "config/NUL .cfg", "config/COM1 .cfg", "config/CONOUT$ .txt"
];

try {
  for (const relative of unsafe) {
    await check(`mrpack-archive-rejects-${JSON.stringify(relative)}`, async () => {
      const item = await fixture(archive({ [relative]: "untrusted" }));
      await assert.rejects(item.apply());
      assert.equal(await exists(stateAt(item.instance)), false);
      assert.equal(await exists(recordAt(item.instance)), false);
    });
  }

  for (const format of ["legacy", "hashes"]) {
    await check(`mrpack-${format}-record-filters-all-unsafe-paths`, async () => {
      const item = await fixture(archive());
      const safe = ["config/정상.toml", "config/./alias.toml"];
      const paths = [...safe, ...unsafe];
      const record = format === "legacy" ? paths : { version: 2, files: Object.fromEntries(paths.map((name) => [name, hash("sha256", "old")])) };
      await fsp.writeFile(recordAt(item.instance), JSON.stringify(record));
      assert.deepEqual([...(await readOverrideRecord(recordAt(item.instance))).keys()], safe);
    });
  }

  for (const relative of ["C:folder/old.txt", "config/old.txt:stream"]) {
    await check(`mrpack-obsolete-cleanup-ignores-${JSON.stringify(relative)}`, async () => {
      const item = await fixture(archive({ "config/new.toml": "new" }));
      // On WSL these are harmless names inside the fixture. On Windows they
      // represent drive-relative paths or alternate data streams.
      const old = path.join(item.instance, relative);
      await fsp.mkdir(path.dirname(old), { recursive: true });
      await fsp.writeFile(old, "old");
      await fsp.writeFile(recordAt(item.instance), JSON.stringify({ version: 2, files: { [relative]: hash("sha256", "old") } }));
      await item.apply();
      assert.equal(await fsp.readFile(old, "utf8"), "old", "invalid records cannot authorize cleanup");
      assert.equal(await fsp.readFile(path.join(item.instance, "config/new.toml"), "utf8"), "new");
    });

    await check(`mrpack-saved-state-rejects-${JSON.stringify(relative)}`, async () => {
      const item = await fixture(archive({ "config/normal.toml": "normal" }));
      const old = path.join(item.instance, relative);
      await fsp.mkdir(path.dirname(old), { recursive: true });
      await fsp.writeFile(old, "old");
      await fsp.writeFile(stateAt(item.instance), JSON.stringify({ version: 1, archive: item.source.sha512, ...expected, files: [], overrides: [relative] }));
      const listings = [];
      const original = fsp.readdir;
      fsp.readdir = function (target, ...args) { listings.push(String(target)); return original.call(this, target, ...args); };
      try { await item.apply(); } finally { fsp.readdir = original; }
      assert.equal(listings.includes(path.dirname(old)), false, "invalid cached paths are never inspected");
      assert.equal(await fsp.readFile(path.join(item.instance, "config/normal.toml"), "utf8"), "normal");
      assert.deepEqual(JSON.parse(await fsp.readFile(stateAt(item.instance), "utf8")).overrides, ["config/normal.toml"]);
    });
  }

  await check("mrpack-saved-index-files-reject-drive-relative-path", async () => {
    const item = await fixture(archive());
    await fsp.writeFile(stateAt(item.instance), JSON.stringify({ version: 1, archive: item.source.sha512, ...expected, overrides: [], files: [{ path: "C:outside.jar", size: 0, sha512: "a".repeat(128), url: "https://example.invalid/mod.jar" }] }));
    assert.deepEqual((await item.prepare()).files, [], "invalid saved files must fall back to the pinned archive");
  });

  await check("mrpack-index-rejects-drive-relative-path", async () => {
    const files = [{ path: "C:outside.jar", fileSize: 0, hashes: { sha512: "a".repeat(128) }, downloads: ["https://example.invalid/mod.jar"] }];
    const item = await fixture(archive({}, Buffer.from(JSON.stringify({ ...index, files }))));
    await assert.rejects(item.prepare(), /안전하지/);
  });

  const maxIndexBytes = 16 * 1024 * 1024;
  await check("mrpack-index-exactly-16mib-remains-supported", async () => {
    const bytes = paddedIndex(maxIndexBytes);
    assert.equal(bytes.length, maxIndexBytes);
    const item = await fixture(archive({ "config/정상.toml": "normal" }, bytes));
    await item.apply();
    assert.equal(await fsp.readFile(path.join(item.instance, "config/정상.toml"), "utf8"), "normal");
  });

  await check("mrpack-index-declared-overflow-rejected-before-decompression", async () => {
    const item = await fixture(archive({ "config/untouched.toml": "untrusted" }, paddedIndex(maxIndexBytes + 1)));
    const original = yauzl.ZipFile.prototype.openReadStream;
    const opened = [];
    yauzl.ZipFile.prototype.openReadStream = function (entry, ...args) { opened.push(entry.fileName); return original.call(this, entry, ...args); };
    try { await assert.rejects(item.apply(), /허용 크기/); } finally { yauzl.ZipFile.prototype.openReadStream = original; }
    assert.deepEqual(opened, [], "oversized metadata is rejected before opening content");
    assert.equal(await exists(stateAt(item.instance)), false);
    assert.equal(await exists(path.join(item.instance, "config/untouched.toml")), false);
  });

  await check("mrpack-index-actual-overflow-explicitly-rejects-and-destroys", async () => {
    const item = await fixture(archive({ "config/untouched.toml": "untrusted" }));
    await withEntryStream("modrinth.index.json", paddedIndex(maxIndexBytes + 1), async (destroyed) => {
      await assert.rejects(item.apply(), /허용 크기/);
      assert.equal(destroyed(), true);
    });
    assert.equal(await exists(stateAt(item.instance)), false);
    assert.equal(await exists(path.join(item.instance, "config/untouched.toml")), false);
  });

  await check("mrpack-small-override-actual-overflow-is-bounded-and-cleaned", async () => {
    const item = await fixture(archive({ "config/small.toml": "small" }));
    await withEntryStream("overrides/config/small.toml", Buffer.alloc(2 * 1024 * 1024 + 1, 120), async (destroyed) => {
      await assert.rejects(item.apply(), /허용 크기/);
      assert.equal(destroyed(), true);
    });
    assert.equal(await exists(stateAt(item.instance)), false);
    assert.equal(await exists(recordAt(item.instance)), false);
    assert.equal(await exists(path.join(item.instance, "config/small.toml")), false);
    assert.equal(await exists(path.join(item.instance, ".bweeep", "mrpack-tmp")), false);
  });

  await check("mrpack-unicode-alias-order-player-edits-and-large-stream-remain-supported", async () => {
    const large = Buffer.alloc(3 * 1024 * 1024, 120);
    const item = await fixture(archive({ "config/정상.toml": "first", "config/./정상.toml": "second", "config/large.dat": large, "config/console.toml": "normal", "config/COM10.cfg": "normal" }));
    await item.apply();
    assert.equal(await fsp.readFile(path.join(item.instance, "config/정상.toml"), "utf8"), "first");
    assert.equal(hash("sha256", await fsp.readFile(path.join(item.instance, "config/large.dat"))), hash("sha256", large));
    assert.equal(await fsp.readFile(path.join(item.instance, "config/console.toml"), "utf8"), "normal");
    assert.equal(await fsp.readFile(path.join(item.instance, "config/COM10.cfg"), "utf8"), "normal");
    await fsp.writeFile(path.join(item.instance, "config/정상.toml"), "player");
    await item.apply();
    assert.equal(await fsp.readFile(path.join(item.instance, "config/정상.toml"), "utf8"), "player");
  });
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
console.log(`mrpack-security: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
