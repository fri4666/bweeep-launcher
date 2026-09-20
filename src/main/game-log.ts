import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";

export function gameLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "game-launch.jsonl");
}

export async function writeGameLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
  const target = gameLogPath();
  const entry = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.appendFile(target, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error("[game-log] write failed", error instanceof Error ? error.message : String(error));
  }
}

export function gameErrorDetails(error: unknown): { message: string; fingerprint: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return "[url]";
    }
  });
  return { message, fingerprint: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12) };
}
