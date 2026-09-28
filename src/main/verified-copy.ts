import fsp from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile } from "./hash.js";

/**
 * Copies a file shipped with the launcher to `target` after checking its
 * pinned SHA-256, and keeps an existing copy that already matches. Java cannot
 * load agents from inside app.asar, so bundled agents are used from such copies.
 */
export async function ensureVerifiedCopy(source: string, sha256: string, target: string, damagedMessage: string): Promise<string> {
  const contents = await fsp.readFile(source);
  if (hashBytes("sha256", contents) !== sha256) throw new Error(damagedMessage);
  try {
    if (await hashFile(target, "sha256") === sha256) return target;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.part`;
  await fsp.writeFile(temp, contents);
  await fsp.rm(target, { force: true });
  await fsp.rename(temp, target);
  return target;
}
