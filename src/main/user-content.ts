import fsp from "node:fs/promises";
import path from "node:path";
import type { ModpackManifest, UserContentStatus } from "../shared/types.js";

const USER_MODS_FILE = ".bweeep-user-mods.json";
const USER_SHADERS_FILE = ".bweeep-user-shaders.json";
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

  const desiredMods = await jarFiles(userModsDir);
  const managedModNames = new Set(manifest.files
    .filter((file) => file.path.startsWith("mods/"))
    .map((file) => path.basename(file.path).toLowerCase()));
  const blockedMods = desiredMods
    .map((source) => path.basename(source))
    .filter((name) => managedModNames.has(name.toLowerCase()));
  const installableMods = desiredMods.filter((source) => !blockedMods.includes(path.basename(source)));
  const previousMods = await readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
  const desiredNames = new Set(installableMods.map((source) => path.basename(source)));
  let removedManagedMods = 0;
  for (const previous of previousMods) {
    if (!desiredNames.has(previous) && !managedModNames.has(previous.toLowerCase())) {
      await fsp.rm(path.join(modsDir, previous), { force: true });
      removedManagedMods += 1;
    }
  }
  for (const source of installableMods) {
    const target = path.join(modsDir, path.basename(source));
    await fsp.copyFile(source, target);
  }
  await fsp.mkdir(path.join(instanceDir, ".bweeep"), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_MODS_FILE), JSON.stringify([...desiredNames].sort(), null, 2), "utf8");

  const desiredShaders = await zipFiles(shaderpacksDir);
  const previousShaders = await readStringArray(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE));
  const desiredShaderNames = new Set(desiredShaders.map((source) => path.basename(source)));
  for (const previous of previousShaders) {
    if (!desiredShaderNames.has(previous)) await fsp.rm(path.join(instanceShaders, previous), { force: true });
  }
  for (const source of desiredShaders) {
    await fsp.copyFile(source, path.join(instanceShaders, path.basename(source)));
  }
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE), JSON.stringify([...desiredShaderNames].sort(), null, 2), "utf8");
  return { userModsDir, shaderpacksDir, sharedOptionsPath, copiedMods: installableMods.length, removedManagedMods, blockedMods };
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

async function jarFiles(folder: string): Promise<string[]> {
  return (await fsp.readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jar"))
    .map((entry) => path.join(folder, entry.name));
}

async function zipFiles(folder: string): Promise<string[]> {
  return (await fsp.readdir(folder, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
    .map((entry) => path.join(folder, entry.name));
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
