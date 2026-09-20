import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { UserContentFolders, UserContentKind, UserContentStatus } from "../shared/types.js";

const USER_MODS_FILE = ".bweeep-user-mods.json";
const USER_SHADERS_FILE = ".bweeep-user-shaders.json";
const USER_FOLDERS_FILE = "folders.json";

/** Keeps user-owned client content outside of server-managed manifest files. */
export async function prepareUserContent(instanceRoot: string, instanceDir: string): Promise<UserContentStatus> {
  const root = path.resolve(instanceRoot, ".bweeep-user-content");
  const userModsDir = path.join(root, "mods");
  const shaderpacksDir = path.join(root, "shaderpacks");
  const sharedOptionsPath = path.join(root, "options.txt");
  const modsDir = path.join(instanceDir, "mods");
  const instanceShaders = path.join(instanceDir, "shaderpacks");
  await Promise.all([fsp.mkdir(root, { recursive: true }), fsp.mkdir(modsDir, { recursive: true }), fsp.mkdir(instanceShaders, { recursive: true })]);

  // A newly changed instance exports its input settings for later servers; a new
  // instance imports the shared copy before Minecraft starts.
  const instanceOptions = path.join(instanceDir, "options.txt");
  if (await exists(sharedOptionsPath)) await fsp.copyFile(sharedOptionsPath, instanceOptions);

  const folders = await getUserContentFolders(instanceRoot);
  const desiredMods = await collectContentFiles(folders.mods, ".jar");
  const previousMods = await readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
  const desiredNames = new Set(desiredMods.map((file) => file.targetName));
  let removedManagedMods = 0;
  for (const previous of previousMods) {
    if (!desiredNames.has(previous)) {
      await fsp.rm(path.join(modsDir, previous), { force: true });
      removedManagedMods += 1;
    }
  }
  for (const file of desiredMods) {
    await fsp.copyFile(file.source, path.join(modsDir, file.targetName));
  }
  await fsp.mkdir(path.join(instanceDir, ".bweeep"), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_MODS_FILE), JSON.stringify([...desiredNames].sort(), null, 2), "utf8");

  const desiredShaders = await collectContentFiles(folders.shaderpacks, ".zip");
  const previousShaders = await readStringArray(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE));
  const desiredShaderNames = new Set(desiredShaders.map((file) => file.targetName));
  for (const previous of previousShaders) {
    if (!desiredShaderNames.has(previous)) await fsp.rm(path.join(instanceShaders, previous), { force: true });
  }
  for (const file of desiredShaders) {
    await fsp.copyFile(file.source, path.join(instanceShaders, file.targetName));
  }
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_SHADERS_FILE), JSON.stringify([...desiredShaderNames].sort(), null, 2), "utf8");
  return { userModsDir, shaderpacksDir, sharedOptionsPath, copiedMods: desiredMods.length, copiedShaders: desiredShaders.length, removedManagedMods };
}

export async function captureSharedOptions(instanceRoot: string, instanceDir: string): Promise<void> {
  const instanceOptions = path.join(instanceDir, "options.txt");
  if (!await exists(instanceOptions)) return;
  const target = path.join(userContentRoot(instanceRoot), "options.txt");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.copyFile(instanceOptions, target);
}

export function userContentRoot(instanceRoot: string): string {
  return path.resolve(instanceRoot, ".bweeep-user-content");
}

export async function getUserContentFolders(instanceRoot: string): Promise<UserContentFolders> {
  const root = userContentRoot(instanceRoot);
  const configured = await readFolders(path.join(root, USER_FOLDERS_FILE));
  if (configured) return configured;
  // Keep existing launcher-managed folders working after the folder picker update.
  return {
    mods: await folderHasExtension(path.join(root, "mods"), ".jar") ? [path.join(root, "mods")] : [],
    shaderpacks: await folderHasExtension(path.join(root, "shaderpacks"), ".zip") ? [path.join(root, "shaderpacks")] : []
  };
}

export async function addUserContentFolders(instanceRoot: string, kind: UserContentKind, folders: string[]): Promise<UserContentFolders> {
  const current = await getUserContentFolders(instanceRoot);
  const valid = await uniqueFolders(folders);
  const next = { ...current, [kind]: [...current[kind], ...valid.filter((folder) => !current[kind].includes(folder))] };
  await writeFolders(instanceRoot, next);
  return next;
}

export async function removeUserContentFolder(instanceRoot: string, kind: UserContentKind, folder: string): Promise<UserContentFolders> {
  const current = await getUserContentFolders(instanceRoot);
  const next = { ...current, [kind]: current[kind].filter((item) => item !== folder) };
  await writeFolders(instanceRoot, next);
  return next;
}

async function writeFolders(instanceRoot: string, folders: UserContentFolders): Promise<void> {
  const root = userContentRoot(instanceRoot);
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(path.join(root, USER_FOLDERS_FILE), JSON.stringify(folders, null, 2), "utf8");
}

async function readFolders(filePath: string): Promise<UserContentFolders | null> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (!value || typeof value !== "object") return null;
    const record = value as Partial<UserContentFolders>;
    if (!Array.isArray(record.mods) || !Array.isArray(record.shaderpacks)) return null;
    return { mods: await uniqueFolders(record.mods), shaderpacks: await uniqueFolders(record.shaderpacks) };
  } catch { return null; }
}

async function uniqueFolders(folders: unknown[]): Promise<string[]> {
  const resolved = await Promise.all(folders.filter((folder): folder is string => typeof folder === "string").map(async (folder) => {
    const absolute = path.resolve(folder);
    try { return (await fsp.stat(absolute)).isDirectory() ? absolute : null; } catch { return null; }
  }));
  return [...new Set(resolved.filter((folder): folder is string => folder !== null))];
}

async function folderHasExtension(folder: string, extension: string): Promise<boolean> {
  try { return (await fsp.readdir(folder)).some((name) => name.toLowerCase().endsWith(extension)); } catch { return false; }
}

async function collectContentFiles(folders: string[], extension: string): Promise<Array<{ source: string; targetName: string }>> {
  const sourceFiles = (await Promise.all(folders.map(async (folder) => {
    try {
      return (await fsp.readdir(folder, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
        .map((entry) => path.join(folder, entry.name));
    } catch { return []; }
  }))).flat().sort();
  const usedNames = new Set<string>();
  return sourceFiles.map((source) => {
    const original = path.basename(source);
    let targetName = original;
    if (usedNames.has(targetName)) {
      const extension = path.extname(original);
      const base = path.basename(original, extension);
      targetName = `${base}-${createHash("sha256").update(source).digest("hex").slice(0, 8)}${extension}`;
    }
    usedNames.add(targetName);
    return { source, targetName };
  });
}

async function exists(filePath: string): Promise<boolean> {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function readStringArray(filePath: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !item.includes("/") && !item.includes("\\")) : [];
  } catch { return []; }
}
