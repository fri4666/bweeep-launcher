import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { SyncProgress, SyncRequest, SyncResult } from "../shared/types.js";
import { fetchWithSystemNetwork } from "./system-network.js";
import { prepareMrpack } from "./mrpack.js";
export { assertManifest } from "./manifest-validation.js";

type ProgressSink = (event: SyncProgress) => void;

export async function syncModpack(request: SyncRequest, progress: ProgressSink): Promise<SyncResult> {
  const manifest = request.manifest;
  const instanceDir = path.resolve(request.instanceDir, manifest.id);
  let downloaded = 0;
  let skipped = 0;
  const mrpack = manifest.mrpack ? await prepareMrpack(manifest.mrpack, instanceDir, progress, { minecraftVersion: manifest.minecraftVersion, loader: manifest.loader }) : null;
  const files = [...manifest.files, ...(mrpack?.files ?? [])];
  const total = files.length;

  await fsp.mkdir(instanceDir, { recursive: true });
  const managedFilesPath = path.join(instanceDir, ".bweeep", "managed-files.json");
  const previousManagedFiles = await readManagedFiles(managedFilesPath);
  await fsp.writeFile(
    path.join(instanceDir, "bweeep-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  progress({ kind: "info", stage: "모드팩 파일", message: `${manifest.name} ${manifest.version} 동기화 시작`, completed: 0, total, unit: "files" });

  for (const [index, file] of files.entries()) {
    const target = resolveInside(instanceDir, file.path);
    if (await fileMatches(target, file)) {
      skipped += 1;
      progress({
        kind: "skip",
        stage: "모드팩 파일",
        message: `이미 최신: ${file.path}`,
        completed: index + 1,
        total,
        unit: "files",
        filePath: file.path
      });
      continue;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    progress({ kind: "download", stage: "모드팩 파일", message: `다운로드: ${file.path}`, completed: index, total, unit: "files", filePath: file.path });
    await downloadToFile(file.url, target, file.size, (received) => {
      progress({
        kind: "download",
        stage: "모드팩 파일",
        message: `다운로드: ${file.path} · ${(received / 1048576).toFixed(1)} / ${(file.size / 1048576).toFixed(1)} MB`,
        completed: index,
        total,
        unit: "files",
        filePath: file.path
      });
    });

    if (!(await fileMatches(target, file))) {
      await fsp.rm(target, { force: true });
      throw new Error(`해시 불일치: ${file.path}`);
    }
    downloaded += 1;
    progress({
      kind: "info",
      stage: "모드팩 파일",
      message: `준비 완료: ${file.path}`,
      completed: index + 1,
      total,
      unit: "files",
      filePath: file.path
    });
  }

  const nextManagedFiles = new Set(files.map((file) => file.path));
  for (const obsoletePath of previousManagedFiles) {
    if (nextManagedFiles.has(obsoletePath)) continue;
    const obsoleteTarget = resolveInside(instanceDir, obsoletePath);
    await fsp.rm(obsoleteTarget, { force: true });
    progress({ kind: "info", stage: "모드팩 파일", message: `서버 전용 파일 제거: ${obsoletePath}`, filePath: obsoletePath });
  }
  await fsp.mkdir(path.dirname(managedFilesPath), { recursive: true });
  await fsp.writeFile(managedFilesPath, JSON.stringify([...nextManagedFiles].sort(), null, 2), "utf8");
  if (mrpack) await mrpack.applyOverrides(instanceDir, progress);

  const launchInfo = [
    `name=${manifest.name}`,
    `minecraft=${manifest.minecraftVersion}`,
    `loader=${manifest.loader.kind} ${manifest.loader.version}`,
    `server=${manifest.server.host}:${manifest.server.port}`
  ].join("\n");
  await fsp.writeFile(path.join(instanceDir, "launch-info.txt"), `${launchInfo}\n`, "utf8");

  progress({ kind: "done", stage: "모드팩 파일", message: `완료: 다운로드 ${downloaded}, 유지 ${skipped}`, completed: total, total, unit: "files" });
  return { manifest, instanceDir, downloaded, skipped };
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

async function downloadToFile(url: string, target: string, expectedSize: number, onBytes: (received: number) => void): Promise<void> {
  if (url.startsWith("file:")) {
    await fsp.copyFile(fileURLToPath(url), target);
    onBytes((await fsp.stat(target)).size);
    return;
  }

  const response = await fetchWithSystemNetwork(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) {
    throw new Error(`파일 다운로드 실패: ${path.basename(target)}`);
  }

  const temp = `${target}.part`;
  await fsp.rm(temp, { force: true });
  let received = 0;
  let lastReport = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > expectedSize) return callback(new Error("다운로드 크기가 맞지 않습니다."));
          const now = Date.now();
          if (now - lastReport >= 250 || received === expectedSize) {
            lastReport = now;
            onBytes(received);
          }
          callback(null, chunk);
        }
      }),
      fs.createWriteStream(temp)
    );
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
  const stat = await fsp.stat(temp);
  if (stat.size !== expectedSize) {
    await fsp.rm(temp, { force: true });
    throw new Error(`다운로드 크기가 맞지 않습니다: ${path.basename(target)}`);
  }
  await fsp.rename(temp, target);
}

function resolveInside(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!target.startsWith(normalizedRoot)) {
    throw new Error("허용되지 않은 모드팩 파일 경로입니다.");
  }
  return target;
}

async function fileMatches(filePath: string, file: { sha256?: string; sha512?: string }): Promise<boolean> {
  const expected = file.sha256 ?? file.sha512;
  if (!expected) return false;
  try {
    const algorithm = file.sha256 ? "sha256" : "sha512";
    return await hashFile(filePath, algorithm) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(filePath: string, algorithm: "sha256" | "sha512"): Promise<string> {
  const hash = crypto.createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}
