const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type {
  AccessStatus,
  CreatedInvite,
  GameStatus,
  InviteList,
  LogTarget,
  LauncherUser,
  LoginCancellationResult,
  LoginResult,
  InviteResult,
  LaunchResult,
  LauncherUpdateStatus,
  ServerPreset,
  ServerStatus,
  SyncProgress,
  UserContentFolders,
  UserContentKind,
  UserContentFolderPickResult
} from "../shared/types.js";

/** Returns an unsubscribe function so React effects can clean up. */
function subscribe<T>(channel: string) {
  return (callback: (payload: T) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: T) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.off(channel, listener);
    };
  };
}

const api = {
  listServers: () => ipcRenderer.invoke("catalog:list") as Promise<ServerPreset[]>,
  serverStatus: (server: { host: string; port: number }) => ipcRenderer.invoke("server:status", server) as Promise<ServerStatus>,
  defaultInstanceRoot: () => ipcRenderer.invoke("paths:defaultInstanceRoot") as Promise<string>,
  userContentFolders: (instanceRoot: string) => ipcRenderer.invoke("content:folders", instanceRoot) as Promise<UserContentFolders>,
  chooseUserContentFolders: (instanceRoot: string, kind: UserContentKind) => ipcRenderer.invoke("content:chooseFolders", instanceRoot, kind) as Promise<UserContentFolderPickResult>,
  removeUserContentFolder: (instanceRoot: string, kind: UserContentKind, folder: string) => ipcRenderer.invoke("content:removeFolder", instanceRoot, kind, folder) as Promise<UserContentFolders>,
  login: () => ipcRenderer.invoke("account:login") as Promise<LoginResult>,
  cancelLogin: () => ipcRenderer.invoke("account:cancelLogin") as Promise<LoginCancellationResult>,
  logout: () => ipcRenderer.invoke("account:logout") as Promise<AccessStatus>,
  accessStatus: () => ipcRenderer.invoke("access:status") as Promise<AccessStatus>,
  redeemInvite: (code: string) => ipcRenderer.invoke("access:redeemInvite", code) as Promise<InviteResult>,
  createInvite: (maxUses: number) => ipcRenderer.invoke("access:createInvite", maxUses) as Promise<CreatedInvite>,
  listInvites: () => ipcRenderer.invoke("access:listInvites") as Promise<InviteList>,
  revokeInvite: (inviteId: string) => ipcRenderer.invoke("access:revokeInvite", inviteId) as Promise<void>,
  chooseInstanceRoot: (current: string) => ipcRenderer.invoke("paths:chooseInstanceRoot", current) as Promise<string | null>,
  openLog: (target: LogTarget) => ipcRenderer.invoke("logs:open", target) as Promise<void>,
  stopGame: () => ipcRenderer.invoke("game:stop") as Promise<void>,
  setGameProfile: (gameName: string) => ipcRenderer.invoke("account:setGameProfile", gameName) as Promise<LauncherUser>,
  readyForInvite: () => ipcRenderer.invoke("invite:ready") as Promise<string | null>,
  checkLauncherUpdate: () => ipcRenderer.invoke("launcher:checkUpdate") as Promise<LauncherUpdateStatus>,
  launcherChannel: () => ipcRenderer.invoke("launcher:channel") as Promise<"production" | "test">,
  launcherVersion: () => ipcRenderer.invoke("launcher:version") as Promise<string>,
  launchGame: (request: { packId: string; instanceDir: string }) => ipcRenderer.invoke("game:launch", request) as Promise<LaunchResult>,
  gameStatus: () => ipcRenderer.invoke("game:status") as Promise<GameStatus>,
  openPath: (target: string) => ipcRenderer.invoke("shell:openPath", target) as Promise<string>,
  copyText: (value: string) => ipcRenderer.invoke("clipboard:writeText", value) as Promise<void>,
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  onProgress: subscribe<SyncProgress>("modpack:progress"),
  onGameStatus: subscribe<GameStatus>("game:status"),
  onLauncherUpdate: subscribe<LauncherUpdateStatus>("launcher:updateStatus"),
  onAuthSession: subscribe<LauncherUser>("auth:session"),
  onAuthError: subscribe<string>("auth:error"),
  onInviteReceived: subscribe<string>("invite:received")
};

contextBridge.exposeInMainWorld("bweeep", api);

export type BweeepApi = typeof api;
