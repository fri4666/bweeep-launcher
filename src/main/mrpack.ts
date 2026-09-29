import fsp from "node:fs/promises";
import path from "node:path";
import * as yauzl from "yauzl";
import type { LoaderKind, MrpackSource, PackFile, SyncProgress } from "../shared/types.js";
import { fetchWithSystemNetwork } from "./system-network.js";
import { hashBytes, hashFile } from "./hash.js";
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

/** Downloads only a hash-pinned archive, then accepts only safe, indexed client files. */
export async function prepareMrpack(
  source: MrpackSource,
  instanceDir: string,
  progress: ProgressSink,
  expected: { minecraftVersion: string; loader: { kind: LoaderKind; version: string } },
  options: { fetch?: Fetcher; cache?: HashCache } = {}
): Promise<PreparedMrpack> {
  if (!/^https:\/\//.test(source.url) || !Number.isSafeInteger(source.size) || source.size < 1 || !/^[a-f0-9]{128}$/i.test(source.sha512)) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
  }
  const archiveDir = path.join(instanceDir, ".bweeep", "mrpack");
  const archiveName = `${source.sha512}.mrpack`;
  const archivePath = path.join(archiveDir, archiveName);
  const cacheKey = `.bweeep/mrpack/${archiveName}`;
  await fsp.mkdir(archiveDir, { recursive: true });
  const cached = options.cache
    ? await options.cache.matches(cacheKey, archivePath, { size: source.size, sha512: source.sha512 })
    : await matchesSha512(archivePath, source.sha512);
  if (!cached) {
    progress({ kind: "download", stage: "모드팩 목록", message: "받는 중", completed: 0, total: source.size, unit: "bytes" });
    try {
      await downloadVerified({ url: source.url, target: archivePath, size: source.size, sha512: source.sha512 }, {
        fetch: options.fetch ?? fetchWithSystemNetwork,
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

  const entries = await readArchive(archivePath);
  const indexBytes = entries.get("modrinth.index.json");
  if (!indexBytes) throw new Error("모드팩의 Modrinth 목록을 찾지 못했습니다.");
  const index = parseIndex(indexBytes, expected);
  const files = index.files.filter((entry) => !isServerList(entry.path)).map((entry) => ({
    path: entry.path,
    size: entry.fileSize,
    sha512: entry.hashes.sha512!,
    url: entry.downloads[0]
  }));
  const overrides = new Map([...entries].filter(([entryPath]) => entryPath.startsWith("overrides/") && !entryPath.endsWith("/")));
  return { files, applyOverrides: (root, sink) => applyOverrides(root, overrides, sink) };
}

function parseIndex(bytes: Buffer, expected: { minecraftVersion: string; loader: { kind: LoaderKind; version: string } }): MrpackIndex {
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
 */
async function applyOverrides(instanceDir: string, entries: Map<string, Buffer>, progress: ProgressSink): Promise<void> {
  const recordPath = path.join(instanceDir, ".bweeep", "mrpack-overrides.json");
  const previous = await readOverrideRecord(recordPath);
  const next = new Map<string, string | null>();
  const total = [...entries.keys()].filter((entryPath) => !isServerList(entryPath.slice("overrides/".length))).length;
  let completed = 0;
  let written = 0;
  let kept = 0;
  for (const [entryPath, bytes] of entries) {
    const relative = entryPath.slice("overrides/".length);
    if (!safeRelativePath(relative)) throw new Error("모드팩 override 경로가 안전하지 않습니다.");
    if (isServerList(relative)) continue;
    const target = path.resolve(instanceDir, relative);
    const packHash = hashBytes("sha256", bytes);
    const current = await sha256IfFile(target);
    const lastWritten = previous.get(relative) ?? null;
    completed += 1;
    // Never replace a player's controls and video preferences after first install.
    if (relative === "options.txt" && current !== null) {
      next.set(relative, lastWritten);
      continue;
    }
    if (current === packHash) {
      next.set(relative, packHash);
    } else if (current === null || (lastWritten !== null && current === lastWritten)) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, bytes);
      next.set(relative, packHash);
      written += 1;
      if (written === 1 || written % 25 === 0) {
        progress({ kind: "info", stage: "모드팩 기본 설정", message: `적용: ${relative}`, completed, total, unit: "files", filePath: relative });
      }
    } else {
      next.set(relative, lastWritten);
      kept += 1;
    }
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
}

async function readArchive(archivePath: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("모드팩 압축 파일을 열지 못했습니다."));
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith("/")) return zip.readEntry();
        if (!safeRelativePath(entry.fileName)) return reject(new Error("모드팩 압축 경로가 안전하지 않습니다."));
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("모드팩 파일을 읽지 못했습니다."));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("error", reject);
          stream.on("end", () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
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
