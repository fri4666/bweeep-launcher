import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { InstallFile } from "@xmcl/installer";
import { AdaptiveLimit, StallError, StallGuard, abortable, runAdaptive, type Fetcher, type StallLimits } from "./download.js";
import { hashFile } from "./hash.js";

let directSessionReady: Promise<Electron.Session> | null = null;

export async function fetchWithSystemNetwork(url: string, init?: RequestInit): Promise<Response> {
  const target = requireHttpsUrl(url);
  const { net } = await import("electron");
  try {
    return await net.fetch(target.toString(), { ...init, bypassCustomProtocolHandlers: true });
  } catch (systemError) {
    // The caller gave up (a stall guard tripped); the direct route gets its own attempt from the caller.
    if (init?.signal?.aborted) throw systemError;
    await writeNetworkAttempt("network.system.failed", target, systemError);
    try {
      const direct = await getDirectSession();
      const response = await direct.fetch(target.toString(), { ...init, bypassCustomProtocolHandlers: true });
      await writeNetworkAttempt("network.direct.succeeded", target);
      return response;
    } catch (directError) {
      await writeNetworkAttempt("network.direct.failed", target, directError);
      throw new Error(
        `네트워크 연결에 실패했습니다: ${target.hostname} (시스템: ${networkReason(systemError)}, 직접: ${networkReason(directError)})`,
        { cause: directError }
      );
    }
  }
}

/** The no-proxy session on its own, for retrying around a system route that hangs. */
export async function fetchViaDirectSession(url: string, init?: RequestInit): Promise<Response> {
  const target = requireHttpsUrl(url);
  const direct = await getDirectSession();
  return direct.fetch(target.toString(), { ...init, bypassCustomProtocolHandlers: true });
}

/**
 * Game files are mostly small, so the time goes to waiting on each request
 * rather than to the bytes. Measured on the 3,600 Minecraft assets: 8 at once
 * is about four times faster than one at a time, and more than 8 adds nothing.
 * The number drops when the line shows trouble (see AdaptiveLimit).
 */
const INSTALL_DOWNLOAD_CONCURRENCY = 8;
const INSTALL_DOWNLOAD_FLOOR = 2;
/**
 * Attempts per address: the first through the system route, the second
 * through a direct (no proxy) session. xmcl's installer wraps this function
 * in up to five rounds of its own (0.5 to 4 s apart, addresses rotated), so a
 * few more attempts here would only multiply the wait.
 */
const INSTALL_DOWNLOAD_TRIES = 2;
/**
 * Game files are small: an answer that has not started in 12 s or a body that
 * is quiet for 15 s is stuck, not slow. With two attempts per address, one
 * address costs at most about 25 s before the next address is tried.
 */
const INSTALL_STALL_LIMITS: StallLimits = { headerMs: 12_000, idleMs: 15_000, totalMs: 10 * 60_000 };

/**
 * The same Maven artifacts also live on Maven Central. The Fabric libraries
 * that exist there get it as a second address, so one blocked host does not
 * stop the install. Only used for files that carry a size or checksum, which
 * the download still has to match.
 */
const MAVEN_CENTRAL_FALLBACKS: Array<{ host: string; pathPrefixes: string[]; fallback: string }> = [
  { host: "maven.fabricmc.net", pathPrefixes: ["/org/ow2/asm/", "/net/fabricmc/sponge-mixin/"], fallback: "https://repo1.maven.org/maven2" }
];

export function withFallbackUrls(file: Pick<InstallFile, "urls" | "size" | "checksum">): string[] {
  const urls = [...file.urls];
  if (!file.checksum && !(file.size !== undefined && file.size >= 0)) return urls;
  for (const url of file.urls) {
    if (!URL.canParse(url)) continue;
    const parsed = new URL(url);
    for (const rule of MAVEN_CENTRAL_FALLBACKS) {
      if (parsed.protocol !== "https:" || parsed.hostname !== rule.host) continue;
      if (!rule.pathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix))) continue;
      const fallback = `${rule.fallback}${parsed.pathname}`;
      if (!urls.includes(fallback)) urls.push(fallback);
    }
  }
  return urls;
}

export type InstallDownloadEvent =
  | { type: "stall"; host: string; file: string; phase: "header" | "idle" | "total" }
  | { type: "retry"; host: string; file: string; attempt: number; reason: string }
  | { type: "concurrency"; limit: number };

export interface InstallDownloadOptions {
  /** Silence limits per attempt; tests shorten them. */
  limits?: Partial<StallLimits>;
  /** Used for the attempt after a stall or a network error; defaults to a no-proxy session. */
  directFetcher?: Fetcher;
  tries?: number;
  /** First retry waits this long; each later one twice as long. */
  retryDelayMs?: number;
  concurrency?: number;
  minConcurrency?: number;
  /** At most one concurrency drop per this long. */
  cooldownMs?: number;
  /** Stalls, retries and concurrency drops; defaults to the launch log. */
  onEvent?: (event: InstallDownloadEvent) => void;
}

export type InstallProgressPhase = "start" | "bytes" | "done";

export async function downloadInstallFilesWithSystemNetwork(
  files: InstallFile[],
  /** `completed` counts finished files plus the finished share of the ones still coming in. */
  onProgress?: (completed: number, total: number, filePath: string, phase: InstallProgressPhase) => void,
  fetcher: Fetcher = fetchWithSystemNetwork,
  options: InstallDownloadOptions = {}
): Promise<void> {
  // The same path twice would be two downloads writing one temporary file.
  const unique = [...new Map(files.map((file) => [file.path, file])).values()];
  const emit = options.onEvent ?? logInstallDownloadEvent;
  const limit = new AdaptiveLimit(options.concurrency ?? INSTALL_DOWNLOAD_CONCURRENCY, options.minConcurrency ?? INSTALL_DOWNLOAD_FLOOR, options.cooldownMs, (next) => emit({ type: "concurrency", limit: next }));
  let completed = 0;
  // Share of each file received so far, so a big file moves the counter while it downloads.
  const inFlight = new Map<string, number>();
  let lastBytesReport = 0;
  const reportBytes = (filePath: string, fraction: number) => {
    inFlight.set(filePath, fraction);
    const now = Date.now();
    if (now - lastBytesReport < 250) return;
    lastBytesReport = now;
    let partial = 0;
    for (const share of inFlight.values()) partial += share;
    onProgress?.(Math.min(unique.length - 1e-6, completed + partial), unique.length, filePath, "bytes");
  };
  await runAdaptive(unique, limit, async (file) => {
    onProgress?.(completed, unique.length, file.path, "start");
    await downloadInstallFile(file, fetcher, {
      tries: options.tries ?? INSTALL_DOWNLOAD_TRIES,
      retryDelayMs: options.retryDelayMs ?? 500,
      limits: { ...INSTALL_STALL_LIMITS, ...options.limits },
      directFetcher: options.directFetcher ?? (fetcher === fetchWithSystemNetwork ? fetchViaDirectSession : fetcher),
      emit,
      trouble: () => limit.trouble(),
      onFraction: (fraction) => reportBytes(file.path, fraction)
    });
    inFlight.delete(file.path);
    completed += 1;
    onProgress?.(completed, unique.length, file.path, "done");
  });
}

interface InstallFileContext {
  tries: number;
  retryDelayMs: number;
  limits: StallLimits;
  directFetcher: Fetcher;
  emit: (event: InstallDownloadEvent) => void;
  trouble: () => void;
  onFraction: (fraction: number) => void;
}

async function downloadInstallFile(file: InstallFile, fetcher: Fetcher, context: InstallFileContext): Promise<void> {
  const urls = withFallbackUrls(file).filter((url) => URL.canParse(url) && new URL(url).protocol === "https:");
  if (urls.length === 0) throw new Error(`안전한 다운로드 주소가 없습니다: ${path.basename(file.path)}`);

  const temporary = `${file.path}.bweeep-part`;
  const name = path.basename(file.path);
  await fsp.mkdir(path.dirname(file.path), { recursive: true });
  let lastError: unknown;
  for (const url of urls) {
    const host = new URL(url).hostname;
    for (let attempt = 1; attempt <= context.tries; attempt += 1) {
      // After a stall or a network error the system route (proxy, VPN, adapter) is the suspect: try around it.
      const route = attempt > 1 && isCongestionError(lastError) ? context.directFetcher : fetcher;
      try {
        await fsp.rm(temporary, { force: true });
        await fetchInstallFileOnce(url, file, temporary, route, context);
        await fsp.rename(temporary, file.path);
        return;
      } catch (error) {
        lastError = error;
        await fsp.rm(temporary, { force: true });
        if (error instanceof StallError) {
          context.emit({ type: "stall", host, file: name, phase: error.phase });
          context.trouble();
        } else if (isCongestionError(error)) {
          context.trouble();
        }
        // A missing file or a refusal will not change on a second try; the next address might have it.
        if (!isRetryable(error) || attempt === context.tries) break;
        context.emit({ type: "retry", host, file: name, attempt: attempt + 1, reason: shortReason(error) });
        await new Promise((resolve) => setTimeout(resolve, context.retryDelayMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(`Minecraft 파일 다운로드에 실패했습니다: ${name}`, { cause: lastError });
}

async function fetchInstallFileOnce(url: string, file: InstallFile, temporary: string, fetcher: Fetcher, context: InstallFileContext): Promise<void> {
  const guard = new StallGuard(context.limits);
  try {
    const response = await abortable(fetcher(url, { signal: guard.signal }), guard.signal);
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new HttpStatusError(response.status);
    }
    guard.responded();
    const expected = file.size !== undefined && file.size > 0 ? file.size : 0;
    let received = 0;
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          guard.touch();
          received += chunk.length;
          if (expected > 0) context.onFraction(Math.min(1, received / expected));
          callback(null, chunk);
        }
      }),
      fs.createWriteStream(temporary),
      { signal: guard.signal }
    );
    guard.stop();
    await verifyInstallFile(temporary, file);
  } catch (error) {
    // Whatever the fetcher called it, a tripped guard is a stall.
    throw guard.stalled ?? error;
  } finally {
    guard.stop();
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

class VerificationError extends Error {}

/** Worth another try: the answer may differ next time. */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status >= 500 || error.status === 408 || error.status === 429;
  return true;
}

/** The line, not the file, is the likely problem; fewer parallel requests help. */
function isCongestionError(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status >= 500 || error.status === 429;
  return !(error instanceof VerificationError);
}

function shortReason(error: unknown): string {
  if (error instanceof HttpStatusError) return error.message;
  if (error instanceof VerificationError) return "검증 실패";
  if (error instanceof StallError) return error.phase;
  return networkReason(error);
}

/** Launch-log entry for a stall, retry or concurrency drop; never the URL, which can carry tokens. */
function logInstallDownloadEvent(event: InstallDownloadEvent): void {
  void import("./logs.js")
    .then(({ writeGameLog }) => writeGameLog(`network.download.${event.type}`, { ...event, type: undefined }))
    .catch(() => undefined);
}

async function verifyInstallFile(filePath: string, file: InstallFile): Promise<void> {
  if (file.size !== undefined && file.size >= 0 && (await fsp.stat(filePath)).size !== file.size) {
    throw new VerificationError("다운로드 크기가 일치하지 않습니다.");
  }
  if (!file.checksum) return;
  if (await hashFile(filePath, file.checksum.algorithm) !== file.checksum.value.toLowerCase()) {
    throw new VerificationError("다운로드 해시가 일치하지 않습니다.");
  }
}

function requireHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("HTTPS 주소만 사용할 수 있습니다.");
  return url;
}

async function getDirectSession(): Promise<Electron.Session> {
  if (!directSessionReady) {
    directSessionReady = (async () => {
      const { session } = await import("electron");
      const direct = session.fromPartition("bweeep-direct-network", { cache: false });
      await direct.setProxy({ mode: "direct" });
      return direct;
    })();
  }
  return directSessionReady;
}

async function writeNetworkAttempt(event: string, target: URL, error?: unknown): Promise<void> {
  // Imported lazily: logs.ts needs Electron, and the Node verify scripts load this module.
  const { writeGameLog } = await import("./logs.js");
  const diagnostics = await diagnoseSystemRoute(target);
  await writeGameLog(event, {
    host: target.hostname,
    ...diagnostics,
    ...(error ? { reason: networkReason(error) } : {})
  });
}

async function diagnoseSystemRoute(target: URL): Promise<Record<string, unknown>> {
  try {
    const { session } = await import("electron");
    const [host, proxy] = await Promise.all([
      session.defaultSession.resolveHost(target.hostname),
      session.defaultSession.resolveProxy(target.toString())
    ]);
    return {
      dns: host.endpoints.length > 0 ? "resolved" : "empty",
      ipv4: host.endpoints.filter((endpoint) => endpoint.family === "ipv4").length,
      ipv6: host.endpoints.filter((endpoint) => endpoint.family === "ipv6").length,
      proxy: proxy === "DIRECT" ? "direct" : "configured"
    };
  } catch (error) {
    return { diagnostics: "unavailable", diagnosticsReason: networkReason(error) };
  }
}

function networkReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 160);
}
