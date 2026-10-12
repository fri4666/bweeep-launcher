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
  /** Silence limits for one attempt; tests shorten them. */
  limits?: Partial<StallLimits>;
  /** Used for the attempt after a stall, to get around a hung system route. */
  fallbackFetch?: Fetcher;
  /** Bytes of this file on disk so far, including a resumed part. */
  onBytes?: (received: number) => void;
  onRetry?: (attempt: number, error: unknown) => void;
}

export class DownloadVerificationError extends Error {}

/**
 * How long one attempt may stay silent before it is cut off. A flat timeout
 * either waits minutes on a dead connection or cuts a big file on a slow
 * line; asking "did anything arrive lately?" does neither.
 */
export interface StallLimits {
  /** Waiting for the server to start answering. */
  headerMs: number;
  /** No bytes for this long while the body is coming in. */
  idleMs: number;
  /** Safety net for one attempt, however slowly it keeps moving. */
  totalMs: number;
}

export const DEFAULT_STALL_LIMITS: StallLimits = { headerMs: 30_000, idleMs: 20_000, totalMs: 15 * 60_000 };

export class StallError extends Error {
  constructor(readonly phase: "header" | "idle" | "total") {
    super(phase === "header" ? "서버가 응답하지 않습니다." : phase === "idle" ? "받는 중 데이터가 멈췄습니다." : "다운로드 시간이 너무 오래 걸립니다.");
  }
}

/** One attempt's clock: aborts `signal` when the connection goes quiet for too long. */
export class StallGuard {
  readonly signal: AbortSignal;
  stalled: StallError | null = null;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly totalTimer: ReturnType<typeof setTimeout>;
  private waitingFor: "header" | "idle" = "header";

  constructor(private readonly limits: StallLimits) {
    this.signal = this.controller.signal;
    this.totalTimer = setTimeout(() => this.trip("total"), limits.totalMs);
    this.arm();
  }

  /** The server answered; from now on silence means the body stopped. */
  responded(): void {
    this.waitingFor = "idle";
    this.arm();
  }

  /** Bytes arrived. */
  touch(): void {
    if (this.waitingFor === "idle") this.arm();
  }

  stop(): void {
    clearTimeout(this.totalTimer);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const wait = this.waitingFor === "header" ? this.limits.headerMs : this.limits.idleMs;
    this.timer = setTimeout(() => this.trip(this.waitingFor), wait);
  }

  private trip(phase: "header" | "idle" | "total"): void {
    if (this.stalled || this.signal.aborted) return;
    this.stalled = new StallError(phase);
    this.stop();
    this.controller.abort(this.stalled);
  }
}

/** Rejects as soon as `signal` aborts, even when the fetcher itself never notices. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

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
      await downloadOnce(file, lastError instanceof StallError && options.fallbackFetch ? { ...options, fetch: options.fallbackFetch } : options);
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
      const guard = new StallGuard({ ...DEFAULT_STALL_LIMITS, ...options.limits });
      try {
        const response = await abortable(options.fetch(file.url, { headers, signal: guard.signal }), guard.signal);
        if (!response.ok || !response.body) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 416 && offset > 0) {
            // The range starts past the end: the part is complete or wrong. The hash decides.
          } else {
            throw new Error(`HTTP ${response.status}`);
          }
        } else {
          guard.responded();
          const resumed = offset > 0 && response.status === 206 && rangeStart(response.headers.get("content-range")) === offset;
          if (!resumed) offset = 0;
          await writeBody(response, temp, offset, file.size, guard, options.onBytes);
        }
      } catch (error) {
        // Whatever the fetcher called it, a tripped guard is a stall.
        throw guard.stalled ?? error;
      } finally {
        guard.stop();
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

async function writeBody(response: Response, temp: string, offset: number, expectedSize: number, guard: StallGuard, onBytes?: (received: number) => void): Promise<void> {
  let received = offset;
  let lastReport = 0;
  onBytes?.(received);
  await pipeline(
    Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        guard.touch();
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
    fs.createWriteStream(temp, { flags: offset > 0 ? "a" : "w" }),
    { signal: guard.signal }
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

/**
 * How many downloads may run at once, lowered when the line shows trouble.
 * Trouble halves the number (never below `floor`), at most once per
 * `cooldownMs`, so eight requests failing together cost one step, not three.
 */
export class AdaptiveLimit {
  private value: number;
  private lastDrop = -Infinity;

  constructor(start: number, private readonly floor = 2, private readonly cooldownMs = 4_000, private readonly onChange?: (limit: number) => void) {
    this.value = Math.max(1, start);
  }

  get current(): number {
    return this.value;
  }

  trouble(): void {
    const now = Date.now();
    if (this.value <= this.floor || now - this.lastDrop < this.cooldownMs) return;
    this.lastDrop = now;
    this.value = Math.max(this.floor, Math.floor(this.value / 2));
    this.onChange?.(this.value);
  }
}

/** Like runLimited, but the allowed number can drop while the batch runs; running work is left to finish. */
export async function runAdaptive<T>(items: T[], limit: AdaptiveLimit, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit.current, items.length)) }, async (_, lane) => {
    while (failure === null && next < items.length && lane < limit.current) {
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
