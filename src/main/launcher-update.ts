import { app, net } from "electron";
import electronUpdater from "electron-updater";
import type { LauncherUpdate, LauncherUpdateStatus } from "../shared/types.js";
import { getLauncherChannel } from "./launcher-channel.js";
import { koreanReleaseNotes } from "./update-copy.js";
import { isPrereleaseVersion, RELEASE_OWNER, RELEASE_REPO, RELEASES_ATOM_URL, releaseTagsFromAtom, selectTesterFeed, type TesterUpdateFeed } from "./update-feed.js";
import { isNewerLauncherVersion } from "./version.js";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 60_000;
const FEED_TIMEOUT_MS = 10_000;
let status: LauncherUpdateStatus = { state: "checking" };
let started = false;
let installScheduled = false;
let publishStatus: (next: LauncherUpdateStatus) => void = () => undefined;
/** Whether the launcher may restart into the update now; `playerAsked` is a click on the update icon. */
let canInstallNow: (playerAsked: boolean) => boolean = () => true;
/** The separate "Bweeep Test" app keeps its own test channel. */
let testApp = false;
/** Signed-in tester or admin: gets -beta.N builds in the normal launcher. */
let testerAudience = false;
let checkInFlight: Promise<void> | null = null;
let recheckQueued = false;

export function getLauncherUpdateStatus(): LauncherUpdateStatus {
  return status;
}

export function startLauncherUpdates(
  publish: (next: LauncherUpdateStatus) => void,
  canInstall: (playerAsked: boolean) => boolean
): void {
  publishStatus = publish;
  canInstallNow = canInstall;
  if (started) return;
  started = true;

  if (!app.isPackaged) {
    setStatus({ state: "current" });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  testApp = getLauncherChannel() === "test";
  if (testApp) {
    autoUpdater.channel = "test";
    autoUpdater.allowPrerelease = true;
    // Setting a channel turns downgrades on in electron-updater; a mistaken
    // release must never move everyone to an older launcher.
    autoUpdater.allowDowngrade = false;
  } else {
    useStableFeed();
  }
  // Only the first check at startup shows as "checking"; the minute-by-minute
  // checks after it stay silent unless they find something.
  autoUpdater.on("update-not-available", () => setStatus({ state: "current" }));
  autoUpdater.on("update-available", (info) => {
    if (!mayInstall(info.version)) {
      setStatus({ state: "current" });
      return;
    }
    setStatus({ state: "available", update: toLauncherUpdate(info) });
  });
  autoUpdater.on("download-progress", (progress) => {
    setStatus({
      state: "downloading",
      update: status.update,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
    });
  });
  autoUpdater.on("update-downloaded", (event) => {
    if (!mayInstall(event.version)) {
      // A beta downloaded while a tester was signed in is not installed for anyone else.
      autoUpdater.autoInstallOnAppQuit = false;
      setStatus({ state: "current" });
      return;
    }
    autoUpdater.autoInstallOnAppQuit = true;
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

/**
 * Called whenever the access check or a sign-out tells who is using the
 * launcher. Testers and admins move to beta builds; everyone else stays on
 * published stable builds, and a beta fetched for a tester is dropped.
 */
export function setLauncherUpdateAudience(tester: boolean): void {
  if (testerAudience === tester) return;
  testerAudience = tester;
  if (!started || !app.isPackaged || testApp) return;
  if (tester) {
    autoUpdater.autoInstallOnAppQuit = true;
  } else {
    useStableFeed();
    if (status.update && isPrereleaseVersion(status.update.version) && (status.state === "available" || status.state === "ready")) {
      autoUpdater.autoInstallOnAppQuit = false;
      setStatus({ state: "current" });
    }
  }
  void checkForUpdates();
}

export function installPendingLauncherUpdate(options: { playerAsked?: boolean } = {}): void {
  const playerAsked = options.playerAsked === true;
  if (status.state !== "ready" || installScheduled || !canInstallNow(playerAsked)) return;
  const update = status.update;
  installScheduled = true;
  setStatus({ state: "installing", update });
  // Leave the restart notice on screen long enough to read before the window closes.
  setTimeout(() => {
    if (update && !mayInstall(update.version)) {
      installScheduled = false;
      autoUpdater.autoInstallOnAppQuit = false;
      setStatus({ state: "current" });
      return;
    }
    // A game may have started in the meantime; the restart waits for it to end.
    if (!canInstallNow(playerAsked)) {
      installScheduled = false;
      setStatus({ state: "ready", update });
      return;
    }
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      installScheduled = false;
      setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
    }
  }, 5_000);
}

function mayInstall(version: string): boolean {
  return isNewerLauncherVersion(version, app.getVersion()) && (testApp || testerAudience || !isPrereleaseVersion(version));
}

async function checkForUpdates(): Promise<void> {
  if (checkInFlight) {
    recheckQueued = true;
    return checkInFlight;
  }
  checkInFlight = runCheck().finally(() => {
    checkInFlight = null;
    if (recheckQueued) {
      recheckQueued = false;
      void checkForUpdates();
    }
  });
  return checkInFlight;
}

async function runCheck(): Promise<void> {
  if (["downloading", "ready", "installing"].includes(status.state)) return;
  try {
    if (testerAudience && !testApp) {
      const feed = await findTesterFeed();
      // Signed out while the list was loading: the queued stable check takes over.
      if (!testerAudience) return;
      if (!feed) {
        setStatus({ state: "current" });
        return;
      }
      useTesterFeed(feed);
    }
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus({ state: "error", update: status.update, message: safeUpdateError(error) });
  }
}

async function findTesterFeed(): Promise<TesterUpdateFeed | null> {
  const response = await net.fetch(RELEASES_ATOM_URL, {
    headers: { accept: "application/atom+xml" },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`업데이트 목록을 받지 못했습니다. (서버 응답 ${response.status})`);
  return selectTesterFeed(releaseTagsFromAtom(await response.text()), app.getVersion());
}

/** Published stable builds only: GitHub's /releases/latest is never a draft or a prerelease. */
function useStableFeed(): void {
  autoUpdater.setFeedURL({ provider: "github", owner: RELEASE_OWNER, repo: RELEASE_REPO });
  useChannel("latest", false);
}

/** The one release picked for a tester; its own beta.yml or latest.yml describes the installer. */
function useTesterFeed(feed: TesterUpdateFeed): void {
  // GitHub's download host does not serve several byte ranges in one request.
  autoUpdater.setFeedURL({ provider: "generic", url: feed.url, channel: feed.channel, useMultipleRangeRequest: false });
  useChannel(feed.channel, feed.channel === "beta");
}

function useChannel(channel: string, allowPrerelease: boolean): void {
  autoUpdater.channel = channel;
  autoUpdater.allowPrerelease = allowPrerelease;
  // Setting a channel turns downgrades on in electron-updater; a mistaken
  // release must never move anyone to an older launcher.
  autoUpdater.allowDowngrade = false;
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
  return { version: info.version, notes: koreanReleaseNotes(notes) };
}

function safeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, "업데이트 서버").slice(0, 180) || "자동 업데이트에 실패했습니다.";
}
