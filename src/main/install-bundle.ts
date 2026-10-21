import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import type { InitialInstallBundle, PackFile, SyncProgress } from "../shared/types.js";
import { downloadVerified, freeDiskBytes, runLimited, type Fetcher } from "./download.js";
import { hashFile } from "./hash.js";
import { isInitialInstallBundlePath } from "./manifest-validation.js";

export type InstallBundleSource = InitialInstallBundle;

export interface InstallBundleOptions {
  fetch: Fetcher;
  fallbackFetch?: Fetcher;
  tries?: number;
  retryDelayMs?: number;
  freeBytes?: (directory: string) => Promise<number | null>;
  /** Called only after a fully verified file lands; a later failure may leave these files committed. */
  onCommitted?: (file: PackFile) => Promise<void>;
}

type ProgressSink = (event: SyncProgress) => void;
const STAGE = "초기 모드팩 묶음";
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

/** Immutable pack downloads only. Personal settings/worlds and pack overrides are never bundled. */
export function isInstallBundleFile(file: Pick<PackFile, "path">): boolean {
  return isInitialInstallBundlePath(file.path);
}

/** A large initial install can trade hundreds of requests for one; small updates stay per-file. */
export function shouldUseInstallBundle(source: InstallBundleSource, files: PackFile[], needed: PackFile[]): boolean {
  let inventory: Map<string, PackFile>;
  try { inventory = bundleInventory(source, files); } catch { return false; }
  const eligible = [...inventory.values()];
  const missing = needed.filter((file) => inventory.has(file.path));
  const totalBytes = eligible.reduce((sum, file) => sum + file.size, 0);
  const missingBytes = missing.reduce((sum, file) => sum + file.size, 0);
  return missing.length >= 128 && missingBytes >= 32 * 1024 * 1024 && totalBytes > 0 &&
    missingBytes / totalBytes >= 0.65 && source.size <= missingBytes * 1.4;
}

/**
 * The outer pinned ZIP and every selected inner file are checked before the first replacement.
 * A network failure keeps its resumable .part. An extraction failure commits nothing. If a
 * commit fails, earlier verified files remain usable and the caller can re-check/fall back.
 */
export async function applyInstallBundle(
  source: InstallBundleSource,
  instanceDir: string,
  files: PackFile[],
  needed: PackFile[],
  progress: ProgressSink,
  options: InstallBundleOptions
): Promise<PackFile[]> {
  assertSource(source);
  const eligible = new Map(files.filter(isInstallBundleFile).map((file) => [file.path, file]));
  const inventory = bundleInventory(source, files);
  for (const file of inventory.values()) assertFile(file);
  const selected: PackFile[] = [];
  const selectedNames = new Set<string>();
  for (const file of needed.filter(isInstallBundleFile)) {
    const expected = eligible.get(file.path);
    if (!expected || !sameFile(expected, file) || selectedNames.has(file.path)) throw new Error("초기 묶음이 현재 모드팩 파일 목록과 일치하지 않습니다.");
    selectedNames.add(file.path);
    if (inventory.has(file.path)) selected.push(expected);
  }
  if (selected.length === 0) return [];
  const root = path.resolve(instanceDir);
  await ensureDirectory(root, root);
  const archiveDir = path.join(root, ".bweeep", "install-bundles");
  await ensureDirectory(root, archiveDir);
  const archivePath = path.join(archiveDir, `${source.sha512.toLowerCase()}.zip`);
  await rejectLink(archivePath);
  await rejectLink(`${archivePath}.part`);
  const cached = await matchesArchive(archivePath, source);
  const free = await (options.freeBytes ?? freeDiskBytes)(root);
  const required = (cached ? 0 : source.size) + selected.reduce((sum, file) => sum + file.size, 0) + DISK_MARGIN_BYTES;
  if (free !== null && free < required) throw new Error("초기 묶음을 풀 저장 공간이 부족합니다. 개별 파일 받기로 계속합니다.");
  if (!cached) {
    let lastReport = 0;
    await downloadVerified({ ...source, target: archivePath }, {
      fetch: options.fetch,
      fallbackFetch: options.fallbackFetch,
      tries: options.tries ?? 2,
      retryDelayMs: options.retryDelayMs,
      onBytes: (received) => {
        const now = Date.now();
        if (now - lastReport < 250 && received !== source.size) return;
        lastReport = now;
        progress({ kind: "download", stage: STAGE, message: "초기 모드팩 묶음 받는 중", completed: received, total: source.size, unit: "bytes" });
      }
    });
  }
  const staging = await fsp.mkdtemp(path.join(archiveDir, "extract-"));
  try {
    await withArchive(archivePath, async (zip) => {
      const entries = await readInventory(zip, inventory);
      let completed = 0;
      // runLimited stops dispatch after a failure and drains every active lane before rethrowing.
      await runLimited(selected, 4, async (file) => {
        const target = path.join(staging, file.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const stream = await openEntry(zip, entries.get(file.path)!);
        await writeVerified(stream, target, file);
        completed += 1;
        progress({ kind: "info", stage: STAGE, message: `묶음 검증 ${completed}/${selected.length}`, completed, total: selected.length, unit: "files" });
      });
    });
    // No target is replaced until the complete selected set has passed its individual hashes.
    await runLimited(selected, 4, async (file) => {
      const target = path.join(root, file.path);
      await ensureDirectory(root, path.dirname(target));
      await rejectLink(target);
      await fsp.rename(path.join(staging, file.path), target);
      await options.onCommitted?.(file);
    });
    return selected;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

function assertSource(source: InstallBundleSource): void {
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error("초기 묶음 주소가 올바르지 않습니다."); }
  if (url.protocol !== "https:" || url.username || url.password || !Number.isSafeInteger(source.size) || source.size < 1 || !/^[a-f0-9]{128}$/i.test(source.sha512)) {
    throw new Error("초기 묶음 정보가 올바르지 않습니다.");
  }
}

/** The ZIP inventory is exact even when only some files need extraction. */
function bundleInventory(source: InstallBundleSource, files: PackFile[]): Map<string, PackFile> {
  const eligible = new Map<string, PackFile>();
  const aliases = new Set<string>();
  for (const file of files.filter(isInstallBundleFile)) {
    const alias = file.path.toLowerCase();
    if (aliases.has(alias)) throw new Error("초기 묶음 파일 경로가 중복됩니다.");
    aliases.add(alias);
    eligible.set(file.path, file);
  }
  if (source.paths === undefined) return eligible;
  if (!Array.isArray(source.paths) || source.paths.length < 1 || source.paths.length > 20_000) throw new Error("초기 묶음 파일 목록이 올바르지 않습니다.");
  const selected = new Map<string, PackFile>();
  const selectedAliases = new Set<string>();
  for (const name of source.paths) {
    if (!isInitialInstallBundlePath(name) || selectedAliases.has(name.toLowerCase()) || !eligible.has(name)) throw new Error("초기 묶음 파일이 현재 모드팩 목록과 일치하지 않습니다.");
    selectedAliases.add(name.toLowerCase());
    selected.set(name, eligible.get(name)!);
  }
  return selected;
}

function assertFile(file: PackFile): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0 || !(file.sha256 ? /^[a-f0-9]{64}$/i.test(file.sha256) : /^[a-f0-9]{128}$/i.test(file.sha512 ?? ""))) {
    throw new Error("초기 묶음 내부 파일 검증 정보가 올바르지 않습니다.");
  }
}

function sameFile(left: PackFile, right: PackFile): boolean {
  return left.size === right.size && left.sha256?.toLowerCase() === right.sha256?.toLowerCase() && left.sha512?.toLowerCase() === right.sha512?.toLowerCase();
}

async function matchesArchive(target: string, source: InstallBundleSource): Promise<boolean> {
  try {
    const stat = await fsp.stat(target);
    return stat.isFile() && stat.size === source.size && await hashFile(target, "sha512") === source.sha512.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function rejectLink(target: string): Promise<void> {
  try { if ((await fsp.lstat(target)).isSymbolicLink()) throw new Error("초기 묶음은 링크 경로에 설치할 수 없습니다."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function ensureDirectory(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("초기 묶음 경로가 설치 폴더를 벗어납니다.");
  await rejectLink(root);
  await fsp.mkdir(root, { recursive: true });
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    await rejectLink(current);
    await fsp.mkdir(current, { recursive: true });
  }
}

async function withArchive<T>(archive: string, work: (zip: yauzl.ZipFile) => Promise<T>): Promise<T> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: false }, (error, opened) => {
      if (error || !opened) reject(error ?? new Error("초기 묶음을 열지 못했습니다."));
      else resolve(opened);
    });
  });
  try { return await work(zip); } finally { zip.close(); }
}

function readInventory(zip: yauzl.ZipFile, expected: Map<string, PackFile>): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    const aliases = new Set<string>();
    zip.on("error", reject);
    zip.on("end", () => entries.size === expected.size ? resolve(entries) : reject(new Error("초기 묶음에 현재 모드팩 파일이 빠져 있습니다.")));
    zip.on("entry", (entry: yauzl.Entry) => {
      const file = expected.get(entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      const alias = entry.fileName.toLowerCase();
      if (!file || !isInstallBundleFile({ path: entry.fileName }) || aliases.has(alias) || (mode !== 0 && mode !== 0x8000) || (entry.externalFileAttributes & 0x10) !== 0 || (entry.generalPurposeBitFlag & 1) !== 0 || entry.uncompressedSize !== file.size) {
        reject(new Error("초기 묶음의 경로·중복·파일 크기가 현재 모드팩과 일치하지 않습니다."));
        return;
      }
      entries.set(entry.fileName, entry);
      aliases.add(alias);
      zip.readEntry();
    });
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error ?? new Error("초기 묶음 파일을 읽지 못했습니다.")) : resolve(stream)));
}

async function writeVerified(stream: Readable, target: string, file: PackFile): Promise<void> {
  const algorithm = file.sha256 ? "sha256" : "sha512";
  const hash = crypto.createHash(algorithm);
  let received = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > file.size) { callback(new Error("초기 묶음 내부 파일이 지정된 크기를 초과합니다.")); return; }
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(stream, verify, fs.createWriteStream(target, { flags: "wx" }));
  if (received !== file.size || hash.digest("hex") !== (file.sha256 ?? file.sha512)!.toLowerCase()) throw new Error("초기 묶음 내부 파일의 해시가 일치하지 않습니다.");
}
