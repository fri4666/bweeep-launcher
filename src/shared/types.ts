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
    /** Remote locks are pinned in files; boolean preserves existing bundled bridges. */
    connectionLock: boolean | {
      protocolVersion: 1;
      path: "mods/bweeep-connection-lock.jar";
      sha256: string;
      minecraftVersion: string;
      loaderKind: LoaderKind;
    };
  };
  server: {
    host: string;
    port: number;
  };
  /**
   * How the server verifies players. "yggdrasil" means the server runs
   * authlib-injector against the Bweeep Yggdrasil API with online-mode=true;
   * that works for any version and loader and carries skins. Default: offline.
   */
  gameAuth?: "offline" | "yggdrasil";
  /** Modrinth project ids players may not add as personal mods on this server. */
  blockedModrinthProjects?: string[];
  /** Java heap the pack needs, in MB; without it the launcher estimates one from the loader and mods. */
  recommendedMemoryMb?: number;
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
  gameAuth: "offline" | "yggdrasil";
  blockedModrinthProjects: string[];
  /** The manifest's recommendedMemoryMb, or the launcher's estimate. */
  recommendedMemoryMb: number;
}

export interface ServerStatus {
  online: boolean;
  host: string;
  port: number;
  latencyMs?: number;
  message: string;
  /** From the Minecraft status ping; missing when only a TCP connection answered. */
  players?: { online: number; max: number };
  version?: string;
  /** Stopped while empty to save memory (server gate); pressing Play starts it. */
  sleep?: "sleeping" | "starting";
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
  unit?: "files" | "bytes";
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

/** Why launcher-access cannot be reached: the service itself, or this PC's connection. */
export type AuthOutage = "auth" | "network";

export interface AccessStatus {
  loggedIn: boolean;
  allowed: boolean;
  isAdmin: boolean;
  testAllowed?: boolean;
  reason: string;
  user?: LauncherUser;
  unavailable?: boolean;
  /** Set when launcher-access could not be reached and this is the last access seen on this PC. */
  outage?: AuthOutage;
}

export interface InviteResult {
  ok: boolean;
  message: string;
  status: AccessStatus;
}

export interface CreatedInvite {
  id?: string;
  code: string;
  expiresAt: string;
  maxUses: number;
}

export interface InviteSummary {
  id: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  createdAt: string;
}

/** Open codes the signed-in member created, with the limits the server enforces. */
export interface InviteList {
  role: "admin" | "member";
  maxUsesLimit: number;
  activeLimit: number | null;
  invites: InviteSummary[];
}

export interface LaunchResult {
  pid: number;
  instanceDir: string;
  version: string;
}

type GameLifecycleState ="idle" | "starting" | "running";

export interface GameStatus {
  state: GameLifecycleState;
  pid?: number;
  startedAt?: number;
  exitMessage?: string;
  exitError?: boolean;
  /** Set when Minecraft wrote a crash report the player can open. */
  crashReport?: boolean;
  /** Pack id of a crashed run that had personal mods, so it can be retried without them. */
  retryWithoutPersonalMods?: string;
}

export type LogTarget = "game" | "launcher";

/**
 * Patch note groups, in the order players read them. "upcoming" is the
 * next-patch preview (patch notes tab only). "other" is a plain list or an
 * unknown heading.
 */
export type ReleaseNoteSectionKind = "new" | "changed" | "fixed" | "known" | "upcoming" | "other";

export interface ReleaseNoteSection {
  kind: ReleaseNoteSectionKind;
  /** Heading as written; null for a list with no headings (0.1.35 and older). */
  title: string | null;
  items: string[];
  /**
   * Small notes under each item ("참고: …"), from indented bullets; details[i]
   * belongs to items[i]. Missing in notes cached by older launchers.
   */
  details?: string[][];
}

/** One version's notes, from build/release-notes.txt or the same text on its GitHub release. */
export interface ReleaseNotes {
  version: string;
  summary: string | null;
  /** The developer's greeting above the list and sign-off below it; lines are separated by "\n". */
  intro: string | null;
  outro: string | null;
  sections: ReleaseNoteSection[];
}

export interface PatchNote extends ReleaseNotes {
  prerelease: boolean;
  publishedAt: string | null;
  /** The GitHub release page; only github.com/fri4666/bweeep-launcher/releases/… addresses. */
  url: string | null;
}

export interface PatchNotes {
  currentVersion: string;
  /** live: fetched just now; cache: the last good fetch; bundled: only this build's own notes. */
  source: "live" | "cache" | "bundled";
  notes: PatchNote[];
}

/** Release notes shown once on the first start after an update. */
export type WhatsNew = ReleaseNotes;

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
  /** Personal jars left out of this launch and why. */
  skippedMods: Array<{ name: string; reason: string }>;
}

/** What moving the install location would carry over; `problem` says why it cannot. */
export interface InstallMoveCheck {
  /** Launcher folders (instances and personal content) found at the current location. */
  entries: number;
  bytes: number;
  problem?: string;
}

/** available is false while the launcher has no Discord application id. */
export interface DiscordPresenceSetting {
  available: boolean;
  enabled: boolean;
}

export type UserContentKind = "mods" | "shaderpacks";

/** A member as the admin tab lists them. Admins are always testers. */
export interface MemberSummary {
  userId: string;
  name: string;
  gameName: string | null;
  role: "admin" | "member";
  tester: boolean;
  /** Last launch or server join; missing from servers before 0.1.37. */
  lastPlayedAt?: string | null;
}

/** The server whose loader and Minecraft version personal mods must match. */
export interface ModTarget {
  instanceRoot: string;
  packId: string;
  loader: LoaderKind;
  minecraftVersion: string;
  blockedModrinthProjects: string[];
}

export interface ModrinthHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  /** inPack: the server pack already ships it; blocked: the server does not allow it. */
  status: "available" | "installed" | "inPack" | "blocked";
}

export interface ModSearchResult {
  hits: ModrinthHit[];
  total: number;
  /** Whole modpacks that match the search. They are named so the panel can say they cannot be downloaded. */
  modpacks: string[];
}

export interface PersonalMod {
  projectId: string;
  title: string;
  versionNumber: string;
  fileName: string;
  /** False when it was added only because another personal mod needs it. */
  explicit: boolean;
  /** Newer version for this server's loader and Minecraft version, if any. */
  update?: string;
  /**
   * Set when the mod was installed for the server's previous loader or
   * Minecraft version ("Fabric 1.21.4"). It stays out of the game until it is
   * fetched again for the current one.
   */
  previousTarget?: string;
  /** Why it cannot be fetched for this server, e.g. "맞는 버전 없음". */
  unavailable?: string;
}

/** "default" is the classic 4px arm (Steve); "slim" the 3px arm (Alex). */
export type SkinModel = "default" | "slim";

/** The skin the server hands to Minecraft; hash names the stored PNG. */
export interface LauncherSkin {
  hash: string;
  model: SkinModel;
}

/** A skin kept on this PC so the player can switch back to it later. */
export interface SkinLibraryEntry {
  id: string;
  name: string;
  model: SkinModel;
  /** data:image/png;base64 URL for the preview. */
  dataUrl: string;
  addedAt: string;
}

export interface SkinState {
  /** The applied skin, or null when Minecraft picks its default skin. */
  current: { id: string; model: SkinModel; dataUrl: string } | null;
  library: SkinLibraryEntry[];
  /** Steve and Alex from an installed game, when one is installed. */
  defaults: Array<{ name: string; model: SkinModel; dataUrl: string }>;
  /** Why the applied skin could not be read from the server, if it could not. */
  serverError?: string;
}

/** User-selected folders stay outside instances and are applied at launch. */
export interface UserContentFolders {
  mods: string[];
  shaderpacks: string[];
}

export interface UserContentFolderPickResult {
  folders: UserContentFolders;
  selected: number;
}
