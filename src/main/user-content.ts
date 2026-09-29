import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModpackManifest, UserContentFolders, UserContentKind, UserContentStatus } from "../shared/types.js";
import { fitsMinecraft, readModMetadata, runsOn, type ModMetadata } from "./mod-metadata.js";

const USER_MODS_FILE = ".bweeep-user-mods.json";
const USER_SHADERS_FILE = ".bweeep-user-shaders.json";
const USER_FOLDERS_FILE = "folders.json";
const PACK_TARGETS_FILE = "pack-targets.json";
const GAME_OPTION_FILE = /^options(?:[a-z0-9_-]+)?\.txt$/i;

interface UserContentPaths {
  userModsDir: string;
  shaderpacksDir: string;
}

export interface PersonalModCheck {
  /** Launch with the server pack only, e.g. after personal mods crashed the game. */
  withoutPersonalMods?: boolean;
  /** Jar files among the candidates that the server blocks; best effort. */
  findBlocked?: (jars: string[]) => Promise<Set<string>>;
  /** Launcher-owned jars that join the pack later in the launch. */
  launcherJars?: string[];
}

/** Keeps user-owned client content outside of server-managed manifest files. */
export async function prepareUserContent(
  instanceRoot: string,
  instanceDir: string,
  manifest: ModpackManifest,
  check: PersonalModCheck = {}
): Promise<UserContentStatus> {
  const root = userContentRoot(instanceRoot);
  const { userModsDir, shaderpacksDir } = userContentPaths(instanceRoot, manifest.loader.kind, manifest.minecraftVersion);
  const sharedOptionsPath = path.join(root, "settings", "options.txt");
  const modsDir = path.join(instanceDir, "mods");
  const instanceShaders = path.join(instanceDir, "shaderpacks");
  await Promise.all([fsp.mkdir(userModsDir, { recursive: true }), fsp.mkdir(shaderpacksDir, { recursive: true }), fsp.mkdir(modsDir, { recursive: true }), fsp.mkdir(instanceShaders, { recursive: true })]);

  // Key bindings, sensitivity, accessibility, chat, sound and video settings
  // are stored in options*.txt. Keep every such base-game file across servers.
  await restoreGameOptions(path.join(root, "settings"), instanceDir);
  if (manifest.id) {
    await rememberModCompatibility(instanceRoot, manifest.id, { loader: manifest.loader.kind, minecraftVersion: manifest.minecraftVersion }, { onlyIfMissing: true }).catch(() => undefined);
  }

  const selectedFolders = await getUserContentFolders(instanceRoot);
  const candidates = await collectContentFiles([userModsDir, ...selectedFolders.mods], ".jar");
  const previousMods = await readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
  const candidateNames = new Set(candidates.map((file) => file.targetName));
  let removedManagedMods = 0;
  // Last launch's personal jars are taken out first, so what remains is the
  // server pack and the launcher's own mods.
  for (const previous of previousMods) {
    await fsp.rm(path.join(modsDir, previous), { force: true });
    if (!candidateNames.has(previous)) removedManagedMods += 1;
  }
  const { accepted: desiredMods, skipped: skippedMods } = check.withoutPersonalMods
    ? { accepted: [], skipped: [] }
    : await checkPersonalMods(candidates, modsDir, manifest, check);
  const desiredNames = new Set(desiredMods.map((file) => file.targetName));
  for (const file of desiredMods) {
    await fsp.copyFile(file.source, path.join(modsDir, file.targetName));
  }
  await fsp.mkdir(path.join(instanceDir, ".bweeep"), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_MODS_FILE), JSON.stringify([...desiredNames].sort(), null, 2), "utf8");

  const desiredShaders = await collectContentFiles([shaderpacksDir, ...selectedFolders.shaderpacks], ".zip");
  const previousShaders = await readStringArray(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE));
  const desiredShaderNames = new Set(desiredShaders.map((file) => file.targetName));
  for (const previous of previousShaders) {
    if (!desiredShaderNames.has(previous)) await fsp.rm(path.join(instanceShaders, previous), { force: true });
  }
  for (const file of desiredShaders) {
    await fsp.copyFile(file.source, path.join(instanceShaders, file.targetName));
  }
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE), JSON.stringify([...desiredShaderNames].sort(), null, 2), "utf8");
  return { userModsDir, shaderpacksDir, sharedOptionsPath, copiedMods: desiredMods.length, copiedShaders: desiredShaders.length, removedManagedMods, skippedMods };
}

type ContentFile = { source: string; targetName: string };

/**
 * Personal jars that would stop the game from starting are left out: a jar
 * for another loader or another Minecraft version, a mod the server pack
 * already ships (two copies of one mod id crash every loader), a second copy
 * among the personal jars, or a mod the server blocks. Mods are recognised by
 * the ids and version ranges in their own metadata.
 */
async function checkPersonalMods(
  candidates: ContentFile[],
  modsDir: string,
  manifest: ModpackManifest,
  { findBlocked, launcherJars = [] }: PersonalModCheck
): Promise<{ accepted: ContentFile[]; skipped: Array<{ name: string; reason: string }> }> {
  const skipped: Array<{ name: string; reason: string }> = [];
  if (candidates.length === 0) return { accepted: [], skipped };
  if (manifest.loader.kind === "vanilla") {
    return { accepted: [], skipped: candidates.map((file) => ({ name: file.targetName, reason: "바닐라 서버라 모드를 넣을 수 없어요" })) };
  }

  const packIds = new Set<string>();
  const packJars = (await fsp.readdir(modsDir).catch(() => [] as string[])).filter((name) => name.toLowerCase().endsWith(".jar"));
  for (const jar of [...packJars.map((name) => path.join(modsDir, name)), ...launcherJars]) {
    const metadata = await cachedMetadata(jar);
    metadata?.ids.forEach((id) => packIds.add(id));
  }

  const blocked = findBlocked ? await findBlocked(candidates.map((file) => file.source)).catch(() => new Set<string>()) : new Set<string>();
  const packNames = new Set(packJars.map((name) => name.toLowerCase()));
  const accepted: ContentFile[] = [];
  const personalIds = new Set<string>();
  for (const file of candidates) {
    const metadata = await cachedMetadata(file.source);
    // Copying it would overwrite the server's own file.
    const reason = packNames.has(file.targetName.toLowerCase()) ? "서버 팩에 같은 이름의 파일이 있어요"
      : !metadata ? "모드 파일을 읽지 못했어요"
      : !runsOn(metadata, manifest.loader.kind) ? `${loaderLabel(manifest.loader.kind)}용 모드가 아니에요`
      : !fitsMinecraft(metadata, manifest.loader.kind, manifest.minecraftVersion) ? `${manifest.minecraftVersion} 버전용 모드가 아니에요`
      : blocked.has(file.source) ? "이 서버에서 쓰지 않기로 한 모드예요"
      : [...metadata.ids].some((id) => packIds.has(id)) ? "서버 팩에 이미 있는 모드예요"
      : [...metadata.ids].some((id) => personalIds.has(id)) ? "같은 모드가 개인 모드에 두 번 들어 있어요"
      : null;
    if (reason) {
      skipped.push({ name: file.targetName, reason });
      continue;
    }
    metadata!.ids.forEach((id) => personalIds.add(id));
    accepted.push(file);
  }
  return { accepted, skipped };
}

const metadataCache = new Map<string, ModMetadata | null>();

async function cachedMetadata(file: string): Promise<ModMetadata | null> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return null;
  const key = `${file}\0${stat.size}\0${stat.mtimeMs}`;
  if (!metadataCache.has(key)) metadataCache.set(key, await readModMetadata(file).catch(() => null));
  return metadataCache.get(key) ?? null;
}

function loaderLabel(loader: ModpackManifest["loader"]["kind"]): string {
  return { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", vanilla: "바닐라" }[loader];
}

export async function captureSharedOptions(instanceRoot: string, instanceDir: string): Promise<void> {
  const settingsDir = path.join(userContentRoot(instanceRoot), "settings");
  await fsp.mkdir(settingsDir, { recursive: true });
  for (const fileName of await gameOptionFiles(instanceDir)) {
    await fsp.copyFile(path.join(instanceDir, fileName), path.join(settingsDir, fileName));
  }
}

function userContentRoot(instanceRoot: string): string {
  return path.resolve(instanceRoot, ".bweeep-user-content");
}

/** Personal mods for one loader and version, which is where Modrinth installs go. */
export function personalModsDir(instanceRoot: string, loaderKind: ModpackManifest["loader"]["kind"], minecraftVersion: string): string {
  return userContentPaths(instanceRoot, loaderKind, minecraftVersion).userModsDir;
}

export interface ModCompatibility {
  loader: ModpackManifest["loader"]["kind"];
  minecraftVersion: string;
}

const LOADERS = new Set<string>(["vanilla", "fabric", "forge", "neoforge"]);
const VERSION_TEXT = /^[A-Za-z0-9._-]{1,32}$/;

function packTargetsFile(instanceRoot: string): string {
  return path.join(userContentRoot(instanceRoot), "mods", PACK_TARGETS_FILE);
}

async function readPackTargets(instanceRoot: string): Promise<Record<string, ModCompatibility>> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(packTargetsFile(instanceRoot), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => isCompatibility(item))) as Record<string, ModCompatibility>;
  } catch { return {}; }
}

function isCompatibility(value: unknown): value is ModCompatibility {
  const item = value as Partial<ModCompatibility> | null;
  return Boolean(item) && typeof item!.loader === "string" && LOADERS.has(item!.loader) &&
    typeof item!.minecraftVersion === "string" && VERSION_TEXT.test(item!.minecraftVersion);
}

/**
 * The loader and Minecraft version a server had when its personal mods were
 * last settled. After the server moves on, the mods for the old pair are still
 * found through this. Before anything was recorded, the installed pack says.
 */
export async function lastModCompatibility(instanceRoot: string, packId: string): Promise<ModCompatibility | null> {
  const recorded = (await readPackTargets(instanceRoot))[packId];
  if (recorded) return recorded;
  try {
    const installed = JSON.parse(await fsp.readFile(path.join(instanceRoot, packId, "bweeep-manifest.json"), "utf8")) as Partial<ModpackManifest>;
    const compatibility = { loader: installed.loader?.kind, minecraftVersion: installed.minecraftVersion };
    return isCompatibility(compatibility) ? compatibility : null;
  } catch { return null; }
}

/** `onlyIfMissing` keeps an older record, so a launch never hides mods still waiting to be fetched again. */
export async function rememberModCompatibility(instanceRoot: string, packId: string, compatibility: ModCompatibility, options: { onlyIfMissing?: boolean } = {}): Promise<void> {
  const targets = await readPackTargets(instanceRoot);
  const current = targets[packId];
  if (current && (options.onlyIfMissing || (current.loader === compatibility.loader && current.minecraftVersion === compatibility.minecraftVersion))) return;
  targets[packId] = { loader: compatibility.loader, minecraftVersion: compatibility.minecraftVersion };
  const file = packTargetsFile(instanceRoot);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(`${file}.part`, JSON.stringify(targets, null, 2), "utf8");
  await fsp.rename(`${file}.part`, file);
}

/** Names of the personal jars the last launch copied into an instance's mods folder. */
export async function copiedPersonalMods(instanceDir: string): Promise<string[]> {
  return readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
}

function userContentPaths(instanceRoot: string, loaderKind: ModpackManifest["loader"]["kind"], minecraftVersion: string): UserContentPaths {
  const root = userContentRoot(instanceRoot);
  const compatibilityId = `${loaderKind}-${minecraftVersion}`;
  return {
    userModsDir: path.join(root, "mods", compatibilityId),
    shaderpacksDir: path.join(root, "shaderpacks", compatibilityId)
  };
}

export async function getUserContentFolders(instanceRoot: string): Promise<UserContentFolders> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(path.join(userContentRoot(instanceRoot), USER_FOLDERS_FILE), "utf8"));
    if (!value || typeof value !== "object") return { mods: [], shaderpacks: [] };
    const record = value as Partial<UserContentFolders>;
    return { mods: await validFolders(record.mods), shaderpacks: await validFolders(record.shaderpacks) };
  } catch { return { mods: [], shaderpacks: [] }; }
}

export async function addUserContentFolders(instanceRoot: string, kind: UserContentKind, folders: string[]): Promise<UserContentFolders> {
  const current = await getUserContentFolders(instanceRoot);
  const next = { ...current, [kind]: [...current[kind], ...(await validFolders(folders)).filter((folder) => !current[kind].includes(folder))] };
  await saveFolders(instanceRoot, next);
  return next;
}

export async function removeUserContentFolder(instanceRoot: string, kind: UserContentKind, folder: string): Promise<UserContentFolders> {
  const current = await getUserContentFolders(instanceRoot);
  const next = { ...current, [kind]: current[kind].filter((item) => item !== folder) };
  await saveFolders(instanceRoot, next);
  return next;
}

async function saveFolders(instanceRoot: string, folders: UserContentFolders): Promise<void> {
  const root = userContentRoot(instanceRoot);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, USER_FOLDERS_FILE), JSON.stringify(folders, null, 2), "utf8");
}

async function validFolders(folders: unknown): Promise<string[]> {
  if (!Array.isArray(folders)) return [];
  const checked = await Promise.all(folders.filter((item): item is string => typeof item === "string").map(async (folder) => {
    const resolved = path.resolve(folder);
    try { return (await fsp.stat(resolved)).isDirectory() ? resolved : null; } catch { return null; }
  }));
  return [...new Set(checked.filter((folder): folder is string => folder !== null))];
}

async function collectContentFiles(folders: string[], extension: string): Promise<Array<{ source: string; targetName: string }>> {
  const sources = (await Promise.all(folders.map(async (folder) => {
    try { return (await fsp.readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension)).map((entry) => path.join(folder, entry.name)); } catch { return []; }
  }))).flat().sort();
  const used = new Set<string>();
  return sources.map((source) => {
    const original = path.basename(source);
    let targetName = original;
    if (used.has(targetName)) {
      const ext = path.extname(original);
      targetName = `${path.basename(original, ext)}-${createHash("sha256").update(source).digest("hex").slice(0, 8)}${ext}`;
    }
    used.add(targetName);
    return { source, targetName };
  });
}

async function readStringArray(filePath: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !item.includes("/") && !item.includes("\\")) : [];
  } catch { return []; }
}

async function restoreGameOptions(settingsDir: string, instanceDir: string): Promise<void> {
  for (const fileName of await gameOptionFiles(settingsDir)) {
    await fsp.copyFile(path.join(settingsDir, fileName), path.join(instanceDir, fileName));
  }
}

async function gameOptionFiles(directory: string): Promise<string[]> {
  try {
    return (await fsp.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && GAME_OPTION_FILE.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
