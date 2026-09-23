import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import * as yauzl from "yauzl";
import type { LoaderKind, MrpackSource, PackFile, SyncProgress } from "../shared/types.js";
import { fetchWithSystemNetwork } from "./system-network.js";

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

export interface PreparedMrpack {
  files: PackFile[];
  applyOverrides(instanceDir: string, progress: ProgressSink): Promise<void>;
}

/** Downloads only a hash-pinned archive, then accepts only safe, indexed client files. */
export async function prepareMrpack(source: MrpackSource, instanceDir: string, progress: ProgressSink, expected: { minecraftVersion: string; loader: { kind: LoaderKind; version: string } }): Promise<PreparedMrpack> {
  if (!/^https:\/\//.test(source.url) || !Number.isSafeInteger(source.size) || source.size < 1 || !/^[a-f0-9]{128}$/i.test(source.sha512)) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
  }
  const archiveDir = path.join(instanceDir, ".bweeep", "mrpack");
  const archivePath = path.join(archiveDir, `${source.sha512}.mrpack`);
  await fsp.mkdir(archiveDir, { recursive: true });
  if (!(await matchesSha512(archivePath, source.sha512))) {
    progress({ kind: "download", stage: "모드팩", message: "모드팩 목록을 내려받는 중" });
    const response = await fetchWithSystemNetwork(source.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("모드팩을 내려받지 못했습니다.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== source.size || sha512(bytes) !== source.sha512) {
      throw new Error("모드팩 검증에 실패했습니다.");
    }
    await fsp.writeFile(archivePath, bytes);
  }

  const entries = await readArchive(archivePath);
  const indexBytes = entries.get("modrinth.index.json");
  if (!indexBytes) throw new Error("모드팩의 Modrinth 목록을 찾지 못했습니다.");
  const index = parseIndex(indexBytes, expected);
  const files = index.files.map((entry) => ({
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

async function applyOverrides(instanceDir: string, entries: Map<string, Buffer>, progress: ProgressSink): Promise<void> {
  const recordPath = path.join(instanceDir, ".bweeep", "mrpack-overrides.json");
  const next = new Set<string>();
  for (const [entryPath, bytes] of entries) {
    const relative = entryPath.slice("overrides/".length);
    if (!safeRelativePath(relative)) throw new Error("모드팩 override 경로가 안전하지 않습니다.");
    const target = path.resolve(instanceDir, relative);
    next.add(relative);
    // Never replace a player's launcher and server-list preferences after first install.
    if ((relative === "options.txt" || relative === "servers.dat") && await exists(target)) continue;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, bytes);
    progress({ kind: "info", stage: "모드팩", message: `기본 설정 적용: ${relative}`, filePath: relative });
  }
  const previous = await readPaths(recordPath);
  for (const relative of previous) {
    if (next.has(relative)) continue;
    await fsp.rm(path.resolve(instanceDir, relative), { force: true });
  }
  await fsp.mkdir(path.dirname(recordPath), { recursive: true });
  await fsp.writeFile(recordPath, JSON.stringify([...next].sort(), null, 2), "utf8");
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

function sha512(bytes: Buffer): string { return crypto.createHash("sha512").update(bytes).digest("hex"); }

async function matchesSha512(filePath: string, expected: string): Promise<boolean> {
  try { return sha512(await fsp.readFile(filePath)) === expected; } catch { return false; }
}

async function exists(filePath: string): Promise<boolean> {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function readPaths(filePath: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && safeRelativePath(item)) : [];
  } catch { return []; }
}
