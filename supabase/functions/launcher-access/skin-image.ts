export type SkinModel = "default" | "slim";

/** Skin files are a few KB; the storage bucket enforces the same limit. */
export const MAX_SKIN_BYTES = 64 * 1024;

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isSkinModel(value: unknown): value is SkinModel {
  return value === "default" || value === "slim";
}

/**
 * Accepts a PNG whose header says 64x64 (1.8+ layout) or 64x32 (legacy
 * layout), which every Minecraft version since 1.8 can render.
 */
export function validateSkinPng(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || bytes.length > MAX_SKIN_BYTES) return "스킨 파일은 64KB 이하여야 합니다.";
  if (bytes.length < 33 || pngSignature.some((byte, index) => bytes[index] !== byte)) return "PNG 이미지가 아닙니다.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = String.fromCharCode(...bytes.subarray(12, 16));
  if (view.getUint32(8) !== 13 || chunkType !== "IHDR") return "PNG 이미지가 아닙니다.";
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== 64 || (height !== 64 && height !== 32)) return "스킨은 64×64 또는 64×32 크기여야 합니다.";
  const trailer = String.fromCharCode(...bytes.subarray(bytes.length - 8, bytes.length - 4));
  if (trailer !== "IEND") return "PNG 파일이 손상되었습니다.";
  return null;
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
