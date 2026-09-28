import crypto from "node:crypto";
import fs from "node:fs";

export function hashBytes(algorithm: string, data: crypto.BinaryLike): string {
  return crypto.createHash(algorithm).update(data).digest("hex");
}

/** Streams the file so large game files are never held in memory at once. */
export async function hashFile(filePath: string, algorithm: string): Promise<string> {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** Short, one-way identifier that lets logs correlate values without storing them. */
export function fingerprint(value: string): string {
  return hashBytes("sha256", value).slice(0, 12);
}
