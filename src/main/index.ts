import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { getServerPresets } from "./catalog.js";
import { assertManifest, syncModpack } from "./sync.js";
import { checkServer } from "./server-status.js";
import { SupabaseAuth } from "./supabase-auth.js";
import { installAndLaunch } from "./minecraft-runtime.js";
import { parseInviteLink } from "./deep-link.js";
import { readServerConnection, resetServerConnection, writeServerConnection } from "./server-config.js";
import { checkLauncherUpdate } from "./launcher-update.js";
import type { LauncherUser, LoginProvider } from "../shared/types.js";
import type { SyncProgress } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sessionUser: LauncherUser | null = null;
const auth = new SupabaseAuth();
const pendingAuthUrls: string[] = [];
const pendingInviteCodes: string[] = [];
let inviteReceiverReady = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDeepLinkProtocol();
}

function registerDeepLinkProtocol(): void {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient("bwe-e-ep", process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient("bwe-e-ep");
  }
}

function collectDeepLink(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith("bwe-e-ep://"));
}

function queueDeepLink(url: string): void {
  if (url.startsWith("bwe-e-ep://invite/")) {
    try {
      const code = parseInviteLink(url);
      if (code) pendingInviteCodes.push(code);
    } catch (error) {
      notifyAuthError(error);
    }
  } else {
    pendingAuthUrls.push(url);
  }
  if (app.isReady()) void processPendingDeepLinks();
}

async function processPendingDeepLinks(): Promise<void> {
  while (pendingAuthUrls.length > 0) {
    const url = pendingAuthUrls.shift();
    if (!url) continue;
    try {
      sessionUser = await auth.completeCallback(url);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("auth:session", sessionUser);
      }
    } catch (error) {
      notifyAuthError(error);
    }
  }
  if (!inviteReceiverReady) return;
  while (pendingInviteCodes.length > 0) {
    const code = pendingInviteCodes.shift();
    if (!code) continue;
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("invite:received", code);
    }
  }
}

function notifySession(user: LauncherUser): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("auth:session", user);
  }
}

function notifyAuthError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("auth:error", message);
  }
}

const initialDeepLink = collectDeepLink(process.argv);
if (initialDeepLink) queueDeepLink(initialDeepLink);

app.on("second-instance", (_event, argv) => {
  const url = collectDeepLink(argv);
  if (url) queueDeepLink(url);
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueDeepLink(url);
});

function createWindow(): void {
  const distRoot = path.resolve(__dirname, "..", "..");
  const win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 620,
    title: "붸에엡",
    backgroundColor: "#111315",
    webPreferences: {
      preload: path.join(distRoot, "src", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(path.join(distRoot, "renderer", "index.html"));
  }
}

app.whenReady().then(() => {
  const defaultServer = getServerPresets()[0].server;
  ipcMain.handle("catalog:list", () => getServerPresets());
  ipcMain.handle("server:status", (_event, server: { host: string; port: number }) => checkServer(server));
  ipcMain.handle("paths:defaultInstanceRoot", () =>
    path.join(os.homedir(), "AppData", "Roaming", "Bweeep", "instances")
  );
  ipcMain.handle("shell:openPath", async (_event, target: string) => {
    return shell.openPath(target);
  });
  ipcMain.handle("shell:openExternal", async (_event, target: string) => {
    const url = new URL(target);
    if (url.protocol !== "https:") throw new Error("HTTPS 다운로드 주소만 열 수 있습니다.");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle("modpack:sync", async (event, request: { packId: string; instanceDir: string }) => {
    const progress = (payload: SyncProgress) => event.sender.send("modpack:progress", payload);
    const manifest = await auth.getManifest(sessionUser, request.packId);
    assertManifest(manifest);
    return syncModpack({ instanceDir: request.instanceDir, manifest }, progress);
  });
  ipcMain.handle("account:login", (_event, provider: LoginProvider) => auth.startLogin(provider));
  ipcMain.handle("account:logout", async () => {
    await auth.signOut();
    sessionUser = null;
    return { loggedIn: false, allowed: false, isAdmin: false, reason: "런처 계정에서 로그아웃했습니다." };
  });
  ipcMain.handle("access:status", () => auth.getAccessStatus(sessionUser));
  ipcMain.handle("access:redeemInvite", (_event, code: string) => auth.redeemInvite(sessionUser, code));
  ipcMain.handle("access:createInvite", () => auth.createInvite(sessionUser));
  ipcMain.handle("invite:ready", () => {
    inviteReceiverReady = true;
    const firstInvite = pendingInviteCodes.shift() ?? null;
    void processPendingDeepLinks();
    return firstInvite;
  });
  ipcMain.handle("server:connection", () => readServerConnection(defaultServer));
  ipcMain.handle("server:saveConnection", (_event, connection: unknown) => writeServerConnection(connection, defaultServer));
  ipcMain.handle("server:resetConnection", () => resetServerConnection(defaultServer));
  ipcMain.handle("launcher:checkUpdate", () => checkLauncherUpdate());
  ipcMain.handle("game:launch", async (event, request: { packId: string; instanceDir: string }) => {
    const progress = (payload: SyncProgress) => event.sender.send("modpack:progress", payload);
    const manifest = await auth.getManifest(sessionUser, request.packId);
    assertManifest(manifest);
    const server = await readServerConnection(defaultServer);
    const configuredManifest = { ...manifest, server };
    const synced = await syncModpack({ instanceDir: request.instanceDir, manifest: configuredManifest }, progress);
    if (!sessionUser) throw new Error("Discord 로그인이 필요합니다.");
    const launched = await installAndLaunch(configuredManifest, synced.instanceDir, await auth.createLaunchIdentity(sessionUser), progress);
    return { ...launched, instanceDir: synced.instanceDir };
  });

  createWindow();
  void (async () => {
    try {
      sessionUser = await auth.restoreUser();
      if (sessionUser) notifySession(sessionUser);
    } catch {
      // The renderer will show its normal signed-out state when a persisted session cannot be restored.
    }
    await processPendingDeepLinks();
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
