import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { LauncherUpdate, LauncherUpdateStatus } from "../shared/types.js";

interface UpdateConfig {
  metadataUrl?: string;
}

export async function checkLauncherUpdate(): Promise<LauncherUpdateStatus> {
  const config = await readConfig();
  if (!config.metadataUrl) return { state: "unavailable" };

  try {
    const response = await fetch(config.metadataUrl, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return { state: "unavailable" };
    const candidate = await response.json() as Partial<LauncherUpdate>;
    if (!isUpdate(candidate)) return { state: "unavailable" };
    const update: LauncherUpdate = { version: candidate.version, downloadUrl: candidate.downloadUrl, notes: candidate.notes ?? [] };
    return compareVersions(update.version, app.getVersion()) > 0 ? { state: "available", update } : { state: "current" };
  } catch {
    return { state: "unavailable" };
  }
}

function isUpdate(value: Partial<LauncherUpdate>): value is LauncherUpdate {
  return typeof value.version === "string" && /^\d+\.\d+\.\d+$/.test(value.version) &&
    typeof value.downloadUrl === "string" && /^https:\/\//i.test(value.downloadUrl) &&
    (value.notes === undefined || (Array.isArray(value.notes) && value.notes.every((note) => typeof note === "string")));
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

async function readConfig(): Promise<UpdateConfig> {
  const external = app.isPackaged
    ? path.join(path.dirname(process.execPath), "bweeep-config", "launcher-update.json")
    : path.join(process.cwd(), "resources", "launcher-update.json");
  try {
    return JSON.parse(await fsp.readFile(external, "utf8")) as UpdateConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!app.isPackaged) return {};
    return JSON.parse(await fsp.readFile(path.join(app.getAppPath(), "resources", "launcher-update.json"), "utf8")) as UpdateConfig;
  }
}
