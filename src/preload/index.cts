const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type {
  AccessStatus,
  CreatedInvite,
  LauncherUser,
  LoginProvider,
  LoginResult,
  InviteResult,
  LaunchResult,
  LauncherUpdateStatus,
  ServerConnection,
  ServerPreset,
  ServerStatus,
  SyncProgress,
  SyncRequest,
  SyncResult
} from "../shared/types.js";

const api = {
  listServers: () => ipcRenderer.invoke("catalog:list") as Promise<ServerPreset[]>,
  serverStatus: (server: { host: string; port: number }) => ipcRenderer.invoke("server:status", server) as Promise<ServerStatus>,
  defaultInstanceRoot: () => ipcRenderer.invoke("paths:defaultInstanceRoot") as Promise<string>,
  login: (provider: LoginProvider) => ipcRenderer.invoke("account:login", provider) as Promise<LoginResult>,
  logout: () => ipcRenderer.invoke("account:logout") as Promise<AccessStatus>,
  accessStatus: () => ipcRenderer.invoke("access:status") as Promise<AccessStatus>,
  redeemInvite: (code: string) => ipcRenderer.invoke("access:redeemInvite", code) as Promise<InviteResult>,
  createInvite: () => ipcRenderer.invoke("access:createInvite") as Promise<CreatedInvite>,
  readyForInvite: () => ipcRenderer.invoke("invite:ready") as Promise<string | null>,
  serverConnection: () => ipcRenderer.invoke("server:connection") as Promise<ServerConnection>,
  saveServerConnection: (connection: ServerConnection) => ipcRenderer.invoke("server:saveConnection", connection) as Promise<ServerConnection>,
  resetServerConnection: () => ipcRenderer.invoke("server:resetConnection") as Promise<ServerConnection>,
  checkLauncherUpdate: () => ipcRenderer.invoke("launcher:checkUpdate") as Promise<LauncherUpdateStatus>,
  syncModpack: (request: { packId: string; instanceDir: string }) => ipcRenderer.invoke("modpack:sync", request) as Promise<SyncResult>,
  launchGame: (request: { packId: string; instanceDir: string }) => ipcRenderer.invoke("game:launch", request) as Promise<LaunchResult>,
  openPath: (target: string) => ipcRenderer.invoke("shell:openPath", target) as Promise<string>,
  openExternal: (target: string) => ipcRenderer.invoke("shell:openExternal", target) as Promise<void>,
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  onProgress: (callback: (event: SyncProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: SyncProgress) => callback(payload);
    ipcRenderer.on("modpack:progress", listener);
    return () => ipcRenderer.off("modpack:progress", listener);
  },
  onAuthSession: (callback: (user: LauncherUser) => void) => {
    const listener = (_: Electron.IpcRendererEvent, user: LauncherUser) => callback(user);
    ipcRenderer.on("auth:session", listener);
    return () => ipcRenderer.off("auth:session", listener);
  },
  onAuthError: (callback: (message: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("auth:error", listener);
    return () => ipcRenderer.off("auth:error", listener);
  },
  onInviteCode: (callback: (code: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, code: string) => callback(code);
    ipcRenderer.on("invite:received", listener);
    return () => ipcRenderer.off("invite:received", listener);
  }
};

contextBridge.exposeInMainWorld("bweeep", api);

export type BweeepApi = typeof api;
