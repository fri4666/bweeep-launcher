export type LoaderKind = "neoforge" | "forge" | "fabric";

export interface PackFile {
  path: string;
  size: number;
  sha256: string;
  url: string;
}

export interface ModpackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  minecraftVersion: string;
  loader: {
    kind: LoaderKind;
    version: string;
  };
  server: {
    host: string;
    port: number;
  };
  files: PackFile[];
  notes?: string;
}

export interface ServerPreset {
  id: string;
  name: string;
  packId: string;
  description: string;
  server: { host: string; port: number };
  minecraftVersion: string;
  loader: { kind: LoaderKind; version: string };
}

export interface ServerStatus {
  online: boolean;
  host: string;
  port: number;
  latencyMs?: number;
  message: string;
}

export interface ServerConnection {
  host: string;
  port: number;
}

export interface SyncRequest {
  instanceDir: string;
  manifest: ModpackManifest;
}

export interface SyncProgress {
  kind: "info" | "download" | "skip" | "done" | "error";
  message: string;
  completed?: number;
  total?: number;
  filePath?: string;
}

export interface SyncResult {
  manifest: ModpackManifest;
  instanceDir: string;
  downloaded: number;
  skipped: number;
}

export type LoginProvider = "discord" | "microsoft";

export interface LauncherUser {
  id: string;
  username: string;
  globalName?: string | null;
  avatarUrl?: string | null;
  provider: LoginProvider;
}

export interface LoginResult {
  configured: boolean;
  pending?: boolean;
  user?: LauncherUser;
  message?: string;
}

export interface LoginCancellationResult {
  cancelled: boolean;
  message: string;
}

export interface AccessStatus {
  loggedIn: boolean;
  allowed: boolean;
  isAdmin: boolean;
  reason: string;
  user?: LauncherUser;
  unavailable?: boolean;
}

export interface InviteResult {
  ok: boolean;
  message: string;
  status: AccessStatus;
}

export interface CreatedInvite {
  code: string;
  expiresAt: string;
  maxUses: number;
}

export interface LaunchResult {
  pid: number;
  instanceDir: string;
  version: string;
}

export interface LauncherUpdate {
  version: string;
  downloadUrl: string;
  notes: string[];
}

export interface LauncherUpdateStatus {
  state: "current" | "available" | "unavailable";
  update?: LauncherUpdate;
}
