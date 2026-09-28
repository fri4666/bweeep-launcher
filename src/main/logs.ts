import fsp from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { fingerprint } from "./hash.js";

const maxLogBytes = 2 * 1024 * 1024;

export function authLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "auth.jsonl");
}

export function gameLogPath(): string {
  return path.join(app.getPath("userData"), "logs", "game-launch.jsonl");
}

export function writeAuthLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
  return appendLog(authLogPath(), { timestamp: new Date().toISOString(), pid: process.pid, event, ...details });
}

export function writeGameLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
  return appendLog(gameLogPath(), { at: new Date().toISOString(), event, ...details });
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
  return { message, fingerprint: fingerprint(raw) };
}

// Logging must never break a login or a launch, so failures only reach the console.
async function appendLog(target: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await rotateIfNeeded(target);
    await fsp.appendFile(target, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(`[log] ${path.basename(target)} write failed`, error instanceof Error ? error.message : String(error));
  }
}

async function rotateIfNeeded(target: string): Promise<void> {
  try {
    if ((await fsp.stat(target)).size < maxLogBytes) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fsp.rm(`${target}.previous`, { force: true });
  await fsp.rename(target, `${target}.previous`);
}
