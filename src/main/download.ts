import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { hashFile } from "./hash.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface VerifiedDownload {
  url: string;
  target: string;
  size: number;
  /** Exactly one is used: SHA-256 when present, otherwise SHA-512. */
  sha256?: string;
  sha512?: string;
}

export interface DownloadOptions {
  fetch: Fetcher;
  /** Attempts per file, including the first. */
  tries?: number;
  /** First retry waits this long; each later one waits twice as long. */
  retryDelayMs?: number;
  timeoutMs?: number;
  /** Bytes of this file on disk so far, including a resumed part. */
  onBytes?: (received: number) => void;
  onRetry?: (attempt: number, error: unknown) => void;
}

export class DownloadVerificationError extends Error {}

export function partPath(target: string): string {
  return `${target}.part`;
}

/**
 * Downloads to `<target>.part`, then checks the exact size and hash before the
 * file takes its real name. A `.part` left by an interrupted run is continued
 * with an HTTP Range request when the server allows it, and still has to pass
 * the full-file hash. Failed attempts are retried with a growing pause.
 */
export async function downloadVerified(file: VerifiedDownload, options: DownloadOptions): Promise<void> {
  const tries = Math.max(1, options.tries ?? 3);
  const baseDelay = options.retryDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      await downloadOnce(file, options);
      return;
    } catch (error) {
      lastError = error;
      // A part that failed its hash is useless; one cut off by the network is kept to resume.
      if (error instanceof DownloadVerificationError) await fsp.rm(partPath(file.target), { force: true });
      if (attempt < tries) {
        options.onRetry?.(attempt + 1, error);
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

async function downloadOnce(file: VerifiedDownload, options: DownloadOptions): Promise<void> {
  const temp = partPath(file.target);
  await fsp.mkdir(path.dirname(file.target), { recursive: true });

  if (file.url.startsWith("file:")) {
    await fsp.copyFile(fileURLToPath(file.url), temp);
  } else {
    let offset = await existingSize(temp);
    if (offset > file.size) {
      await fsp.rm(temp, { force: true });
      offset = 0;
    }
    if (offset < file.size || file.size === 0) {
      const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
      const response = await options.fetch(file.url, { headers, signal: AbortSignal.timeout(options.timeoutMs ?? 300_000) });
      if (!response.ok || !response.body) {
        if (response.status === 416 && offset > 0) {
          // The range starts past the end: the part is complete or wrong. The hash decides.
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      } else {
        const resumed = offset > 0 && response.status === 206 && rangeStart(response.headers.get("content-range")) === offset;
        if (!resumed) offset = 0;
        await writeBody(response, temp, offset, file.size, options.onBytes);
      }
    }
  }

  const size = await existingSize(temp);
  if (size !== file.size) throw new DownloadVerificationError(`다운로드 크기가 맞지 않습니다: ${path.basename(file.target)}`);
  const algorithm = file.sha256 ? "sha256" : "sha512";
  const expected = (file.sha256 ?? file.sha512 ?? "").toLowerCase();
  if (!expected || await hashFile(temp, algorithm) !== expected) {
    throw new DownloadVerificationError(`해시 불일치: ${path.basename(file.target)}`);
  }
  await fsp.rm(file.target, { force: true });
  await fsp.rename(temp, file.target);
}

async function writeBody(response: Response, temp: string, offset: number, expectedSize: number, onBytes?: (received: number) => void): Promise<void> {
  let received = offset;
  let lastReport = 0;
  onBytes?.(received);
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > expectedSize) return callback(new DownloadVerificationError("다운로드 크기가 맞지 않습니다."));
        const now = Date.now();
        if (now - lastReport >= 250 || received === expectedSize) {
          lastReport = now;
          onBytes?.(received);
        }
        callback(null, chunk);
      }
    }),
    // Appending keeps what an earlier run already received.
    fs.createWriteStream(temp, { flags: offset > 0 ? "a" : "w" })
  );
}

function rangeStart(contentRange: string | null): number | null {
  const match = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i.exec(contentRange?.trim() ?? "");
  return match ? Number(match[1]) : null;
}

async function existingSize(filePath: string): Promise<number> {
  try {
    return (await fsp.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** Runs `worker` over `items` with at most `limit` running at once; the first failure stops new work. */
export async function runLimited<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (failure === null && next < items.length) {
      const index = next;
      next += 1;
      try {
        await worker(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

/** Free bytes for the current user on the disk holding `dir`, or null when unknown. */
export async function freeDiskBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
