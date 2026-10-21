import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import type { LoaderKind, MrpackSource, PackFile, SyncProgress } from "../shared/types.js";
import { fetchViaDirectSession, fetchWithSystemNetwork } from "./system-network.js";
import { hashFile } from "./hash.js";
import { downloadVerified, runLimited, type Fetcher } from "./download.js";
import type { HashCache } from "./hash-cache.js";

type ProgressSink = (event: SyncProgress) => void;

interface MrpackIndex {
  formatVersion: number;
  dependencies: Record<string, string>;
  files: Array<{
    path: string;
    hashes: { sha512?: string };
    downloads: string[];
    fileSize: number;
  }>;
}

interface PreparedMrpack {
  files: PackFile[];
  applyOverrides(instanceDir: string, progress: ProgressSink): Promise<void>;
}

type Expected = { minecraftVersion: string; loader: { kind: LoaderKind; version: string } };

/**
 * What the last complete run settled for one archive. While the archive is the
 * same one, a launch needs neither the archive nor its (often hundreds of
 * megabytes of) override files: the mod list is kept here and the overrides
 * were already applied.
 */
interface MrpackState {
  version: 1;
  archive: string;
  minecraftVersion: string;
  loader: { kind: LoaderKind; version: string };
  files: PackFile[];
  /** Override paths (relative to the instance) that were applied for this archive. */
  overrides: string[];
}

/** Overrides up to this size are read into memory; bigger ones are streamed to a temporary file. */
const SMALL_ENTRY_BYTES = 2 * 1024 * 1024;
/** Matches the index limit used by the install-bundle builder. */
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const OVERRIDE_CONCURRENCY = 4;

/** Downloads only a hash-pinned archive, then accepts only safe, indexed client files. */
export async function prepareMrpack(
  source: MrpackSource,
  instanceDir: string,
  progress: ProgressSink,
  expected: Expected,
  options: { fetch?: Fetcher; cache?: HashCache } = {}
): Promise<PreparedMrpack> {
  if (!/^https:\/\//.test(source.url) || !Number.isSafeInteger(source.size) || source.size < 1 || !/^[a-f0-9]{128}$/i.test(source.sha512)) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
  }
  const archiveDir = path.join(instanceDir, ".bweeep", "mrpack");
  const archiveName = `${source.sha512}.mrpack`;
  const archivePath = path.join(archiveDir, archiveName);
  const cacheKey = `.bweeep/mrpack/${archiveName}`;
  const statePath = path.join(instanceDir, ".bweeep", "mrpack-state.json");

  // Same archive: check only that the defaults still exist. A missing default
  // needs that entry again, not another read/hash of every installed default.
  const state = await readState(statePath);
  const missing = state && stateIsCurrent(state, source, expected)
    ? await missingOverrides(instanceDir, state.overrides)
    : null;
  if (state && missing?.length === 0) {
    return { files: state.files, applyOverrides: async () => undefined };
  }

  await fsp.mkdir(archiveDir, { recursive: true });
  const cached = options.cache
    ? await options.cache.matches(cacheKey, archivePath, { size: source.size, sha512: source.sha512 })
    : await matchesSha512(archivePath, source.sha512);
  if (!cached) {
    progress({ kind: "download", stage: "모드팩 목록", message: "받는 중", completed: 0, total: source.size, unit: "bytes" });
    try {
      await downloadVerified({ url: source.url, target: archivePath, size: source.size, sha512: source.sha512 }, {
        fetch: options.fetch ?? fetchWithSystemNetwork,
        fallbackFetch: options.fetch ? undefined : fetchViaDirectSession,
        onBytes: (received) => progress({ kind: "download", stage: "모드팩 목록", message: "받는 중", completed: received, total: source.size, unit: "bytes" })
      });
    } catch (error) {
      throw new Error("모드팩을 내려받지 못했습니다.", { cause: error });
    }
    if (options.cache) {
      await options.cache.remember(cacheKey, archivePath, "sha512", source.sha512);
      await options.cache.save();
    }
  }

  const { entries: listing, indexBytes } = await readArchive(archivePath);
  if (!indexBytes) throw new Error("모드팩의 Modrinth 목록을 찾지 못했습니다.");
  const index = parseIndex(indexBytes, expected);
  const files = index.files.filter((entry) => !isServerList(entry.path)).map((entry) => ({
    path: entry.path,
    size: entry.fileSize,
    sha512: entry.hashes.sha512!,
    url: entry.downloads[0]
  }));
  const overrides = listing.filter((entry) => entry.fileName.startsWith("overrides/"));
  const repair = missing ? new Set(missing) : undefined;
  const overrideNames = new Set(overrides.map((entry) => entry.fileName.slice("overrides/".length)));
  if (repair && [...repair].some((relative) => !overrideNames.has(relative))) {
    throw new Error("저장된 모드팩 기본 설정 목록이 압축 파일과 일치하지 않습니다.");
  }
  return {
    files,
    applyOverrides: async (root, sink) => {
      const applied = await applyOverrides(root, archivePath, overrides, sink, repair);
      await writeState(statePath, { version: 1, archive: source.sha512.toLowerCase(), minecraftVersion: expected.minecraftVersion, loader: expected.loader, files, overrides: applied });
      // Older archives are never needed again: a launch with the same archive does not open it.
      await removeOtherArchives(archiveDir, archiveName);
    }
  };
}

function stateIsCurrent(state: MrpackState, source: MrpackSource, expected: Expected): boolean {
  return state.archive === source.sha512.toLowerCase() &&
    state.minecraftVersion === expected.minecraftVersion &&
    state.loader.kind === expected.loader.kind && state.loader.version === expected.loader.version;
}

async function missingOverrides(instanceDir: string, relativePaths: string[]): Promise<string[]> {
  const missing: string[] = [];
  const parents = new Map<string, string[]>();
  for (const relative of relativePaths) {
    const parent = path.dirname(resolveOverridePath(instanceDir, relative));
    const children = parents.get(parent) ?? [];
    children.push(relative);
    parents.set(parent, children);
  }
  await runLimited([...parents], 8, async ([parent, relatives]) => {
    let entries: Map<string, fs.Dirent>;
    try {
      entries = new Map((await fsp.readdir(parent, { withFileTypes: true })).map((entry) => [entry.name, entry]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(...relatives);
      return;
    }
    for (const relative of relatives) {
      const entry = entries.get(path.basename(relative));
      if (!entry) {
        // Windows directories can be case-sensitive too. Only an exact name
        // is conclusive; stat resolves a differently cased candidate according
        // to this directory's actual rules on every platform.
        const folded = path.basename(relative).toLowerCase();
        if ([...entries.keys()].some((name) => name.toLowerCase() === folded)) {
          try {
            const stat = await fsp.stat(resolveOverridePath(instanceDir, relative));
            if (!stat.isFile()) throw new Error(`모드팩 기본 설정 경로가 파일이 아닙니다: ${relative}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing.push(relative);
          }
        } else missing.push(relative);
      } else if (!entry.isFile()) {
        // Follow file symlinks just as stat() did; directory and dangling links
        // must not make an installation look complete.
        try {
          const stat = await fsp.stat(resolveOverridePath(instanceDir, relative));
          if (!stat.isFile()) throw new Error(`모드팩 기본 설정 경로가 파일이 아닙니다: ${relative}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missing.push(relative);
        }
      }
    }
  });
  return missing;
}

async function readState(statePath: string): Promise<MrpackState | null> {
  try {
    const value = JSON.parse(await fsp.readFile(statePath, "utf8")) as Partial<MrpackState>;
    const ok = value.version === 1 && typeof value.archive === "string" && typeof value.minecraftVersion === "string" &&
      typeof value.loader?.kind === "string" && typeof value.loader.version === "string" &&
      Array.isArray(value.files) && value.files.every(isPackFile) &&
      Array.isArray(value.overrides) && value.overrides.every((item) => typeof item === "string" && safeRelativePath(item));
    return ok ? value as MrpackState : null;
  } catch {
    return null;
  }
}

function isPackFile(value: unknown): value is PackFile {
  const file = value as Partial<PackFile> | null;
  return Boolean(file) && typeof file!.path === "string" && safeRelativePath(file!.path) && typeof file!.url === "string" &&
    Number.isSafeInteger(file!.size) && (typeof file!.sha256 === "string" || typeof file!.sha512 === "string");
}

async function writeState(statePath: string, state: MrpackState): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state), "utf8");
  await fsp.rename(temp, statePath);
}

async function removeOtherArchives(archiveDir: string, keepName: string): Promise<void> {
  try {
    for (const name of await fsp.readdir(archiveDir)) {
      if (name !== keepName && /\.mrpack(\.part)?$/.test(name)) await fsp.rm(path.join(archiveDir, name), { force: true });
    }
  } catch {
    // Housekeeping only; a leftover archive costs disk space, not correctness.
  }
}

function parseIndex(bytes: Buffer, expected: Expected): MrpackIndex {
  let value: MrpackIndex;
  try {
    value = JSON.parse(bytes.toString("utf8")) as MrpackIndex;
  } catch {
    throw new Error("모드팩 목록 형식이 올바르지 않습니다.");
  }
  const loaderKey = expected.loader.kind === "fabric" ? "fabric-loader" : expected.loader.kind;
  if (value.formatVersion !== 1 || !Array.isArray(value.files) || value.dependencies?.minecraft !== expected.minecraftVersion || value.dependencies?.[loaderKey] !== expected.loader.version) {
    throw new Error("모드팩의 Minecraft 또는 로더 정보가 매니페스트와 일치하지 않습니다.");
  }
  for (const file of value.files) {
    if (!safeRelativePath(file.path) || !Number.isSafeInteger(file.fileSize) || file.fileSize < 0 || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 ?? "") || !Array.isArray(file.downloads) || file.downloads.length !== 1 || !file.downloads[0].startsWith("https://")) {
      throw new Error("모드팩 파일 정보가 안전하지 않습니다.");
    }
  }
  return value;
}

/**
 * Pack defaults (mostly config files) are written as the pack ships them, but
 * a file the player changed is never overwritten or removed. The record keeps
 * the hash of what the launcher last wrote to each path: a file that still has
 * that hash is untouched and follows pack updates; one that differs is the
 * player's. Paths from an older launcher's record (no hashes) count as the
 * player's unless they already equal the pack's copy.
 *
 * A bounded number of entries are handled together: small ones in memory, big
 * ones streamed to temporary files, so the archive is never held whole.
 * Returns the override paths that belong to this archive.
 */
async function applyOverrides(instanceDir: string, archivePath: string, entries: yauzl.Entry[], progress: ProgressSink, repair?: Set<string>): Promise<string[]> {
  const recordPath = path.join(instanceDir, ".bweeep", "mrpack-overrides.json");
  const tempDir = path.join(instanceDir, ".bweeep", "mrpack-tmp");
  const previous = await readOverrideRecord(recordPath);
  // Repairing one deleted default must not drop the rest of the saved hashes
  // or treat the other defaults as files removed by a pack update.
  const next = repair ? new Map(previous) : new Map<string, string | null>();
  const wanted = new Map<string, yauzl.Entry>();
  for (const entry of entries) {
    const relative = entry.fileName.slice("overrides/".length);
    if (!safeRelativePath(relative)) throw new Error("모드팩 override 경로가 안전하지 않습니다.");
    if (!isServerList(relative)) wanted.set(entry.fileName, entry);
  }
  const selected = entries.filter((entry) => wanted.has(entry.fileName) && (!repair || repair.has(entry.fileName.slice("overrides/".length))));
  const total = selected.length;
  let completed = 0;
  let written = 0;
  let kept = 0;
  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });
  const directories = new Map<string, Promise<unknown>>();
  const ensureParent = (target: string) => {
    const parent = path.dirname(target);
    let pending = directories.get(parent);
    if (!pending) {
      pending = fsp.mkdir(parent, { recursive: true });
      directories.set(parent, pending);
    }
    return pending;
  };
  try {
    await withArchive(archivePath, async (zip) => processEntries(selected, async (entry) => {
      const relative = entry.fileName.slice("overrides/".length);
      const target = resolveOverridePath(instanceDir, relative);
      // A mod/player may have recreated it after the initial existence check.
      if (repair && (await missingOverrides(instanceDir, [relative])).length === 0) {
        completed += 1;
        return;
      }
      const copy = await readEntryCopy(entry, () => openEntry(zip, entry), tempDir);
      try {
        const current = await sha256IfFile(target);
        const lastWritten = previous.get(relative) ?? null;
        completed += 1;
        // Never replace a player's controls and video preferences after first install.
        if (relative === "options.txt" && current !== null) {
          next.set(relative, lastWritten);
        } else if (current === copy.sha256) {
          next.set(relative, copy.sha256);
        } else if (current === null || (lastWritten !== null && current === lastWritten)) {
          await ensureParent(target);
          await copy.writeTo(target);
          next.set(relative, copy.sha256);
          written += 1;
          if (written === 1 || written % 25 === 0) {
            progress({ kind: "info", stage: "모드팩 기본 설정", message: `적용: ${relative}`, completed, total, unit: "files", filePath: relative });
          }
        } else {
          next.set(relative, lastWritten);
          kept += 1;
        }
      } finally {
        await copy.discard();
      }
    }));
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
  // Defaults the pack dropped are removed only while nobody changed them.
  if (!repair) {
    for (const [relative, lastWritten] of previous) {
      if (next.has(relative) || lastWritten === null) continue;
      const target = resolveOverridePath(instanceDir, relative);
      if (await sha256IfFile(target) === lastWritten) await fsp.rm(target, { force: true });
    }
  }
  await fsp.mkdir(path.dirname(recordPath), { recursive: true });
  await fsp.writeFile(recordPath, JSON.stringify({ version: 2, files: Object.fromEntries([...next].sort(([a], [b]) => a.localeCompare(b))) }, null, 2), "utf8");
  progress({ kind: "info", stage: "모드팩 기본 설정", message: kept > 0 ? `적용 ${written}개 · 내 설정 ${kept}개 유지` : `적용 ${written}개`, completed: total, total, unit: "files" });
  return [...wanted.keys()].map((name) => name.slice("overrides/".length));
}

/** One archive entry's content, hashed and ready to be put in place (or thrown away). */
interface EntryCopy {
  sha256: string;
  writeTo(target: string): Promise<void>;
  discard(): Promise<void>;
}

async function readEntryCopy(entry: yauzl.Entry, open: () => Promise<Readable>, tempDir: string): Promise<EntryCopy> {
  if (entry.uncompressedSize <= SMALL_ENTRY_BYTES) {
    const bytes = await collect(await open(), SMALL_ENTRY_BYTES);
    return {
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      writeTo: (target) => fsp.writeFile(target, bytes),
      discard: async () => undefined
    };
  }
  const temp = path.join(tempDir, `${crypto.randomUUID()}.part`);
  const hash = crypto.createHash("sha256");
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(await open(), hasher, fs.createWriteStream(temp));
  return {
    sha256: hash.digest("hex"),
    writeTo: async (target) => {
      try {
        await fsp.rename(temp, target);
      } catch (error) {
        // The target folder can be a junction onto another drive.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await fsp.copyFile(temp, target);
      }
    },
    discard: () => fsp.rm(temp, { force: true })
  };
}

/** Read the directory and index once; retained entries also locate their data. */
async function readArchive(archivePath: string): Promise<{ entries: yauzl.Entry[]; indexBytes: Buffer | null }> {
  const entries: yauzl.Entry[] = [];
  let indexBytes: Buffer | null = null;
  await walkArchive(archivePath, async (entry, open) => {
    if (!safeRelativePath(entry.fileName)) throw new Error("모드팩 압축 경로가 안전하지 않습니다.");
    entries.push(entry);
    if (entry.fileName === "modrinth.index.json" && indexBytes === null) {
      if (entry.uncompressedSize > MAX_INDEX_BYTES) throw new Error("모드팩 목록이 허용 크기를 초과합니다.");
      indexBytes = await collect(await open(), MAX_INDEX_BYTES);
    }
  });
  return { entries, indexBytes };
}

/** Reads a whole entry stream. yauzl's streams are consumed with events; async iteration on them never finishes. */
function collect(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      // yauzl's destroy() stops decompression but does not emit a supplied error.
      reject(error);
      stream.destroy();
    };
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) return fail(new Error("모드팩 압축 항목이 허용 크기를 초과합니다."));
      chunks.push(Buffer.from(chunk));
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
  });
}

/** ZIP metadata is visited once; file data is opened later using these entries. */
async function walkArchive(
  archivePath: string,
  onEntry: (entry: yauzl.Entry, open: () => Promise<Readable>) => Promise<void>
): Promise<void> {
  await withArchive(archivePath, async (zip) => {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        onEntry(entry, () => openEntry(zip, entry)).then(() => zip.readEntry(), reject);
      });
      zip.readEntry();
    });
  });
}

/** Bounded file work; aliases of one destination keep their archive order. */
async function processEntries(entries: yauzl.Entry[], worker: (entry: yauzl.Entry) => Promise<void>): Promise<void> {
  const byPath = new Map<string, Promise<void>>();
  let failure: unknown = null;
  await runLimited(entries, OVERRIDE_CONCURRENCY, async (entry) => {
    const normalized = path.normalize(entry.fileName);
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    const previous = byPath.get(key);
    const task = (async () => {
      await previous;
      if (failure === null) {
        try { await worker(entry); } catch (error) { failure ??= error; throw error; }
      }
    })();
    byPath.set(key, task);
    try { await task; } finally { if (byPath.get(key) === task) byPath.delete(key); }
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error("모드팩 파일을 읽지 못했습니다.")) : resolve(stream));
  });
}

async function withArchive<T>(archivePath: string, work: (zip: yauzl.ZipFile) => Promise<T>): Promise<T> {
  const file = await fsp.open(archivePath, "r");
  let zip: yauzl.ZipFile;
  try {
    const reader = new CachedArchiveReader(file, (await file.stat()).size);
    zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromRandomAccessReader(reader, reader.size, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false }, (error, opened) => {
        if (error || !opened) reject(error ?? new Error("모드팩 압축 파일을 열지 못했습니다."));
        else resolve(opened);
      });
    });
  } catch (error) {
    await file.close();
    throw error;
  }
  try { return await work(zip); } finally {
    await new Promise<void>((resolve, reject) => {
      zip.once("close", resolve);
      zip.once("error", reject);
      zip.close();
    });
  }
}

/**
 * Yauzl still validates ZIP/ZIP64 and entry sizes. A 1 MiB read cache combines
 * its many tiny directory/header reads; the whole archive is never buffered.
 */
class CachedArchiveReader extends yauzl.RandomAccessReader {
  private readonly blocks = new Map<number, Promise<Buffer>>();
  private static readonly BLOCK_BYTES = 128 * 1024;
  private static readonly MAX_BLOCKS = 8;

  constructor(private readonly file: fsp.FileHandle, readonly size: number) { super(); }

  override _readStreamForRange(start: number, end: number): Readable {
    const self = this;
    return Readable.from((async function* () {
      for (let position = start; position < end;) {
        const blockStart = Math.floor(position / CachedArchiveReader.BLOCK_BYTES) * CachedArchiveReader.BLOCK_BYTES;
        const bytes = await self.block(blockStart);
        const offset = position - blockStart;
        const length = Math.min(bytes.length - offset, end - position);
        if (length <= 0) throw new Error("모드팩 압축 파일이 예기치 않게 끝났습니다.");
        yield bytes.subarray(offset, offset + length);
        position += length;
      }
    })(), { objectMode: false });
  }

  private block(start: number): Promise<Buffer> {
    let pending = this.blocks.get(start);
    if (pending) {
      this.blocks.delete(start);
    } else {
      pending = (async () => {
        const bytes = Buffer.allocUnsafe(Math.min(CachedArchiveReader.BLOCK_BYTES, Math.max(0, this.size - start)));
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await this.file.read(bytes, offset, bytes.length - offset, start + offset);
          if (bytesRead === 0) throw new Error("모드팩 압축 파일이 예기치 않게 끝났습니다.");
          offset += bytesRead;
        }
        return bytes;
      })();
    }
    this.blocks.set(start, pending);
    if (this.blocks.size > CachedArchiveReader.MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value!);
    return pending;
  }

  override close(callback: (error: Error | null) => void): void {
    this.blocks.clear();
    this.file.close().then(() => callback(null), (error: Error) => callback(error));
  }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0:]/.test(value) &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && value.split(/[\\/]+/).every((part) =>
      // Win32 trims dots/spaces and resolves DOS devices even with extensions.
      // Keep exact '.' aliases, whose archive order is intentionally supported.
      part !== ".." && (part === "." || !/[. ]$/.test(part)) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$) *(?:\.|$)/i.test(part));
}

function resolveOverridePath(instanceDir: string, relative: string): string {
  if (!safeRelativePath(relative)) throw new Error("모드팩 override 경로가 안전하지 않습니다.");
  const root = path.resolve(instanceDir);
  const target = path.resolve(root, relative);
  const inside = path.relative(root, target);
  if (!inside || path.isAbsolute(inside) || inside === ".." || inside.startsWith(`..${path.sep}`)) {
    throw new Error("모드팩 override 경로가 안전하지 않습니다.");
  }
  return target;
}

function isServerList(value: string): boolean {
  return /^servers\.dat(?:_old)?$/i.test(value);
}

async function matchesSha512(filePath: string, expected: string): Promise<boolean> {
  try { return await hashFile(filePath, "sha512") === expected.toLowerCase(); } catch { return false; }
}

async function sha256IfFile(filePath: string): Promise<string | null> {
  try {
    return await hashFile(filePath, "sha256");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw error;
  }
}

/** Path → hash the launcher last wrote there; null when not known (older record format). */
export async function readOverrideRecord(filePath: string): Promise<Map<string, string | null>> {
  let value: unknown;
  try {
    value = JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return new Map();
  }
  const record = new Map<string, string | null>();
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string" && safeRelativePath(item)) record.set(item, null);
    return record;
  }
  const files = value && typeof value === "object" ? (value as { files?: unknown }).files : null;
  if (files && typeof files === "object") {
    for (const [item, hash] of Object.entries(files as Record<string, unknown>)) {
      if (!safeRelativePath(item)) continue;
      record.set(item, typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) ? hash : null);
    }
  }
  return record;
}
