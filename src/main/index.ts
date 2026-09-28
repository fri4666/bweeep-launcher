import { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { presetsFromManifests, requireBweeepAccounts } from "./catalog.js";
import { assertManifest, syncModpack } from "./sync.js";
import { checkServer } from "./server-status.js";
import { LoginCancelledError, SupabaseAuth } from "./supabase-auth.js";
import type { LaunchAuthorization } from "./minecraft-runtime.js";
import { authlibInjectorJvmArgs, ensureAuthlibInjector } from "./authlib-injector.js";
import { AuthCallbackError, isLauncherActivationLink, parseAuthCallback, parseInviteLink } from "./deep-link.js";
import { fingerprint } from "./hash.js";
import { authLogPath, gameErrorDetails, gameLogPath, writeAuthLog, writeGameLog } from "./logs.js";
import { getLauncherUpdateStatus, installPendingLauncherUpdate, setLauncherUpdateAudience, startLauncherUpdates } from "./launcher-update.js";
import { isCatalogServer, isSameDocument } from "./navigation.js";
import { loadPatchNotes } from "./patch-notes.js";
import { isReleasePageUrl } from "./release-notes.js";
import { addUserContentFolders, captureSharedOptions, getUserContentFolders, prepareUserContent, removeUserContentFolder } from "./user-content.js";
import { defaultInstanceRoot, getLauncherChannel, launcherProtocolScheme, launcherWindowTitle } from "./launcher-channel.js";
import type { GameStatus, LauncherUser, LogTarget, ModTarget, ServerPreset, SkinModel, SkinState, SyncProgress, UserContentKind } from "../shared/types.js";
import { findBlockedJars, installMod, listPersonalMods, removeMod, searchMods, setModrinthUserAgent, updateMod } from "./modrinth.js";
import { bundledFeatureMods } from "./client-feature-mods.js";
import { connectionGuardEnabled, connectionGuardJvmArgs, ensureConnectionGuard } from "./connection-guard.js";
import { markWhatsNewSeen, pendingWhatsNew } from "./whats-new.js";
import { findDefaultSkins, SkinLibrary } from "./skins.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let sessionUser: LauncherUser | null = null;
const auth = new SupabaseAuth();
const skinLibrary = new SkinLibrary(path.join(app.getPath("userData"), "skins"));
const pendingAuthUrls: string[] = [];
const queuedAuthCallbacks = new Set<string>();
const completedAuthFlows = new Set<string>();
let deepLinkProcessing: Promise<void> | null = null;
const pendingInviteCodes: string[] = [];
let inviteReceiverReady = false;
let gameStatus: GameStatus = { state: "idle" };
let gameRunId = 0;
let stopRequestedRunId = 0;
// The most useful file to open after a failed or crashed run.
let lastGameLogFile: string | null = null;
// Testers and admins get beta launcher builds and see beta patch notes.
let testerAudience = false;

function setTesterAudience(tester: boolean): void {
  testerAudience = tester;
  setLauncherUpdateAudience(tester);
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
}

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (window?.isMinimized()) window.restore();
  window?.focus();
}

function setGameStatus(status: GameStatus): void {
  gameStatus = status;
  broadcast("game:status", status);
  if (status.state === "idle") installPendingLauncherUpdate();
}

/**
 * A downloaded launcher update restarts the launcher only while no game is
 * starting or running. After a crash the player is reading the error, so the
 * restart waits for their click on the update icon (or the next start).
 */
function mayRestartForUpdate(playerAsked: boolean): boolean {
  return gameStatus.state === "idle" && (playerAsked || gameStatus.exitError !== true);
}

// A function call keeps TypeScript from narrowing gameStatus across awaits,
// where the exit callback may already have changed it.
function gameIsStarting(): boolean {
  return gameStatus.state === "starting";
}

function requireInstanceRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) {
    throw new Error("설치 위치가 올바르지 않습니다.");
  }
  return path.resolve(value);
}

// Server presets from the last catalog load. Mod requests take the loader,
// version and blocked mods from here, never from the renderer.
const catalogPresets = new Map<string, ServerPreset>();

async function loadCatalog(): Promise<ServerPreset[]> {
  if (!sessionUser) return [];
  const presets = presetsFromManifests(await auth.listManifests(sessionUser), (manifest, reason) => {
    const id = manifest && typeof manifest === "object" && "id" in manifest ? String(manifest.id) : null;
    void writeGameLog("catalog.manifest.skipped", { packId: id, reason });
  });
  catalogPresets.clear();
  for (const preset of presets) catalogPresets.set(preset.packId, preset);
  return presets;
}

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

function requireLaunchRequest(value: unknown): { packId: string; instanceDir: string; withoutPersonalMods: boolean } {
  const request = value as { packId?: unknown; instanceDir?: unknown; withoutPersonalMods?: unknown } | null;
  if (typeof request?.packId !== "string" || !PACK_ID.test(request.packId)) throw new Error("서버 정보가 올바르지 않습니다.");
  return { packId: request.packId, instanceDir: requireInstanceRoot(request.instanceDir), withoutPersonalMods: request.withoutPersonalMods === true };
}

async function requireModTarget(value: unknown): Promise<ModTarget> {
  const target = value as Partial<ModTarget> | null;
  const packId = target?.packId;
  if (typeof packId !== "string" || !PACK_ID.test(packId)) throw new Error("서버 정보가 올바르지 않습니다.");
  if (!catalogPresets.has(packId)) await loadCatalog();
  const preset = catalogPresets.get(packId);
  if (!preset) throw new Error("서버 정보를 찾지 못했습니다. 서버 목록을 새로 불러와 주세요.");
  return {
    instanceRoot: requireInstanceRoot(target?.instanceRoot),
    packId,
    loader: preset.loader.kind,
    minecraftVersion: preset.minecraftVersion,
    blockedModrinthProjects: preset.blockedModrinthProjects
  };
}

function optionalInstanceRoot(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requireSkinModel(value: unknown): SkinModel {
  if (value !== "default" && value !== "slim") throw new Error("팔 모양 정보가 올바르지 않습니다.");
  return value;
}

/**
 * Server skin plus the local library; a skin set on another PC is saved here
 * too. The library and preview still work when the server cannot be reached.
 */
async function skinState(instanceRoot: string | null): Promise<SkinState> {
  let serverError: string | undefined;
  const [server, defaults] = await Promise.all([
    auth.getSkin(sessionUser).catch((error: unknown) => {
      serverError = error instanceof Error ? error.message : String(error);
      return null;
    }),
    instanceRoot ? findDefaultSkins(instanceRoot) : Promise.resolve([])
  ]);
  if (server && !(await skinLibrary.get(server.hash))) {
    try {
      const response = await fetch(await auth.skinUrl(server.hash));
      if (response.ok) await skinLibrary.add(Buffer.from(await response.arrayBuffer()), "적용된 스킨", server.model, { asStored: true });
    } catch {
      // The library and preview still work; the applied skin shows up once the file can be fetched.
    }
  }
  const library = await skinLibrary.list();
  const applied = server ? library.find((entry) => entry.id === server.hash) : undefined;
  return {
    current: server && applied ? { id: server.hash, model: server.model, dataUrl: applied.dataUrl } : null,
    library,
    defaults,
    ...(serverError ? { serverError } : {})
  };
}

function requireContentKind(value: unknown): UserContentKind {
  if (value !== "mods" && value !== "shaderpacks") throw new Error("콘텐츠 종류가 올바르지 않습니다.");
  return value;
}

async function pickFolders(event: IpcMainInvokeEvent, options: OpenDialogOptions): Promise<string[] | null> {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return picked.canceled ? null : picked.filePaths;
}

// Windows has no default app for .log files, so openPath shows the
// "choose an app" prompt there. Notepad ships with Windows and reads them.
async function openLogFile(file: string): Promise<boolean> {
  // The crash report path comes from the game's own output, so only text files are ever opened, never run.
  if (![".log", ".txt"].includes(path.extname(file).toLowerCase())) return false;
  if (process.platform !== "win32" || path.extname(file).toLowerCase() !== ".log") {
    return !(await shell.openPath(file));
  }
  return new Promise((resolve) => {
    const child = spawn("notepad.exe", [file], { detached: true, stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
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

function queueDeepLink(url: string, source: "argv" | "second-instance"): void {
  if (isLauncherActivationLink(url, launcherProtocolScheme())) {
    focusMainWindow();
    return;
  }
  if (url.startsWith(`${launcherProtocolScheme()}://invite/`)) {
    try {
      pendingInviteCodes.push(parseInviteLink(url, launcherProtocolScheme()));
    } catch (error) {
      notifyAuthError(error);
    }
  } else {
    const callbackId = fingerprint(url);
    if (queuedAuthCallbacks.has(callbackId)) {
      void writeAuthLog("callback.duplicate.ignored", { callbackId, source });
      return;
    }
    // Any web page can open a bwe-e-ep:// link; one that is not even a URL must not crash the launcher at startup.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      void writeAuthLog("callback.malformed.ignored", { callbackId, source });
      return;
    }
    queuedAuthCallbacks.add(callbackId);
    pendingAuthUrls.push(url);
    const flowId = parsedUrl.searchParams.get("sb_flow_id");
    const state = parsedUrl.searchParams.get("state");
    void writeAuthLog("callback.queued", {
      callbackId,
      source,
      queueDepth: pendingAuthUrls.length,
      callbackProtocol: parsedUrl.protocol,
      callbackHost: parsedUrl.hostname,
      callbackPath: parsedUrl.pathname,
      parameterNames: [...parsedUrl.searchParams.keys()].sort(),
      flowId: flowId ? fingerprint(flowId) : null,
      stateId: state ? fingerprint(state) : null
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
    const callbackId = fingerprint(url);
    try {
      const callback = parseAuthCallback(url, launcherProtocolScheme());
      const flowId = callback.flowId ? fingerprint(callback.flowId) : null;
      sessionUser = await auth.completeCallback(url);
      if (flowId) completedAuthFlows.add(flowId);
      await writeAuthLog("callback.session.delivered", {
        callbackId,
        flowId,
        provider: "discord",
        userId: fingerprint(sessionUser.id)
      });
      broadcast("auth:session", sessionUser);
    } catch (error) {
      await auth.cancelPendingLogin(error instanceof AuthCallbackError ? error.category : "exchange_error");
      if (error instanceof LoginCancelledError) {
        await writeAuthLog("callback.cancelled_ignored", { callbackId });
        continue;
      }
      if (error instanceof AuthCallbackError && error.flowId) {
        const flowId = fingerprint(error.flowId);
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
    if (code) broadcast("invite:received", code);
  }
}

function notifyAuthError(error: unknown): void {
  broadcast("auth:error", error instanceof Error ? error.message : String(error));
}

void writeAuthLog("app.auth.initialized", { packaged: app.isPackaged, logPath: authLogPath() });

const initialDeepLink = collectDeepLink(process.argv);
if (initialDeepLink) queueDeepLink(initialDeepLink, "argv");

app.on("second-instance", (_event, argv) => {
  const url = collectDeepLink(argv);
  if (url) queueDeepLink(url, "second-instance");
  focusMainWindow();
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

// The preload bridge belongs to the launcher's own page only: no other page,
// popup or embedded view may load in its place, and the page asks for no
// browser permissions (camera, notifications, …).
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (navigation, url) => {
    if (!isSameDocument(contents.getURL(), url)) navigation.preventDefault();
  });
  contents.on("will-attach-webview", (attach) => attach.preventDefault());
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  await session.defaultSession.setProxy({ mode: "system" });
  setModrinthUserAgent(app.getVersion());
  ipcMain.handle("catalog:list", () => loadCatalog());
  ipcMain.handle("server:status", (_event, server: unknown) => {
    if (!isCatalogServer(server, [...catalogPresets.values()].map((preset) => preset.server))) throw new Error("서버 목록에 없는 주소입니다.");
    return checkServer({ host: server.host, port: server.port });
  });
  ipcMain.handle("paths:defaultInstanceRoot", () => defaultInstanceRoot());
  ipcMain.handle("content:folders", (_event, instanceRoot: unknown) => getUserContentFolders(requireInstanceRoot(instanceRoot)));
  ipcMain.handle("content:chooseFolders", async (event, instanceRoot: unknown, kind: unknown) => {
    const root = requireInstanceRoot(instanceRoot);
    const contentKind = requireContentKind(kind);
    const before = await getUserContentFolders(root);
    const picked = await pickFolders(event, {
      title: contentKind === "mods" ? "내 모드 폴더 선택" : "내 셰이더 폴더 선택",
      buttonLabel: "선택한 폴더 추가",
      properties: ["openDirectory", "multiSelections"]
    });
    if (!picked) return { folders: before, selected: 0 };
    const folders = await addUserContentFolders(root, contentKind, picked);
    return { folders, selected: folders[contentKind].length - before[contentKind].length };
  });
  ipcMain.handle("content:removeFolder", (_event, instanceRoot: unknown, kind: unknown, folder: unknown) => {
    if (typeof folder !== "string") throw new Error("콘텐츠 폴더 정보가 올바르지 않습니다.");
    return removeUserContentFolder(requireInstanceRoot(instanceRoot), requireContentKind(kind), folder);
  });
  // Only the install folder is opened from the renderer, so anything that is not a folder is refused.
  ipcMain.handle("shell:openPath", async (_event, target: unknown) => {
    const folder = requireInstanceRoot(target);
    if (!(await fsp.stat(folder).catch(() => null))?.isDirectory()) return "폴더를 찾지 못했습니다.";
    return shell.openPath(folder);
  });
  ipcMain.handle("launcher:channel", () => getLauncherChannel());
  ipcMain.handle("launcher:version", () => app.getVersion());
  ipcMain.handle("clipboard:writeText", (_event, value: unknown) => {
    if (typeof value !== "string" || value.length > 200_000) throw new Error("복사할 내용이 올바르지 않습니다.");
    clipboard.writeText(value);
  });
  ipcMain.handle("account:login", () => auth.startLogin());
  ipcMain.handle("account:cancelLogin", () => auth.cancelPendingLogin("user_cancelled"));
  ipcMain.handle("account:logout", async () => {
    await auth.signOut();
    sessionUser = null;
    setTesterAudience(false);
    return { loggedIn: false, allowed: false, isAdmin: false, reason: "런처 계정에서 로그아웃했습니다." };
  });
  ipcMain.handle("access:status", async () => {
    try {
      const status = await auth.getAccessStatus(sessionUser);
      if (!status.loggedIn) sessionUser = null;
      setTesterAudience(status.loggedIn && status.allowed && status.testAllowed === true);
      return status;
    } catch (error) {
      // An unreachable server says nothing new about who is signed in, so the update channel stays as it is.
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
  ipcMain.handle("access:listInvites", () => auth.listInvites(sessionUser));
  ipcMain.handle("access:revokeInvite", (_event, inviteId: unknown) => {
    if (typeof inviteId !== "string") throw new Error("초대 코드 정보가 올바르지 않습니다.");
    return auth.revokeInvite(sessionUser, inviteId);
  });
  ipcMain.handle("paths:chooseInstanceRoot", async (event, current: unknown) => {
    const picked = await pickFolders(event, {
      title: "게임 설치 위치 선택",
      buttonLabel: "이 폴더에 설치",
      defaultPath: typeof current === "string" && current.trim() ? current : undefined,
      properties: ["openDirectory", "createDirectory"]
    });
    return picked?.[0] ?? null;
  });
  ipcMain.handle("logs:open", async (_event, target: LogTarget) => {
    if (target === "game" && lastGameLogFile && await openLogFile(lastGameLogFile)) return;
    shell.showItemInFolder(gameLogPath());
  });
  ipcMain.handle("account:setGameProfile", async (_event, gameName: unknown) => {
    if (typeof gameName !== "string") throw new Error("인게임 이름 형식이 올바르지 않습니다.");
    sessionUser = await auth.setGameProfile(sessionUser, gameName);
    return sessionUser;
  });
  ipcMain.handle("access:listMembers", () => auth.listMembers(sessionUser));
  ipcMain.handle("access:setTester", (_event, userId: unknown, tester: unknown) => {
    if (typeof userId !== "string" || typeof tester !== "boolean") throw new Error("테스터 정보가 올바르지 않습니다.");
    return auth.setTester(sessionUser, userId, tester);
  });
  ipcMain.handle("mods:search", async (_event, target: unknown, query: unknown, offset: unknown) =>
    searchMods(await requireModTarget(target), typeof query === "string" ? query : "", typeof offset === "number" ? offset : 0));
  ipcMain.handle("mods:list", async (_event, target: unknown, checkUpdates: unknown) => listPersonalMods(await requireModTarget(target), checkUpdates === true));
  ipcMain.handle("mods:install", async (_event, target: unknown, projectId: unknown) => installMod(await requireModTarget(target), String(projectId)));
  ipcMain.handle("mods:update", async (_event, target: unknown, projectId: unknown) => updateMod(await requireModTarget(target), String(projectId)));
  ipcMain.handle("mods:remove", async (_event, target: unknown, projectId: unknown) => removeMod(await requireModTarget(target), String(projectId)));
  ipcMain.handle("skin:state", (_event, instanceRoot: unknown) => skinState(optionalInstanceRoot(instanceRoot)));
  ipcMain.handle("skin:add", async (event, instanceRoot: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = { title: "스킨 파일 선택", buttonLabel: "추가", filters: [{ name: "스킨 PNG", extensions: ["png"] }], properties: ["openFile"] };
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    const file = picked.canceled ? null : picked.filePaths[0];
    if (file) {
      const stat = await fsp.stat(file);
      if (stat.size > 64 * 1024) throw new Error("스킨 파일은 64KB 이하의 PNG여야 합니다.");
      await skinLibrary.add(await fsp.readFile(file), path.basename(file, path.extname(file)));
    }
    return skinState(optionalInstanceRoot(instanceRoot));
  });
  ipcMain.handle("skin:apply", async (_event, instanceRoot: unknown, id: unknown, model: unknown) => {
    const stored = typeof id === "string" ? await skinLibrary.get(id) : null;
    if (!stored) throw new Error("스킨을 찾지 못했습니다.");
    const skinModel = requireSkinModel(model);
    await skinLibrary.setModel(stored.entry.id, skinModel);
    await auth.setSkin(sessionUser, stored.png, skinModel);
    return skinState(optionalInstanceRoot(instanceRoot));
  });
  ipcMain.handle("skin:applyDefault", async (_event, instanceRoot: unknown, name: unknown) => {
    const root = optionalInstanceRoot(instanceRoot);
    const skin = (root ? await findDefaultSkins(root) : []).find((item) => item.name === name);
    if (!skin) throw new Error("기본 스킨을 찾지 못했습니다.");
    const png = Buffer.from(skin.dataUrl.slice(skin.dataUrl.indexOf(",") + 1), "base64");
    const entry = await skinLibrary.add(png, skin.name, skin.model);
    const stored = await skinLibrary.get(entry.id);
    if (!stored) throw new Error("기본 스킨을 저장하지 못했습니다.");
    await auth.setSkin(sessionUser, stored.png, skin.model);
    return skinState(root);
  });
  ipcMain.handle("skin:setModel", async (_event, instanceRoot: unknown, id: unknown, model: unknown) => {
    if (typeof id !== "string") throw new Error("스킨 정보가 올바르지 않습니다.");
    await skinLibrary.setModel(id, requireSkinModel(model));
    return skinState(optionalInstanceRoot(instanceRoot));
  });
  ipcMain.handle("skin:remove", async (_event, instanceRoot: unknown, id: unknown) => {
    if (typeof id !== "string") throw new Error("스킨 정보가 올바르지 않습니다.");
    // The applied skin would only come back from the server on the next refresh.
    const applied = await auth.getSkin(sessionUser).catch(() => null);
    if (applied?.hash === id) throw new Error("지금 적용 중인 스킨은 지울 수 없어요. 다른 스킨을 적용하거나 기본 스킨으로 돌린 뒤 지워 주세요.");
    await skinLibrary.remove(id);
    return skinState(optionalInstanceRoot(instanceRoot));
  });
  ipcMain.handle("skin:reset", async (_event, instanceRoot: unknown) => {
    await auth.clearSkin(sessionUser);
    return skinState(optionalInstanceRoot(instanceRoot));
  });
  ipcMain.handle("invite:ready", () => {
    inviteReceiverReady = true;
    const firstInvite = pendingInviteCodes.shift() ?? null;
    void processPendingDeepLinks();
    return firstInvite;
  });
  ipcMain.handle("launcher:checkUpdate", () => getLauncherUpdateStatus());
  ipcMain.handle("launcher:installUpdate", () => installPendingLauncherUpdate({ playerAsked: true }));
  ipcMain.handle("launcher:whatsNew", () => pendingWhatsNew());
  ipcMain.handle("launcher:whatsNewSeen", (_event, version: unknown) => markWhatsNewSeen(String(version)));
  ipcMain.handle("launcher:patchNotes", () => loadPatchNotes(testerAudience));
  ipcMain.handle("launcher:openReleasePage", (_event, url: unknown) => {
    if (!isReleasePageUrl(url)) throw new Error("열 수 없는 주소입니다.");
    return shell.openExternal(url);
  });
  // Fixed address: the test build's non-tester screen points to the stable installer.
  ipcMain.handle("launcher:openStableDownload", () => shell.openExternal("https://github.com/fri4666/bweeep-launcher/releases/latest"));
  ipcMain.on("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.on("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("game:status", () => gameStatus);
  ipcMain.handle("game:stop", async () => {
    if (gameStatus.state !== "running" || !gameStatus.pid) throw new Error("종료할 게임이 없습니다.");
    stopRequestedRunId = gameRunId;
    await writeGameLog("launch.minecraft.stop-requested", { pid: gameStatus.pid });
    process.kill(gameStatus.pid);
  });
  ipcMain.handle("game:launch", async (event, raw: unknown) => {
    const request = requireLaunchRequest(raw);
    if (gameStatus.state !== "idle") {
      throw new Error("Minecraft가 이미 시작 중이거나 실행 중입니다.");
    }
    const runId = ++gameRunId;
    const startedAt = Date.now();
    lastGameLogFile = null;
    setGameStatus({ state: "starting", startedAt });
    const progress = (payload: SyncProgress) => {
      if (!event.sender.isDestroyed()) event.sender.send("modpack:progress", payload);
      void writeGameLog("launch.progress", {
        kind: payload.kind,
        stage: payload.stage ?? null,
        message: payload.message,
        elapsedMs: payload.elapsedMs ?? null,
        completed: payload.completed ?? null,
        total: payload.total ?? null,
        unit: payload.unit ?? null,
        filePath: payload.filePath ?? null
      });
    };
    await writeGameLog("launch.started", { packId: request.packId });
    try {
      await writeGameLog("launch.manifest.requested", { packId: request.packId });
      progress({ kind: "info", stage: "서버 목록", message: "받는 중" });
      const manifest = await auth.getManifest(sessionUser, request.packId);
      assertManifest(manifest);
      if (manifest.id !== request.packId) throw new Error("선택한 서버와 받은 모드팩 정보가 일치하지 않습니다.");
      requireBweeepAccounts(manifest);
      const bundledClientMods = bundledFeatureMods(path.join(app.getAppPath(), "resources", "client-mods"), manifest);
      await writeGameLog("launch.modpack.syncing", { packId: request.packId, files: manifest.files.length });
      const synced = await syncModpack({ instanceDir: request.instanceDir, manifest }, progress);
      const withoutPersonalMods = request.withoutPersonalMods === true;
      const userContent = await prepareUserContent(request.instanceDir, synced.instanceDir, manifest, {
        withoutPersonalMods,
        findBlocked: (jars) => findBlockedJars(jars, manifest.blockedModrinthProjects ?? []),
        launcherJars: bundledClientMods.map((mod) => mod.sourcePath)
      });
      progress({
        kind: "info",
        stage: "개인 파일",
        message: withoutPersonalMods
          ? `개인 모드 없이 · 셰이더 ${userContent.copiedShaders}개`
          : `모드 ${userContent.copiedMods}개 · 셰이더 ${userContent.copiedShaders}개`
      });
      for (const skipped of userContent.skippedMods) {
        progress({ kind: "info", stage: "개인 모드 제외", message: `${skipped.name}: ${skipped.reason}`, filePath: skipped.name });
      }
      const guardArgs = connectionGuardEnabled(manifest)
        ? connectionGuardJvmArgs(await ensureConnectionGuard(path.join(app.getAppPath(), "resources", "java-agent"), synced.instanceDir), manifest)
        : [];
      if (!sessionUser) throw new Error("로그인 세션이 없습니다.");
      const launchUser = sessionUser;
      await writeGameLog("launch.minecraft.installing", { minecraft: manifest.minecraftVersion, loader: manifest.loader.version });
      // Every server checks players through the Bweeep account API (requireBweeepAccounts above).
      const getLaunchAuthorization = async (): Promise<LaunchAuthorization> => {
        await writeGameLog("launch.authorization.requested", { provider: "yggdrasil" });
        const { identity, launch } = await auth.createYggdrasilLaunch(launchUser);
        const agent = await ensureAuthlibInjector(path.join(app.getAppPath(), "resources", "authlib-injector"), synced.instanceDir);
        await writeGameLog("launch.authorization.created", { provider: "yggdrasil", apiRoot: launch.apiRoot });
        return { identity, ticket: "", yggdrasil: { jvmArgs: authlibInjectorJvmArgs(agent, launch) } };
      };
      lastGameLogFile = path.join(synced.instanceDir, "logs", "latest.log");
      // The Minecraft installer libraries are a large module graph, so they load on the first launch, not at startup.
      const { installAndLaunch } = await import("./minecraft-runtime.js");
      const launched = await installAndLaunch(manifest, synced.instanceDir, getLaunchAuthorization, bundledClientMods, progress, (exit) => {
        if (exit.crashReportLocation) lastGameLogFile = path.resolve(synced.instanceDir, exit.crashReportLocation);
        const stoppedByPlayer = stopRequestedRunId === runId;
        progress(stoppedByPlayer
          ? { kind: "info", stage: "게임 종료", message: "직접 끔" }
          : { kind: exit.abnormal ? "error" : "info", stage: "게임 종료", message: exit.message });
        if (gameRunId === runId) {
          setGameStatus(exit.abnormal && !stoppedByPlayer
            ? {
                state: "idle",
                exitMessage: exit.message,
                exitError: true,
                crashReport: Boolean(exit.crashReportLocation),
                // A crash with personal mods in the game may be theirs; the player can retry without them.
                retryWithoutPersonalMods: userContent.copiedMods > 0 ? request.packId : undefined
              }
            : { state: "idle" });
        }
        // The game token only matters while joining; once the game is gone it is retired.
        void auth.revokeGameAuth(launchUser).catch((error: unknown) =>
          writeGameLog("launch.token.revoke-failed", { message: error instanceof Error ? error.message : String(error) }));
        void captureSharedOptions(request.instanceDir, synced.instanceDir);
        void writeGameLog("launch.minecraft.exited", {
          packId: request.packId,
          code: exit.code,
          signal: exit.signal,
          abnormal: exit.abnormal,
          crashReportLocation: exit.crashReportLocation
        });
      }, guardArgs);
      if (gameRunId === runId && gameIsStarting()) {
        setGameStatus({ state: "running", pid: launched.pid, startedAt });
        await writeGameLog("launch.succeeded", { packId: request.packId, version: launched.version });
      } else {
        await writeGameLog("launch.exited-before-return", { packId: request.packId, version: launched.version });
      }
      return { ...launched, instanceDir: synced.instanceDir };
    } catch (error) {
      if (gameRunId === runId) setGameStatus({ state: "idle" });
      const details = gameErrorDetails(error);
      await writeGameLog("launch.failed", details);
      throw new Error(details.message);
    }
  });

  void (async () => {
    try {
      sessionUser = await auth.restoreUser();
    } catch {
      // The renderer will show its normal signed-out state when a persisted session cannot be restored.
    }
    await createWindow();
    startLauncherUpdates((status) => broadcast("launcher:updateStatus", status), mayRestartForUpdate);
    schedulePendingDeepLinks();
  })();
});
