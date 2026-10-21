import fsp from "node:fs/promises";
import path from "node:path";
import type { PackFile, SyncProgress, SyncRequest, SyncResult } from "../shared/types.js";
import { fetchViaDirectSession, fetchWithSystemNetwork } from "./system-network.js";
import { prepareMrpack } from "./mrpack.js";
import { applyInstallBundle, shouldUseInstallBundle } from "./install-bundle.js";
import { downloadVerified, freeDiskBytes, partPath, runLimited, type Fetcher } from "./download.js";
import { HashCache } from "./hash-cache.js";
export { assertManifest } from "./manifest-validation.js";

type ProgressSink = (event: SyncProgress) => void;

export interface SyncOptions {
  /** Network access; tests pass a plain fetch against a local server. */
  fetch?: Fetcher;
  /** Files downloaded at the same time. */
  concurrency?: number;
  /** Attempts per file. */
  tries?: number;
  retryDelayMs?: number;
  /** Free bytes on the instance disk, or null when unknown. */
  freeBytes?: (dir: string) => Promise<number | null>;
}

const STAGE = "모드팩 파일";
/** Room left over for the game itself (logs, worlds cache, installer temp files). */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

export async function syncModpack(request: SyncRequest, progress: ProgressSink, options: SyncOptions = {}): Promise<SyncResult> {
  const fetcher = options.fetch ?? fetchWithSystemNetwork;
  const concurrency = options.concurrency ?? 6;
  const manifest = request.manifest;
  const instanceDir = path.resolve(request.instanceDir, manifest.id);
  await fsp.mkdir(instanceDir, { recursive: true });
  // Sizes, times and hashes of files already checked, so unchanged files are not read again.
  const cache = await HashCache.load(path.join(instanceDir, ".bweeep", "file-hashes.json"));
  const mrpack = manifest.mrpack
    ? await prepareMrpack(manifest.mrpack, instanceDir, progress, { minecraftVersion: manifest.minecraftVersion, loader: manifest.loader }, { fetch: fetcher, cache })
    : null;
  const files = [...manifest.files, ...(mrpack?.files ?? [])].filter((file) => !replacedByLauncher(file.path));
  const total = files.length;

  const managedFilesPath = path.join(instanceDir, ".bweeep", "managed-files.json");
  const manifestPath = path.join(instanceDir, "bweeep-manifest.json");
  const previousManagedFiles = await readManagedFiles(managedFilesPath);

  progress({ kind: "info", stage: STAGE, message: "확인 시작", completed: 0, total, unit: "files" });

  // A file whose hash already matches is kept, whatever pack version it came from.
  const needed: PackFile[] = [];
  let checked = 0;
  await runLimited(files, concurrency, async (file) => {
    const target = resolveInside(instanceDir, file.path);
    if (!(await cache.matches(file.path, target, file))) needed.push(file);
    checked += 1;
    if (checked === total || checked % 25 === 0) {
      progress({ kind: "skip", stage: STAGE, message: `확인 ${checked}/${total}`, completed: checked, total, unit: "files" });
    }
  });
  await cache.save();
  const order = new Map(files.map((file, index) => [file, index]));
  needed.sort((a, b) => order.get(a)! - order.get(b)!);
  const skipped = total - needed.length;

  if (needed.length > 0) {
    await requireDiskSpace(instanceDir, needed, options.freeBytes ?? freeDiskBytes);
  }

  let downloaded = 0;
  const downloadFiles = async (pending: PackFile[]) => {
    const totalBytes = pending.reduce((sum, file) => sum + file.size, 0);
    const inFlight = new Map<string, number>();
    let finishedBytes = 0;
    let individualDownloaded = 0;
    let lastReport = 0;
    const reportBytes = (file: PackFile, force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 250) return;
      lastReport = now;
      let received = finishedBytes;
      for (const bytes of inFlight.values()) received += bytes;
      progress({
        kind: "download",
        stage: STAGE,
        message: `받는 중 ${individualDownloaded}/${pending.length} · ${toMb(received)}/${toMb(totalBytes)}MB`,
        completed: received,
        total: totalBytes,
        unit: "bytes",
        filePath: file.path
      });
    };

    await runLimited(pending, concurrency, async (file) => {
      const target = resolveInside(instanceDir, file.path);
      inFlight.set(file.path, 0);
      reportBytes(file, true);
      await downloadVerified({ url: file.url, target, size: file.size, sha256: file.sha256, sha512: file.sha512 }, {
        fetch: fetcher,
        fallbackFetch: options.fetch ? undefined : fetchViaDirectSession,
        tries: options.tries ?? 3,
        retryDelayMs: options.retryDelayMs,
        onBytes: (received) => {
          inFlight.set(file.path, received);
          reportBytes(file);
        },
        onRetry: (attempt) => progress({ kind: "info", stage: STAGE, message: `다시 받는 중 ${attempt}: ${path.basename(file.path)}`, filePath: file.path })
      });
      inFlight.delete(file.path);
      finishedBytes += file.size;
      downloaded += 1;
      individualDownloaded += 1;
      // Recorded as each file lands, so an interrupted sync resumes where it stopped.
      const algorithm = file.sha256 ? "sha256" : "sha512";
      await cache.remember(file.path, target, algorithm, (file.sha256 ?? file.sha512)!);
      await cache.save();
      reportBytes(file, true);
    });
  };

  const bundle = manifest.initialInstallBundle;
  if (bundle && shouldUseInstallBundle(bundle, files, needed)) {
    const bundledPaths = bundle.paths ? new Set(bundle.paths) : null;
    const bundleNeeded = bundledPaths ? needed.filter((file) => bundledPaths.has(file.path)) : needed;
    const individualNeeded = bundledPaths ? needed.filter((file) => !bundledPaths.has(file.path)) : [];
    const installAndRecheck = async () => {
      try {
        await applyInstallBundle(bundle, instanceDir, files, bundleNeeded, progress, {
          fetch: fetcher,
          fallbackFetch: options.fetch ? undefined : fetchViaDirectSession,
          tries: options.tries,
          retryDelayMs: options.retryDelayMs,
          freeBytes: options.freeBytes ?? freeDiskBytes,
          onCommitted: async (file) => {
            await cache.remember(file.path, resolveInside(instanceDir, file.path), file.sha256 ? "sha256" : "sha512", (file.sha256 ?? file.sha512)!);
          }
        });
      } catch {
        progress({ kind: "info", stage: STAGE, message: "묶음 파일 대신 개별 파일로 이어받는 중" });
      }
      // A failed commit may already have installed verified entries. Recheck only
      // the bundle partition; independent CDN work has its own verified accounting.
      const remaining = new Set<PackFile>();
      await runLimited(bundleNeeded, concurrency, async (file) => {
        if (!(await cache.matches(file.path, resolveInside(instanceDir, file.path), file))) remaining.add(file);
      });
      downloaded += bundleNeeded.length - remaining.size;
      await cache.save();
      return bundleNeeded.filter((file) => remaining.has(file));
    };
    // A bounded partial ZIP and the remaining large CDN files run together. Both
    // branches settle before an error escapes or bundle-only fallback begins.
    const outcomes = await Promise.allSettled([installAndRecheck(), downloadFiles(individualNeeded)]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
    const bundleResult = outcomes[0];
    if (bundleResult.status === "fulfilled") await downloadFiles(bundleResult.value);
  } else {
    await downloadFiles(needed);
  }

  const nextManagedFiles = new Set(files.map((file) => file.path));
  for (const obsoletePath of previousManagedFiles) {
    if (nextManagedFiles.has(obsoletePath)) continue;
    const obsoleteTarget = resolveInside(instanceDir, obsoletePath);
    await fsp.rm(obsoleteTarget, { force: true });
    await fsp.rm(partPath(obsoleteTarget), { force: true });
    cache.forget(obsoletePath);
    progress({ kind: "info", stage: STAGE, message: `정리: ${path.basename(obsoletePath)}`, filePath: obsoletePath });
  }
  await cache.save();
  await fsp.mkdir(path.dirname(managedFilesPath), { recursive: true });
  await fsp.writeFile(managedFilesPath, JSON.stringify([...nextManagedFiles].sort(), null, 2), "utf8");
  if (mrpack) await mrpack.applyOverrides(instanceDir, progress);
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const launchInfo = [
    `name=${manifest.name}`,
    `minecraft=${manifest.minecraftVersion}`,
    `loader=${manifest.loader.kind} ${manifest.loader.version}`,
    `server=${manifest.server.host}:${manifest.server.port}`
  ].join("\n");
  await fsp.writeFile(path.join(instanceDir, "launch-info.txt"), `${launchInfo}\n`, "utf8");

  progress({ kind: "done", stage: STAGE, message: `완료 · 새로 ${downloaded}개`, completed: total, total, unit: "files" });
  return { manifest, instanceDir, downloaded, skipped };
}

/**
 * Pack files the launcher leaves out because it does their job itself. Crash
 * Assistant takes the game closing when the player leaves the server for a
 * crash and opens its crash window; the launcher already reports real crashes.
 * A copy installed earlier is removed as an obsolete managed file.
 */
export function replacedByLauncher(filePath: string): boolean {
  return /^mods\/CrashAssistant-[^/]*\.jar$/i.test(filePath);
}

/** Fails before downloading anything when the disk cannot hold the missing files. */
async function requireDiskSpace(instanceDir: string, files: PackFile[], freeBytes: (dir: string) => Promise<number | null>): Promise<void> {
  let needed = DISK_MARGIN_BYTES;
  await runLimited(files, 8, async (file) => {
    const partial = await fsp.stat(partPath(resolveInside(instanceDir, file.path))).then((stat) => stat.size, () => 0);
    needed += Math.max(0, file.size - (partial <= file.size ? partial : 0));
  });
  const free = await freeBytes(instanceDir);
  if (free !== null && free < needed) {
    throw new Error(`저장 공간이 부족해요 · ${toGb(needed - free)}GB 더 필요해요`);
  }
}

function toMb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

function toGb(bytes: number): string {
  return Math.max(0.1, bytes / 1073741824).toFixed(1);
}

async function readManagedFiles(filePath: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value.filter((item) => !path.isAbsolute(item) && !item.split(/[\\/]+/).includes(".."))
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(normalizedRoot)) {
    throw new Error("허용되지 않은 모드팩 파일 경로입니다.");
  }
  return target;
}
