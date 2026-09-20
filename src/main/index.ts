import { app, BrowserWindow, clipboard, ipcMain, session, shell } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getServerPresets } from "./catalog.js";
import { assertManifest, syncModpack } from "./sync.js";
import { checkServer } from "./server-status.js";
import { LoginCancelledError, SupabaseAuth } from "./supabase-auth.js";
import { installAndLaunch } from "./minecraft-runtime.js";
import { AuthCallbackError, isLauncherActivationLink, parseAuthCallback, parseInviteLink } from "./deep-link.js";
import { authFingerprint, authLogPath, writeAuthLog } from "./auth-log.js";
import { gameErrorDetails, gameLogPath, writeGameLog } from "./game-log.js";
import { readServerConnection, resetServerConnection, writeServerConnection } from "./server-config.js";
import { downloadLauncherUpdate, getLauncherUpdateStatus, installPendingLauncherUpdate, startLauncherUpdates } from "./launcher-update.js";
import { createOfflineLaunchIdentity } from "./launch-identity.js";
import { captureSharedOptions, prepareUserContent, userContentRoot } from "./user-content.js";
import { defaultInstanceRoot, getLauncherChannel, launcherProtocolScheme, launcherWindowTitle } from "./launcher-channel.js";
import type { GameStatus, LauncherUpdateStatus, LauncherUser, SyncProgress } from "../shared/types.js";
import type { ModpackManifest } from "../shared/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sessionUser: LauncherUser | null = null;
const auth = new SupabaseAuth();
const pendingAuthUrls: string[] = [];
const queuedAuthCallbacks = new Set<string>();
const completedAuthFlows = new Set<string>();
let deepLinkProcessing: Promise<void> | null = null;
const pendingInviteCodes: string[] = [];
let inviteReceiverReady = false;
let gameStatus: GameStatus = { state: "idle" };
let gameRunId = 0;
const testLauncherSetupUrl = "https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.25-test.1/Bweeep-Test-Setup-0.1.25.exe";

async function readBundledManifest(packId: string): Promise<ModpackManifest> {
  const manifestPath = path.join(app.getAppPath(), "resources", "manifests", `${packId}.json`);
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as ModpackManifest;
  assertManifest(manifest);
  return manifest;
}

function setGameStatus(status: GameStatus): void {
  gameStatus = status;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("game:status", status);
  }
  if (status.state === "idle") installPendingLauncherUpdate();
}

function publishLauncherUpdate(status: LauncherUpdateStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("launcher:updateStatus", status);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerDeepLinkProtocol();
}

function registerDeepLinkProtocol(): void {
  const scheme = launcherProtocolScheme();
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(scheme);
  }
}

function collectDeepLink(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${launcherProtocolScheme()}://`));
}

function queueDeepLink(url: string, source: "argv" | "second-instance" | "open-url"): void {
  if (isLauncherActivationLink(url, launcherProtocolScheme())) {
    const window = BrowserWindow.getAllWindows()[0];
    if (window?.isMinimized()) window.restore();
    window?.focus();
    return;
  }
  if (url.startsWith(`${launcherProtocolScheme()}://invite/`)) {
    try {
      pendingInviteCodes.push(parseInviteLink(url, launcherProtocolScheme()));
    } catch (error) {
      notifyAuthError(error);
    }
  } else {
    const callbackId = authFingerprint(url);
    if (queuedAuthCallbacks.has(callbackId)) {
      void writeAuthLog("callback.duplicate.ignored", { callbackId, source });
      return;
    }
    queuedAuthCallbacks.add(callbackId);
    pendingAuthUrls.push(url);
    const parsedUrl = new URL(url);
    void writeAuthLog("callback.queued", {
      callbackId,
      source,
      queueDepth: pendingAuthUrls.length,
      callbackProtocol: parsedUrl.protocol,
      callbackHost: parsedUrl.hostname,
      callbackPath: parsedUrl.pathname,
      parameterNames: [...parsedUrl.searchParams.keys()].sort(),
      flowId: parsedUrl.searchParams.get("sb_flow_id") ? authFingerprint(parsedUrl.searchParams.get("sb_flow_id")!) : null,
      stateId: parsedUrl.searchParams.get("state") ? authFingerprint(parsedUrl.searchParams.get("state")!) : null
    });
  }
  if (app.isReady()) schedulePendingDeepLinks();
}

function schedulePendingDeepLinks(): void {
  if (deepLinkProcessing) return;
  deepLinkProcessing = processPendingDeepLinks().finally(() => {
    deepLinkProcessing = null;
    if (pendingAuthUrls.length > 0 || (inviteReceiverReady && pendingInviteCodes.length > 0)) {
      schedulePendingDeepLinks();
    }
  });
}

async function processPendingDeepLinks(): Promise<void> {
  while (pendingAuthUrls.length > 0) {
    const url = pendingAuthUrls.shift();
    if (!url) continue;
    const callbackId = authFingerprint(url);
    try {
      const callback = parseAuthCallback(url, launcherProtocolScheme());
      const flowId = callback.flowId ? authFingerprint(callback.flowId) : null;
      sessionUser = await auth.completeCallback(url);
      if (flowId) completedAuthFlows.add(flowId);
      await writeAuthLog("callback.session.delivered", {
        callbackId,
        flowId,
        provider: "discord",
        userId: authFingerprint(sessionUser.id)
      });
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("auth:session", sessionUser);
      }
    } catch (error) {
      await auth.cancelPendingLogin(error instanceof AuthCallbackError ? error.category : "exchange_error");
      if (error instanceof LoginCancelledError) {
        await writeAuthLog("callback.cancelled_ignored", { callbackId });
        continue;
      }
      if (error instanceof AuthCallbackError && error.flowId) {
        const flowId = authFingerprint(error.flowId);
        if (completedAuthFlows.has(flowId)) {
          await writeAuthLog("callback.stale_error.ignored", { callbackId, flowId, category: error.category });
          continue;
        }
      }
      await writeAuthLog("callback.error.delivered", {
        callbackId,
        category: error instanceof AuthCallbackError ? error.category : "exchange_error",
        ...(error instanceof AuthCallbackError ? error.diagnostics : {}),
        message: error instanceof Error ? error.message : String(error)
      });
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

function notifyAuthError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("auth:error", message);
  }
}

void writeAuthLog("app.auth.initialized", { packaged: app.isPackaged, logPath: authLogPath() });

const initialDeepLink = collectDeepLink(process.argv);
if (initialDeepLink) queueDeepLink(initialDeepLink, "argv");

app.on("second-instance", (_event, argv) => {
  const url = collectDeepLink(argv);
  if (url) queueDeepLink(url, "second-instance");
  const window = BrowserWindow.getAllWindows()[0];
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  queueDeepLink(url, "open-url");
});

async function createWindow(): Promise<BrowserWindow> {
  const distRoot = path.resolve(__dirname, "..", "..");
  const win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 620,
    title: launcherWindowTitle(),
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    hasShadow: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: "#111315",
    webPreferences: {
      preload: path.join(distRoot, "src", "preload", "index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.removeMenu();

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(distRoot, "renderer", "index.html"));
  }
  return win;
}

app.whenReady().then(async () => {
  await session.defaultSession.setProxy({ mode: "system" });
  const launcherChannel = getLauncherChannel();
  const serverPresets = await getServerPresets(launcherChannel);
  const defaultServer = serverPresets[0]?.server;
  if (!defaultServer) throw new Error("사용 가능한 서버 manifest가 없습니다.");
  ipcMain.handle("catalog:list", () => getServerPresets(launcherChannel));
  ipcMain.handle("server:status", (_event, server: { host: string; port: number }) => checkServer(server));
  ipcMain.handle("paths:defaultInstanceRoot", () =>
    defaultInstanceRoot()
  );
  ipcMain.handle("paths:userContentRoot", (_event, instanceRoot: unknown) => {
    if (typeof instanceRoot !== "string" || !instanceRoot.trim()) throw new Error("설치 위치가 올바르지 않습니다.");
    return userContentRoot(instanceRoot);
  });
  ipcMain.handle("shell:openPath", async (_event, target: string) => {
    return shell.openPath(target);
  });
  ipcMain.handle("shell:openExternal", async (_event, target: string) => {
    const url = new URL(target);
    if (url.protocol !== "https:") throw new Error("HTTPS 다운로드 주소만 열 수 있습니다.");
    await shell.openExternal(url.toString());
  });
  ipcMain.handle("test-launcher:open", async () => {
    try {
      await shell.openExternal("bwe-e-ep-test://open");
    } catch {
      await shell.openExternal(testLauncherSetupUrl);
    }
  });
  ipcMain.handle("launcher:channel", () => getLauncherChannel());
  ipcMain.handle("launcher:version", () => app.getVersion());
  ipcMain.handle("clipboard:writeText", (_event, value: string) => clipboard.writeText(value));
  ipcMain.handle("account:login", () => auth.startLogin());
  ipcMain.handle("account:cancelLogin", () => auth.cancelPendingLogin("user_cancelled"));
  ipcMain.handle("account:logout", async () => {
    await auth.signOut();
    sessionUser = null;
    return { loggedIn: false, allowed: false, isAdmin: false, reason: "런처 계정에서 로그아웃했습니다." };
  });
  ipcMain.handle("access:status", async () => {
    try {
      const status = await auth.getAccessStatus(sessionUser);
      if (!status.loggedIn) sessionUser = null;
      return status;
    } catch (error) {
      if (!sessionUser) throw error;
      return {
        loggedIn: true,
        allowed: false,
        isAdmin: false,
        unavailable: true,
        reason: error instanceof Error ? error.message : "접근 권한을 확인하지 못했습니다.",
        user: sessionUser
      };
    }
  });
  ipcMain.handle("access:redeemInvite", (_event, code: string) => auth.redeemInvite(sessionUser, code));
  ipcMain.handle("access:createInvite", (_event, maxUses: unknown) =>
    auth.createInvite(sessionUser, typeof maxUses === "number" ? maxUses : 1)
  );
  ipcMain.handle("account:setGameProfile", async (_event, gameName: unknown) => {
    if (typeof gameName !== "string") throw new Error("인게임 이름 형식이 올바르지 않습니다.");
    sessionUser = await auth.setGameProfile(sessionUser, gameName);
    return sessionUser;
  });
  ipcMain.handle("invite:ready", () => {
    inviteReceiverReady = true;
    const firstInvite = pendingInviteCodes.shift() ?? null;
    void processPendingDeepLinks();
    return firstInvite;
  });
  ipcMain.handle("server:connection", () => readServerConnection(defaultServer));
  ipcMain.handle("server:saveConnection", (_event, connection: unknown) => writeServerConnection(connection, defaultServer));
  ipcMain.handle("server:resetConnection", () => resetServerConnection(defaultServer));
  ipcMain.handle("launcher:checkUpdate", () => getLauncherUpdateStatus());
  ipcMain.handle("launcher:downloadUpdate", () => downloadLauncherUpdate());
  ipcMain.on("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("game:status", () => gameStatus);
  ipcMain.handle("game:launch", async (event, request: { packId: string; instanceDir: string }) => {
    if (gameStatus.state !== "idle") {
      throw new Error("Minecraft가 이미 시작 중이거나 실행 중입니다.");
    }
    const runId = ++gameRunId;
    setGameStatus({ state: "starting" });
    const progress = (payload: SyncProgress) => event.sender.send("modpack:progress", payload);
    await writeGameLog("launch.started", { packId: request.packId });
    try {
      await writeGameLog("launch.manifest.requested", { packId: request.packId });
      const manifest = request.packId === "vanilla-survival"
        ? await readBundledManifest(request.packId)
        : await auth.getManifest(sessionUser, request.packId);
      assertManifest(manifest);
      const server = await readServerConnection(defaultServer);
      const configuredManifest = { ...manifest, server };
      await writeGameLog("launch.modpack.syncing", { packId: request.packId, files: configuredManifest.files.length });
      const synced = await syncModpack({ instanceDir: request.instanceDir, manifest: configuredManifest }, progress);
      const userContent = await prepareUserContent(request.instanceDir, synced.instanceDir);
      progress({ kind: "info", message: `내 모드 ${userContent.copiedMods}개 적용 · 서버 전용 모드 ${userContent.removedManagedMods}개 정리` });
      if (!sessionUser) throw new Error("로그인 세션이 없습니다.");
      const launchUser = sessionUser;
      await writeGameLog("launch.minecraft.installing", { minecraft: configuredManifest.minecraftVersion, loader: configuredManifest.loader.version });
      const clientModsDir = path.join(app.getAppPath(), "resources", "client-mods");
      const bundledClientMods = configuredManifest.loader.kind === "neoforge" ? [
        {
          sourcePath: path.join(clientModsDir, "bweeep-client-1.2.0.jar"),
          targetName: "bweeep-client.jar",
          sha256: "4c8840d126f1939a1e66182cc086f3293bd0a8f75d5780d89df94ba23f02e70b"
        },
        {
          sourcePath: path.join(clientModsDir, "bweeep-display-name-0.2.0.jar"),
          targetName: "bweeep-display-name.jar",
          sha256: "23f0c716cc8cb857ecf384f648a5c493745dd1bc9f53d1ab04ca9c40b632fed2"
        }
      ] : [];
      const getLaunchAuthorization = configuredManifest.loader.kind === "vanilla"
        ? async () => ({
            identity: createOfflineLaunchIdentity(launchUser.id, launchUser.gameName, launchUser.globalName, launchUser.username),
            ticket: ""
          })
        : async () => {
            await writeGameLog("launch.authorization.requested", { provider: "discord" });
            const authorization = await auth.createGameLaunchAuthorization(launchUser);
            await writeGameLog("launch.authorization.created", { provider: "discord" });
            return authorization;
          };
      const launched = await installAndLaunch(configuredManifest, synced.instanceDir, getLaunchAuthorization, bundledClientMods, progress, () => {
        if (gameRunId === runId) setGameStatus({ state: "idle" });
        void captureSharedOptions(request.instanceDir, synced.instanceDir);
        void writeGameLog("launch.minecraft.exited", { packId: request.packId });
      });
      if (gameRunId === runId) {
        setGameStatus({ state: "running", pid: launched.pid });
      }
      await writeGameLog("launch.succeeded", { packId: request.packId, version: launched.version });
      return { ...launched, instanceDir: synced.instanceDir };
    } catch (error) {
      if (gameRunId === runId) setGameStatus({ state: "idle" });
      const details = gameErrorDetails(error);
      await writeGameLog("launch.failed", details);
      throw new Error(`${details.message} (로그: ${gameLogPath()})`);
    }
  });

  void (async () => {
    try {
      sessionUser = await auth.restoreUser();
    } catch {
      // The renderer will show its normal signed-out state when a persisted session cannot be restored.
    }
    await createWindow();
    startLauncherUpdates(publishLauncherUpdate, () => gameStatus.state === "idle");
    schedulePendingDeepLinks();
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
