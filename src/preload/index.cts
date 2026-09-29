const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type {
  AccessStatus,
  CreatedInvite,
  DiscordPresenceSetting,
  GameStatus,
  InstallMoveCheck,
  InviteList,
  LogTarget,
  LauncherUser,
  LoginCancellationResult,
  LoginResult,
  InviteResult,
  LaunchResult,
  LauncherUpdateStatus,
  MemberSummary,
  ModSearchResult,
  ModTarget,
  PatchNotes,
  PersonalMod,
  ServerPreset,
  ServerStatus,
  SkinModel,
  SkinState,
  SyncProgress,
  UserContentFolders,
  UserContentKind,
  UserContentFolderPickResult,
  WhatsNew
} from "../shared/types.js";
import type { AdminDiagnostics, AdminNames, AdminRelease, AuthFailure } from "../shared/admin-types.js";

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
  checkInstallMove: (from: string, to: string) => ipcRenderer.invoke("install:checkMove", from, to) as Promise<InstallMoveCheck>,
  moveInstall: (from: string, to: string) => ipcRenderer.invoke("install:move", from, to) as Promise<string>,
  finishInstallMove: (moveId: string) => ipcRenderer.invoke("install:finishMove", moveId) as Promise<void>,
  onInstallMoveProgress: subscribe<number>("install:moveProgress"),
  discordPresence: () => ipcRenderer.invoke("discord:presence") as Promise<DiscordPresenceSetting>,
  setDiscordPresence: (enabled: boolean) => ipcRenderer.invoke("discord:setPresence", enabled) as Promise<DiscordPresenceSetting>,
  openLog: (target: LogTarget) => ipcRenderer.invoke("logs:open", target) as Promise<void>,
  stopGame: () => ipcRenderer.invoke("game:stop") as Promise<void>,
  setGameProfile: (gameName: string) => ipcRenderer.invoke("account:setGameProfile", gameName) as Promise<LauncherUser>,
  readyForInvite: () => ipcRenderer.invoke("invite:ready") as Promise<string | null>,
  checkLauncherUpdate: () => ipcRenderer.invoke("launcher:checkUpdate") as Promise<LauncherUpdateStatus>,
  installLauncherUpdate: () => ipcRenderer.invoke("launcher:installUpdate") as Promise<void>,
  launcherChannel: () => ipcRenderer.invoke("launcher:channel") as Promise<"production" | "test">,
  launcherVersion: () => ipcRenderer.invoke("launcher:version") as Promise<string>,
  launchGame: (request: { packId: string; instanceDir: string; withoutPersonalMods?: boolean; memoryMb?: number }) => ipcRenderer.invoke("game:launch", request) as Promise<LaunchResult>,
  systemMemory: () => ipcRenderer.invoke("system:memory") as Promise<{ totalMb: number }>,
  whatsNew: () => ipcRenderer.invoke("launcher:whatsNew") as Promise<WhatsNew | null>,
  markWhatsNewSeen: (version: string) => ipcRenderer.invoke("launcher:whatsNewSeen", version) as Promise<void>,
  openStableDownload: () => ipcRenderer.invoke("launcher:openStableDownload") as Promise<void>,
  patchNotes: () => ipcRenderer.invoke("launcher:patchNotes") as Promise<PatchNotes>,
  openReleasePage: (url: string) => ipcRenderer.invoke("launcher:openReleasePage", url) as Promise<void>,
  listMembers: () => ipcRenderer.invoke("access:listMembers") as Promise<MemberSummary[]>,
  setTester: (userId: string, tester: boolean) => ipcRenderer.invoke("access:setTester", userId, tester) as Promise<MemberSummary[]>,
  setMemberRole: (userId: string, role: "admin" | "member") => ipcRenderer.invoke("admin:setRole", userId, role) as Promise<MemberSummary[]>,
  removeMember: (userId: string) => ipcRenderer.invoke("admin:removeMember", userId) as Promise<MemberSummary[]>,
  adminNames: () => ipcRenderer.invoke("admin:names") as Promise<AdminNames>,
  releaseName: (userId: string, gameName: string) => ipcRenderer.invoke("admin:releaseName", userId, gameName) as Promise<AdminNames>,
  deleteReservation: (minecraftUuid: string) => ipcRenderer.invoke("admin:deleteReservation", minecraftUuid) as Promise<AdminNames>,
  adminReleases: () => ipcRenderer.invoke("admin:releases") as Promise<AdminRelease[]>,
  activateRelease: (releaseId: string) => ipcRenderer.invoke("admin:activateRelease", releaseId) as Promise<AdminRelease[]>,
  adminDiagnostics: () => ipcRenderer.invoke("admin:diagnostics") as Promise<AdminDiagnostics>,
  openDiagnostics: (diagnosticId: string) => ipcRenderer.invoke("admin:openDiagnostics", diagnosticId) as Promise<void>,
  sendDiagnostics: () => ipcRenderer.invoke("diagnostics:send") as Promise<void>,
  searchMods: (target: ModTarget, query: string, offset: number) => ipcRenderer.invoke("mods:search", target, query, offset) as Promise<ModSearchResult>,
  personalMods: (target: ModTarget, checkUpdates: boolean) => ipcRenderer.invoke("mods:list", target, checkUpdates) as Promise<PersonalMod[]>,
  installMod: (target: ModTarget, projectId: string) => ipcRenderer.invoke("mods:install", target, projectId) as Promise<PersonalMod[]>,
  updateMod: (target: ModTarget, projectId: string) => ipcRenderer.invoke("mods:update", target, projectId) as Promise<PersonalMod[]>,
  removeMod: (target: ModTarget, projectId: string) => ipcRenderer.invoke("mods:remove", target, projectId) as Promise<PersonalMod[]>,
  refetchMods: (target: ModTarget) => ipcRenderer.invoke("mods:refetch", target) as Promise<PersonalMod[]>,
  skinState: (instanceRoot: string) => ipcRenderer.invoke("skin:state", instanceRoot) as Promise<SkinState>,
  addSkin: (instanceRoot: string) => ipcRenderer.invoke("skin:add", instanceRoot) as Promise<SkinState>,
  applySkin: (instanceRoot: string, id: string, model: SkinModel) => ipcRenderer.invoke("skin:apply", instanceRoot, id, model) as Promise<SkinState>,
  applyDefaultSkin: (instanceRoot: string, name: string) => ipcRenderer.invoke("skin:applyDefault", instanceRoot, name) as Promise<SkinState>,
  setSkinModel: (instanceRoot: string, id: string, model: SkinModel) => ipcRenderer.invoke("skin:setModel", instanceRoot, id, model) as Promise<SkinState>,
  removeSkin: (instanceRoot: string, id: string) => ipcRenderer.invoke("skin:remove", instanceRoot, id) as Promise<SkinState>,
  resetSkin: (instanceRoot: string) => ipcRenderer.invoke("skin:reset", instanceRoot) as Promise<SkinState>,
  gameStatus: () => ipcRenderer.invoke("game:status") as Promise<GameStatus>,
  openPath: (target: string) => ipcRenderer.invoke("shell:openPath", target) as Promise<string>,
  copyText: (value: string) => ipcRenderer.invoke("clipboard:writeText", value) as Promise<void>,
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  onProgress: subscribe<SyncProgress>("modpack:progress"),
  onGameStatus: subscribe<GameStatus>("game:status"),
  onAuthFailure: subscribe<AuthFailure>("game:authFailure"),
  onLauncherUpdate: subscribe<LauncherUpdateStatus>("launcher:updateStatus"),
  onAuthSession: subscribe<LauncherUser>("auth:session"),
  onAuthError: subscribe<string>("auth:error"),
  onInviteReceived: subscribe<string>("invite:received")
};

contextBridge.exposeInMainWorld("bweeep", api);

export type BweeepApi = typeof api;
