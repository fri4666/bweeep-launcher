import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { net, session } from "electron";
import type { InstallFile } from "@xmcl/installer";

let directSessionReady: Promise<Electron.Session> | null = null;

export async function fetchWithSystemNetwork(url: string, init?: RequestInit): Promise<Response> {
  const target = requireHttpsUrl(url);
  try {
    return await net.fetch(target.toString(), { ...init, bypassCustomProtocolHandlers: true });
  } catch (systemError) {
    await writeNetworkAttempt("network.system.failed", target.hostname, systemError);
    try {
      const direct = await getDirectSession();
      const response = await direct.fetch(target.toString(), { ...init, bypassCustomProtocolHandlers: true });
      await writeNetworkAttempt("network.direct.succeeded", target.hostname);
      return response;
    } catch (directError) {
      await writeNetworkAttempt("network.direct.failed", target.hostname, directError);
      throw new Error(
        `네트워크 연결에 실패했습니다: ${target.hostname} (시스템: ${networkReason(systemError)}, 직접: ${networkReason(directError)})`,
        { cause: directError }
      );
    }
  }
}

export async function downloadInstallFilesWithSystemNetwork(files: InstallFile[]): Promise<void> {
  for (const file of files) await downloadInstallFile(file);
}

async function downloadInstallFile(file: InstallFile): Promise<void> {
  const urls = file.urls.filter((url) => {
    try {
      return requireHttpsUrl(url).protocol === "https:";
    } catch {
      return false;
    }
  });
  if (urls.length === 0) throw new Error(`안전한 다운로드 주소가 없습니다: ${path.basename(file.path)}`);

  const temporary = `${file.path}.bweeep-part`;
  await fsp.mkdir(path.dirname(file.path), { recursive: true });
  let lastError: unknown;
  for (const url of urls) {
    try {
      await fsp.rm(temporary, { force: true });
      const response = await fetchWithSystemNetwork(url, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
        fs.createWriteStream(temporary)
      );
      await verifyInstallFile(temporary, file);
      await fsp.rename(temporary, file.path);
      return;
    } catch (error) {
      lastError = error;
      await fsp.rm(temporary, { force: true });
    }
  }
  throw new Error(`Minecraft 파일 다운로드에 실패했습니다: ${path.basename(file.path)}`, { cause: lastError });
}

async function verifyInstallFile(filePath: string, file: InstallFile): Promise<void> {
  if (file.size !== undefined && (await fsp.stat(filePath)).size !== file.size) {
    throw new Error("다운로드 크기가 일치하지 않습니다.");
  }
  if (!file.checksum) return;
  const hash = crypto.createHash(file.checksum.algorithm);
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  if (hash.digest("hex").toLowerCase() !== file.checksum.value.toLowerCase()) {
    throw new Error("다운로드 해시가 일치하지 않습니다.");
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
      const direct = session.fromPartition("bweeep-direct-network", { cache: false });
      await direct.setProxy({ mode: "direct" });
      return direct;
    })();
  }
  return directSessionReady;
}

async function writeNetworkAttempt(event: string, host: string, error?: unknown): Promise<void> {
  const { writeGameLog } = await import("./game-log.js");
  await writeGameLog(event, error ? { host, reason: networkReason(error) } : { host });
}

function networkReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 160);
}
