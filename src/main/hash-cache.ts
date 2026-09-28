import fsp from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hash.js";

type Algorithm = "sha256" | "sha512";

interface Stamp {
  size: number;
  mtimeMs: number;
  algorithm: Algorithm;
  hash: string;
}

/**
 * Remembers each managed file's size, modification time and hash, so a
 * launch only re-reads files that changed on disk since they were checked.
 * Keys are paths relative to the instance folder.
 */
export class HashCache {
  private dirty = false;
  private saving: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath: string, private readonly stamps: Map<string, Stamp>) {}

  static async load(filePath: string): Promise<HashCache> {
    const stamps = new Map<string, Stamp>();
    try {
      const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
          if (isStamp(stamp)) stamps.set(key, stamp);
        }
      }
    } catch {
      // A missing or damaged cache only means files are hashed again.
    }
    return new HashCache(filePath, stamps);
  }

  /** True when `target` has exactly the expected size and hash. */
  async matches(relativePath: string, target: string, expected: { size: number; sha256?: string; sha512?: string }): Promise<boolean> {
    const algorithm: Algorithm = expected.sha256 ? "sha256" : "sha512";
    const want = (expected.sha256 ?? expected.sha512 ?? "").toLowerCase();
    if (!want) return false;
    const hash = await this.hashOf(relativePath, target, algorithm, expected.size);
    return hash === want;
  }

  /** Records a file the launcher just wrote and verified. */
  async remember(relativePath: string, target: string, algorithm: Algorithm, hash: string): Promise<void> {
    const stat = await fsp.stat(target);
    this.stamps.set(relativePath, { size: stat.size, mtimeMs: wholeMs(stat.mtimeMs), algorithm, hash: hash.toLowerCase() });
    this.dirty = true;
  }

  forget(relativePath: string): void {
    if (this.stamps.delete(relativePath)) this.dirty = true;
  }

  /** Writes are queued, so saves from parallel downloads never interleave. */
  save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await fsp.writeFile(temp, JSON.stringify(Object.fromEntries(this.stamps)), "utf8");
      await fsp.rename(temp, this.filePath);
    });
    return this.saving;
  }

  private async hashOf(relativePath: string, target: string, algorithm: Algorithm, expectedSize: number): Promise<string | null> {
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.size !== expectedSize) return null;
    const cached = this.stamps.get(relativePath);
    const mtimeMs = wholeMs(stat.mtimeMs);
    if (cached && cached.size === stat.size && cached.mtimeMs === mtimeMs && cached.algorithm === algorithm) return cached.hash;
    const hash = await hashFile(target, algorithm);
    this.stamps.set(relativePath, { size: stat.size, mtimeMs, algorithm, hash });
    this.dirty = true;
    return hash;
  }
}

/** File systems keep times at different precisions; whole milliseconds compare the same everywhere. */
function wholeMs(value: number): number {
  return Math.trunc(value);
}

function isStamp(value: unknown): value is Stamp {
  const stamp = value as Partial<Stamp> | null;
  return Boolean(stamp) && typeof stamp?.size === "number" && typeof stamp.mtimeMs === "number" &&
    (stamp.algorithm === "sha256" || stamp.algorithm === "sha512") && typeof stamp.hash === "string";
}
