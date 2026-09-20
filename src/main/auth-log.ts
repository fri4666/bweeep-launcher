import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

const maxLogBytes = 2 * 1024 * 1024;

export function authFingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function authLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "auth.jsonl");
}

export async function writeAuthLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
  const target = authLogPath();
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await rotateIfNeeded(target);
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: process.pid,
      event,
      ...details
    });
    await fsp.appendFile(target, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[auth-log] write failed", error instanceof Error ? error.message : String(error));
  }
}

async function rotateIfNeeded(target: string): Promise<void> {
  try {
    const stat = await fsp.stat(target);
    if (stat.size < maxLogBytes) return;
    await fsp.rename(target, `${target}.previous`).catch(async () => {
      await fsp.rm(`${target}.previous`, { force: true });
      await fsp.rename(target, `${target}.previous`);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
