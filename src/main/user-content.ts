import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ModpackManifest, UserContentFolders, UserContentKind, UserContentStatus } from "../shared/types.js";

const USER_MODS_FILE = ".bweeep-user-mods.json";
const USER_SHADERS_FILE = ".bweeep-user-shaders.json";
const USER_FOLDERS_FILE = "folders.json";
const GAME_OPTION_FILE = /^options(?:[a-z0-9_-]+)?\.txt$/i;

export interface UserContentPaths {
  userModsDir: string;
  shaderpacksDir: string;
}

/** Keeps user-owned client content outside of server-managed manifest files. */
export async function prepareUserContent(instanceRoot: string, instanceDir: string, manifest: ModpackManifest): Promise<UserContentStatus> {
  const root = path.resolve(instanceRoot, ".bweeep-user-content");
  const { userModsDir, shaderpacksDir } = userContentPaths(instanceRoot, manifest.loader.kind, manifest.minecraftVersion);
  const sharedOptionsPath = path.join(root, "settings", "options.txt");
  const modsDir = path.join(instanceDir, "mods");
  const instanceShaders = path.join(instanceDir, "shaderpacks");
  await Promise.all([fsp.mkdir(userModsDir, { recursive: true }), fsp.mkdir(shaderpacksDir, { recursive: true }), fsp.mkdir(modsDir, { recursive: true }), fsp.mkdir(instanceShaders, { recursive: true })]);

  // Key bindings, sensitivity, accessibility, chat, sound and video settings
  // are stored in options*.txt. Keep every such base-game file across servers.
  await restoreGameOptions(path.join(root, "settings"), instanceDir);

  const selectedFolders = await getUserContentFolders(instanceRoot);
  const desiredMods = await collectContentFiles([userModsDir, ...selectedFolders.mods], ".jar");
  const managedModNames = new Set(manifest.files
    .filter((file) => file.path.startsWith("mods/"))
    .map((file) => path.basename(file.path).toLowerCase()));
  const blockedMods = desiredMods
    .map((file) => path.basename(file.source))
    .filter((name) => managedModNames.has(name.toLowerCase()));
  const installableMods = desiredMods.filter((file) => !blockedMods.includes(path.basename(file.source)));
  const previousMods = await readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
  const desiredNames = new Set(installableMods.map((file) => file.targetName));
  let removedManagedMods = 0;
  for (const previous of previousMods) {
    if (!desiredNames.has(previous) && !managedModNames.has(previous.toLowerCase())) {
      await fsp.rm(path.join(modsDir, previous), { force: true });
      removedManagedMods += 1;
    }
  }
  for (const file of installableMods) {
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
  return { userModsDir, shaderpacksDir, sharedOptionsPath, copiedMods: installableMods.length, copiedShaders: desiredShaders.length, removedManagedMods, blockedMods };
}

export async function captureSharedOptions(instanceRoot: string, instanceDir: string): Promise<void> {
  const settingsDir = path.join(userContentRoot(instanceRoot), "settings");
  await fsp.mkdir(settingsDir, { recursive: true });
  for (const fileName of await gameOptionFiles(instanceDir)) {
    await fsp.copyFile(path.join(instanceDir, fileName), path.join(settingsDir, fileName));
  }
}

export function userContentRoot(instanceRoot: string): string {
  return path.resolve(instanceRoot, ".bweeep-user-content");
}

export function userContentPaths(instanceRoot: string, loaderKind: ModpackManifest["loader"]["kind"], minecraftVersion: string): UserContentPaths {
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
