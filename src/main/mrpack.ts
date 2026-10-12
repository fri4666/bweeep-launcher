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
import { downloadVerified, type Fetcher } from "./download.js";
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

  // Same archive as the last complete run, nothing to apply: the archive is not even opened.
  // A default the player deleted is put back, so a missing override sends this launch the long way.
  const state = await readState(statePath);
  if (state && stateIsCurrent(state, source, expected) && await allExist(instanceDir, state.overrides)) {
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

  const listing = await listArchive(archivePath);
  const indexBytes = await readArchiveEntry(archivePath, "modrinth.index.json");
  if (!indexBytes) throw new Error("모드팩의 Modrinth 목록을 찾지 못했습니다.");
  const index = parseIndex(indexBytes, expected);
  const files = index.files.filter((entry) => !isServerList(entry.path)).map((entry) => ({
    path: entry.path,
    size: entry.fileSize,
    sha512: entry.hashes.sha512!,
    url: entry.downloads[0]
  }));
  const overrides = listing.filter((entry) => entry.name.startsWith("overrides/") && !entry.name.endsWith("/"));
  return {
    files,
    applyOverrides: async (root, sink) => {
      const applied = await applyOverrides(root, archivePath, overrides, sink);
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

async function allExist(instanceDir: string, relativePaths: string[]): Promise<boolean> {
  for (const relative of relativePaths) {
    try {
      await fsp.access(path.resolve(instanceDir, relative));
    } catch {
      return false;
    }
  }
  return true;
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
 * Entries are handled one at a time: small ones in memory, big ones (a world
 * folder, say) streamed to a temporary file, so the archive is never held whole.
 * Returns the override paths that belong to this archive.
 */
async function applyOverrides(instanceDir: string, archivePath: string, entries: ArchiveEntry[], progress: ProgressSink): Promise<string[]> {
  const recordPath = path.join(instanceDir, ".bweeep", "mrpack-overrides.json");
  const tempDir = path.join(instanceDir, ".bweeep", "mrpack-tmp");
  const previous = await readOverrideRecord(recordPath);
  const next = new Map<string, string | null>();
  const wanted = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    const relative = entry.name.slice("overrides/".length);
    if (!safeRelativePath(relative)) throw new Error("모드팩 override 경로가 안전하지 않습니다.");
    if (!isServerList(relative)) wanted.set(entry.name, entry);
  }
  const total = wanted.size;
  let completed = 0;
  let written = 0;
  let kept = 0;
  await fsp.rm(tempDir, { recursive: true, force: true });
  await fsp.mkdir(tempDir, { recursive: true });
  try {
    await walkArchive(archivePath, async (entry, open) => {
      if (!wanted.has(entry.fileName)) return;
      const relative = entry.fileName.slice("overrides/".length);
      const target = path.resolve(instanceDir, relative);
      const copy = await readEntryCopy(entry, open, tempDir);
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
          await fsp.mkdir(path.dirname(target), { recursive: true });
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
    });
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
  // Defaults the pack dropped are removed only while nobody changed them.
  for (const [relative, lastWritten] of previous) {
    if (next.has(relative) || lastWritten === null) continue;
    const target = path.resolve(instanceDir, relative);
    if (await sha256IfFile(target) === lastWritten) await fsp.rm(target, { force: true });
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
    const bytes = await collect(await open());
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

interface ArchiveEntry {
  name: string;
  size: number;
}

/** Entry names and sizes from the central directory; no file content is read. */
async function listArchive(archivePath: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await walkArchive(archivePath, async (entry) => {
    if (!safeRelativePath(entry.fileName)) throw new Error("모드팩 압축 경로가 안전하지 않습니다.");
    entries.push({ name: entry.fileName, size: entry.uncompressedSize });
  });
  return entries;
}

async function readArchiveEntry(archivePath: string, name: string): Promise<Buffer | null> {
  let found: Buffer | null = null;
  await walkArchive(archivePath, async (entry, open) => {
    if (entry.fileName !== name) return;
    found = await collect(await open());
    return "stop";
  });
  return found;
}

/** Reads a whole entry stream. yauzl's streams are consumed with events; async iteration on them never finishes. */
function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Visits the entries one at a time (the next is read after the handler finishes); the handler can end the walk early. */
async function walkArchive(
  archivePath: string,
  onEntry: (entry: yauzl.Entry, open: () => Promise<Readable>) => Promise<void | "stop">
): Promise<void> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false }, (error, opened) => {
      if (error || !opened) reject(error ?? new Error("모드팩 압축 파일을 열지 못했습니다."));
      else resolve(opened);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        const open = () => new Promise<Readable>((resolveStream, rejectStream) => {
          zip.openReadStream(entry, (error, stream) => (error || !stream ? rejectStream(error ?? new Error("모드팩 파일을 읽지 못했습니다.")) : resolveStream(stream)));
        });
        onEntry(entry, open).then((outcome) => (outcome === "stop" ? resolve() : zip.readEntry()), reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
}

function safeRelativePath(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
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
async function readOverrideRecord(filePath: string): Promise<Map<string, string | null>> {
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
