import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModpackManifest, SyncProgress, SyncRequest, SyncResult } from "../shared/types.js";

type ProgressSink = (event: SyncProgress) => void;

export async function syncModpack(request: SyncRequest, progress: ProgressSink): Promise<SyncResult> {
  const manifest = request.manifest;
  const instanceDir = path.resolve(request.instanceDir, manifest.id);
  let downloaded = 0;
  let skipped = 0;
  const total = manifest.files.length;

  await fsp.mkdir(instanceDir, { recursive: true });
  await fsp.writeFile(
    path.join(instanceDir, "bweeep-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  progress({ kind: "info", message: `${manifest.name} ${manifest.version} 동기화 시작`, completed: 0, total });

  for (const [index, file] of manifest.files.entries()) {
    const target = resolveInside(instanceDir, file.path);
    const currentHash = await sha256IfExists(target);
    if (currentHash === file.sha256) {
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

    const nextHash = await sha256File(target);
    if (nextHash !== file.sha256) {
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

export function assertManifest(manifest: ModpackManifest): void {
  if (manifest.schemaVersion !== 1 || !manifest.files?.length) {
    throw new Error("지원하지 않는 manifest 형식입니다.");
  }
  for (const file of manifest.files) {
    if (
      !file.path ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]+/).includes("..") ||
      !file.url ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
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

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`파일 다운로드 실패: ${url}`);
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

async function sha256IfExists(filePath: string): Promise<string | null> {
  try {
    return await sha256File(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}
