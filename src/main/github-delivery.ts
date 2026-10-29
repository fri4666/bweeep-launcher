import type { FileUpdateManifest } from "./file-update-manifest.js";

const root = "https://github.com/fri4666/bweeep-launcher/releases/download";
export function releaseAssetUrl(version: string, name: string): string {
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version) || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error("Invalid release asset");
  return `${root}/v${version}/${name}`;
}
export function updateBundleRange(manifest: FileUpdateManifest, filePath: string, part: number, chunkSize: number): { start: number; end: number; total: number } {
  let offset = 0;
  let start = -1;
  let end = -1;
  for (const file of manifest.files) {
    if (file.path === filePath) {
      if (!Number.isSafeInteger(part) || part < 0 || part * chunkSize >= file.packedSize) throw new Error("Invalid bundle part");
      start = offset + part * chunkSize;
      end = offset + Math.min(file.packedSize, (part + 1) * chunkSize) - 1;
    }
    offset += file.packedSize;
    if (!Number.isSafeInteger(offset)) throw new Error("Invalid bundle size");
  }
  if (start < 0) throw new Error("Unknown bundle file");
  return { start, end, total: offset };
}

// A server ignoring Range must never cause a full bundle download for each file.
export async function readReleaseRange(response: Response, start: number, end: number, total: number): Promise<Buffer> {
  if (response.status !== 206 || response.headers.get("content-range") !== `bytes ${start}-${end}/${total}` || !response.body) {
    await response.body?.cancel();
    throw new Error("업데이트 서버의 부분 다운로드 응답이 잘못되었습니다.");
  }
  const expected = end - start + 1;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > expected) throw new Error("업데이트 응답 크기가 올바르지 않습니다.");
      chunks.push(next.value);
    }
    if (size !== expected) throw new Error("업데이트 응답 크기가 올바르지 않습니다.");
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); }
}
