import { app } from "electron";
import electronUpdater from "electron-updater";
import type { LauncherUpdate, LauncherUpdateStatus } from "../shared/types.js";
import { getLauncherChannel } from "./launcher-channel.js";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 30 * 60_000;
let status: LauncherUpdateStatus = { state: "checking" };
let started = false;
let installScheduled = false;
let publishStatus: (next: LauncherUpdateStatus) => void = () => undefined;
let canInstallNow: () => boolean = () => true;

export function getLauncherUpdateStatus(): LauncherUpdateStatus {
  return status;
}

export function startLauncherUpdates(
  publish: (next: LauncherUpdateStatus) => void,
  canInstall: () => boolean
): void {
  publishStatus = publish;
  canInstallNow = canInstall;
  if (started) return;
  started = true;

  if (!app.isPackaged) {
    setStatus({ state: "current" });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const testChannel = getLauncherChannel() === "test";
  autoUpdater.channel = testChannel ? "test" : "latest";
  autoUpdater.allowPrerelease = testChannel;
  autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
  autoUpdater.on("update-not-available", () => setStatus({ state: "current" }));
  autoUpdater.on("update-available", (info) => {
    setStatus({ state: "available", update: toLauncherUpdate(info), message: "새 업데이트를 설치할 수 있습니다." });
  });
  autoUpdater.on("download-progress", (progress) => {
    setStatus({
      state: "downloading",
      update: status.update,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
    });
  });
  autoUpdater.on("update-downloaded", (event) => {
    setStatus({ state: "ready", update: toLauncherUpdate(event) });
    installPendingLauncherUpdate();
  });
  autoUpdater.on("error", (error) => {
    if (status.state === "installing") return;
    setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
  });

  void checkForUpdates();
  const interval = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
  interval.unref();
}

export async function downloadLauncherUpdate(): Promise<LauncherUpdateStatus> {
  if (status.state !== "available") return status;
  setStatus({ state: "downloading", update: status.update, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
  }
  return status;
}

export function installPendingLauncherUpdate(): void {
  if (status.state !== "ready" || installScheduled || !canInstallNow()) return;
  installScheduled = true;
  setStatus({ state: "installing", update: status.update });
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      installScheduled = false;
      setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
    }
  }, 1_500);
}

async function checkForUpdates(): Promise<void> {
  if (["downloading", "ready", "installing"].includes(status.state)) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
  }
}

function setStatus(next: LauncherUpdateStatus): void {
  status = next;
  publishStatus(next);
}

function toLauncherUpdate(info: {
  version: string;
  releaseNotes?: string | readonly { note?: string | null }[] | null;
}): LauncherUpdate {
  const notes = typeof info.releaseNotes === "string"
    ? [info.releaseNotes]
    : (info.releaseNotes ?? []).flatMap((entry) => entry.note ? [entry.note] : []);
  return { version: info.version, notes };
}

function safeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "업데이트 서버").slice(0, 180) || "자동 업데이트에 실패했습니다.";
}
