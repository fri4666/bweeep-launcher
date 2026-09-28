export type SkinModel = "default" | "slim";

/** Skin files are a few KB; the storage bucket enforces the same limit. */
export const MAX_SKIN_BYTES = 64 * 1024;

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Image chunks only. Text and unknown chunks could carry anything into the
// public bucket, and the launcher re-encodes skins so it never sends them.
const allowedChunks = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND", "gAMA", "sRGB", "cHRM", "sBIT", "pHYs", "bKGD"]);
// Samples per pixel for each PNG colour type.
const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isSkinModel(value: unknown): value is SkinModel {
  return value === "default" || value === "slim";
}

/**
 * Accepts a well-formed 8-bit PNG of 64x64 (1.8+ layout) or 64x32 (legacy
 * layout), which every Minecraft version since 1.8 can render. Every chunk's
 * CRC is checked and the pixel data must inflate to exactly the image size,
 * so the file can hold nothing but the picture.
 */
export async function validateSkinPng(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length === 0 || bytes.length > MAX_SKIN_BYTES) return "스킨 파일은 64KB 이하여야 합니다.";
  if (bytes.length < 57 || pngSignature.some((byte, index) => bytes[index] !== byte)) return "PNG 이미지가 아닙니다.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const idat: Uint8Array[] = [];
  let header: { width: number; height: number; bitDepth: number; colorType: number; interlace: number } | null = null;
  let offset = 8;
  let ended = false;
  while (offset < bytes.length) {
    if (ended || offset + 12 > bytes.length) return "PNG 파일이 손상되었습니다.";
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12) return "PNG 파일이 손상되었습니다.";
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) {
      return "PNG 파일이 손상되었습니다.";
    }
    if (!allowedChunks.has(type)) return "스킨 PNG에 그림 외의 데이터가 들어 있습니다.";
    if ((offset === 8) !== (type === "IHDR")) return "PNG 이미지가 아닙니다.";
    if (type === "IHDR") {
      if (length !== 13) return "PNG 이미지가 아닙니다.";
      const ihdr = new DataView(data.buffer, data.byteOffset, data.byteLength);
      header = { width: ihdr.getUint32(0), height: ihdr.getUint32(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") ended = true;
    offset += 12 + length;
  }
  if (!header || !ended || idat.length === 0) return "PNG 파일이 손상되었습니다.";
  if (header.width !== 64 || (header.height !== 64 && header.height !== 32)) return "스킨은 64×64 또는 64×32 크기여야 합니다.";
  const samples = channels[header.colorType];
  if (!samples || header.bitDepth !== 8 || header.interlace !== 0) return "지원하지 않는 PNG 형식입니다.";

  // Each row is one filter byte followed by the row's samples.
  const expected = header.height * (1 + header.width * samples);
  const inflated = await inflate(idat, expected);
  if (inflated !== expected) return "PNG 파일이 손상되었습니다.";
  return null;
}

/** Inflated byte count of the zlib stream, stopping early once it exceeds `limit`. */
async function inflate(parts: Uint8Array[], limit: number): Promise<number> {
  const stream = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const reader = stream.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return total;
      }
    }
  } catch {
    return -1;
  }
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
