import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModpackManifest, SyncProgress, SyncRequest, SyncResult } from "../shared/types.js";
import { fetchWithSystemNetwork } from "./system-network.js";
import { prepareMrpack } from "./mrpack.js";

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

  progress({ kind: "info", message: `${manifest.name} ${manifest.version} 동기화 시작`, completed: 0, total });

  for (const [index, file] of files.entries()) {
    const target = resolveInside(instanceDir, file.path);
    if (await fileMatches(target, file)) {
      skipped += 1;
      progress({
        kind: "skip",
        message: `이미 최신: ${file.path}`,
        completed: index + 1,
        total,
        filePath: file.path
      });
      continue;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    progress({ kind: "download", message: `다운로드: ${file.path}`, completed: index, total, filePath: file.path });
    await downloadToFile(file.url, target, file.size);

    if (!(await fileMatches(target, file))) {
      await fsp.rm(target, { force: true });
      throw new Error(`해시 불일치: ${file.path}`);
    }
    downloaded += 1;
    progress({
      kind: "info",
      message: `준비 완료: ${file.path}`,
      completed: index + 1,
      total,
      filePath: file.path
    });
  }

  const nextManagedFiles = new Set(files.map((file) => file.path));
  for (const obsoletePath of previousManagedFiles) {
    if (nextManagedFiles.has(obsoletePath)) continue;
    const obsoleteTarget = resolveInside(instanceDir, obsoletePath);
    await fsp.rm(obsoleteTarget, { force: true });
    progress({ kind: "info", message: `서버 전용 파일 제거: ${obsoletePath}`, filePath: obsoletePath });
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

  progress({ kind: "done", message: `완료: 다운로드 ${downloaded}, 유지 ${skipped}`, completed: total, total });
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

export function assertManifest(manifest: ModpackManifest): void {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.id ||
    !manifest.minecraftVersion ||
    !manifest.loader?.kind ||
    !["vanilla", "fabric", "neoforge", "forge"].includes(manifest.loader.kind) ||
    !Number.isSafeInteger(manifest.java?.majorVersion) ||
    manifest.java.majorVersion < 21 ||
    !manifest.java.component
  ) {
    throw new Error("지원하지 않는 manifest 형식입니다.");
  }
  if (manifest.serverLoader && !["vanilla", "fabric", "neoforge", "forge", "paper", "folia"].includes(manifest.serverLoader.kind)) {
    throw new Error("지원하지 않는 서버 로더 정보입니다.");
  }
  if (manifest.clientFeatures && typeof manifest.clientFeatures.connectionLock !== "boolean") {
    throw new Error("클라이언트 기능 정보가 올바르지 않습니다.");
  }
  if (manifest.mrpack && (!/^https:\/\//.test(manifest.mrpack.url) || !Number.isSafeInteger(manifest.mrpack.size) || manifest.mrpack.size < 1 || !/^[a-f0-9]{128}$/i.test(manifest.mrpack.sha512))) {
    throw new Error("Modrinth 모드팩 정보가 올바르지 않습니다.");
  }
  for (const file of manifest.files) {
    if (
      !file.path ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]+/).includes("..") ||
      !file.url ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !((typeof file.sha256 === "string" && /^[a-f0-9]{64}$/i.test(file.sha256)) || (typeof file.sha512 === "string" && /^[a-f0-9]{128}$/i.test(file.sha512)))
    ) {
      throw new Error("manifest 파일 정보가 올바르지 않습니다.");
    }
  }
}

async function downloadToFile(url: string, target: string, expectedSize: number): Promise<void> {
  if (url.startsWith("file:")) {
    await fsp.copyFile(fileURLToPath(url), target);
    return;
  }

  const response = await fetchWithSystemNetwork(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) {
    throw new Error(`파일 다운로드 실패: ${path.basename(target)}`);
  }

  const temp = `${target}.part`;
  await fsp.rm(temp, { force: true });
  const file = fs.createWriteStream(temp);
  await new Promise<void>((resolve, reject) => {
    response.body!.pipeTo(
      new WritableStream({
        write(chunk) {
          file.write(Buffer.from(chunk));
        },
        close() {
          file.end(resolve);
        },
        abort(reason) {
          file.destroy();
          reject(reason);
        }
      })
    ).catch(reject);
  });
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
