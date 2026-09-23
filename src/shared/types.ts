export type LoaderKind = "vanilla" | "neoforge" | "forge" | "fabric";
export type ServerSoftwareKind = LoaderKind | "paper" | "folia";

export interface PackFile {
  path: string;
  size: number;
  /** SHA-256 is used by bundled manifests; Modrinth packs publish SHA-512. */
  sha256?: string;
  sha512?: string;
  url: string;
}

export interface MrpackSource {
  url: string;
  size: number;
  sha512: string;
}

export interface ModpackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  default?: boolean;
  /** Test manifests are never returned to members without explicit test access. */
  audience?: "members" | "testers";
  version: string;
  minecraftVersion: string;
  java: {
    majorVersion: number;
    component: string;
  };
  loader: {
    kind: LoaderKind;
    version: string;
  };
  /** Server implementation. The client loader can differ for client-only features. */
  serverLoader?: {
    kind: ServerSoftwareKind;
    version: string;
  };
  clientFeatures?: {
    /** False opts out; true requires a matching bridge. Omitted uses a verified bridge when available. */
    connectionLock: boolean;
  };
  server: {
    host: string;
    port: number;
  };
  /** A pinned Modrinth .mrpack whose indexed files and overrides are installed safely. */
  mrpack?: MrpackSource;
  files: PackFile[];
  notes?: string;
}

export interface ServerPreset {
  id: string;
  name: string;
  packId: string;
  default?: boolean;
  description: string;
  server: { host: string; port: number };
  minecraftVersion: string;
  java: { majorVersion: number; component: string };
  loader: { kind: LoaderKind; version: string };
  serverLoader?: { kind: ServerSoftwareKind; version: string };
  environment: "production" | "test";
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
  stage?: string;
  elapsedMs?: number;
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

export interface LauncherUser {
  id: string;
  username: string;
  globalName?: string | null;
  avatarUrl?: string | null;
  gameName?: string | null;
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
  testAllowed?: boolean;
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

export type GameLifecycleState = "idle" | "starting" | "running";

export interface GameStatus {
  state: GameLifecycleState;
  pid?: number;
  exitMessage?: string;
  exitError?: boolean;
}

export interface LauncherUpdate {
  version: string;
  notes: string[];
}

export interface LauncherUpdateStatus {
  state: "checking" | "available" | "current" | "downloading" | "ready" | "installing" | "error";
  update?: LauncherUpdate;
  percent?: number;
  message?: string;
}

export interface UserContentStatus {
  userModsDir: string;
  shaderpacksDir: string;
  sharedOptionsPath: string;
  copiedMods: number;
  copiedShaders: number;
  removedManagedMods: number;
}

export type UserContentKind = "mods" | "shaderpacks";

/** User-selected folders stay outside instances and are applied at launch. */
export interface UserContentFolders {
  mods: string[];
  shaderpacks: string[];
}

export interface UserContentFolderPickResult {
  folders: UserContentFolders;
  selected: number;
}
