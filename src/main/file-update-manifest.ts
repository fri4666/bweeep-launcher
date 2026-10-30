import { createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { isNewerLauncherVersion } from "./version.js";

export interface FileUpdateEntry {
  path: string;
  size: number;
  packedSize: number;
  sha256: string;
  packedSha256: string;
}

export interface FileUpdateManifest {
  schema: 1;
  version: string;
  channel: "stable" | "beta";
  arch: "x64" | "arm64";
  files: FileUpdateEntry[];
  signature: string;
}

export const UPDATE_BUCKET = "bweeep-launcher-updates";
export const UPDATE_STORAGE_ROOT = `https://bweeep.fri4666.com/storage/v1/object/public/${UPDATE_BUCKET}`;
// Each Storage object stays below the Free plan's 50 MB file limit.
export const UPDATE_CHUNK_SIZE = 5 * 1024 * 1024;

export function safeUpdatePath(value: string): string {
  if (!value || value.includes("\\") || value.includes(":") || value.startsWith("/") || value.includes("\0")) {
    throw new Error("잘못된 업데이트 파일 경로입니다.");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[. ]$/.test(segment))) {
    throw new Error("잘못된 업데이트 파일 경로입니다.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new Error("잘못된 업데이트 파일 경로입니다.");
  return value;
}

export function unsignedManifest(manifest: FileUpdateManifest): Omit<FileUpdateManifest, "signature"> {
  return {
    schema: manifest.schema,
    version: manifest.version,
    channel: manifest.channel,
    arch: manifest.arch,
    files: manifest.files.map(({ path, size, packedSize, sha256, packedSha256 }) => ({ path, size, packedSize, sha256, packedSha256 }))
  };
}

export function verifyFileUpdateManifest(
  value: unknown,
  publicKeyPem: string,
  currentVersion: string,
  channel: "stable" | "beta",
  arch: "x64" | "arm64"
): FileUpdateManifest | null {
  if (!value || typeof value !== "object") throw new Error("업데이트 목록 형식이 잘못되었습니다.");
  const manifest = value as FileUpdateManifest;
  if (manifest.schema !== 1 || manifest.channel !== channel || manifest.arch !== arch ||
      !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(manifest.version) ||
      !Array.isArray(manifest.files) || typeof manifest.signature !== "string") {
    throw new Error("업데이트 목록 형식이 잘못되었습니다.");
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 ||
        !Number.isSafeInteger(file.packedSize) || file.packedSize <= 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !/^[a-f0-9]{64}$/.test(file.packedSha256)) {
      throw new Error("업데이트 파일 목록 형식이 잘못되었습니다.");
    }
    safeUpdatePath(file.path);
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error("업데이트 파일 경로가 중복됩니다.");
    seen.add(key);
  }
  if (!manifest.files.some((file) => file.path === "Bweeep.exe")) throw new Error("업데이트 실행 파일이 없습니다.");
  if (channel === "stable" && manifest.version.includes("-")) throw new Error("정식 채널에 테스트 버전이 올라왔습니다.");
  const body = Buffer.from(JSON.stringify(unsignedManifest(manifest)));
  let trusted = false;
  try {
    trusted = verify(null, body, createPublicKey(publicKeyPem), Buffer.from(manifest.signature, "base64"));
  } catch {
    throw new Error("업데이트 서명을 확인할 수 없습니다.");
  }
  if (!trusted) throw new Error("업데이트 서명이 일치하지 않습니다.");
  return isNewerLauncherVersion(manifest.version, currentVersion) ? manifest : null;
}

export function releaseFileUrl(manifest: FileUpdateManifest, filePath: string, part = 0): string {
  safeUpdatePath(filePath);
  const file = manifest.files.find((entry) => entry.path === filePath);
  if (!file) throw new Error("업데이트 목록에 없는 파일입니다.");
  if (!Number.isSafeInteger(part) || part < 0 || part >= updatePartCount(file.packedSize)) throw new Error("업데이트 파일 조각 번호가 잘못되었습니다.");
  return `${UPDATE_STORAGE_ROOT}/blobs/${file.packedSha256}/part-${String(part).padStart(4, "0")}.bin`;
}

export function updatePartCount(size: number): number {
  return Math.max(1, Math.ceil(size / UPDATE_CHUNK_SIZE));
}
