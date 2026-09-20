import fsp from "node:fs/promises";
import path from "node:path";
import type { UserContentStatus } from "../shared/types.js";

const USER_MODS_FILE = ".bweeep-user-mods.json";

/** Keeps user-owned client content outside of server-managed manifest files. */
export async function prepareUserContent(instanceRoot: string, instanceDir: string): Promise<UserContentStatus> {
  const root = path.resolve(instanceRoot, ".bweeep-user-content");
  const userModsDir = path.join(root, "mods");
  const shaderpacksDir = path.join(root, "shaderpacks");
  const sharedOptionsPath = path.join(root, "options.txt");
  const modsDir = path.join(instanceDir, "mods");
  const instanceShaders = path.join(instanceDir, "shaderpacks");
  await Promise.all([fsp.mkdir(userModsDir, { recursive: true }), fsp.mkdir(shaderpacksDir, { recursive: true }), fsp.mkdir(modsDir, { recursive: true }), fsp.mkdir(instanceShaders, { recursive: true })]);

  // A newly changed instance exports its input settings for later servers; a new
  // instance imports the shared copy before Minecraft starts.
  const instanceOptions = path.join(instanceDir, "options.txt");
  if (await exists(sharedOptionsPath)) await fsp.copyFile(sharedOptionsPath, instanceOptions);

  const desiredMods = await jarFiles(userModsDir);
  const previousMods = await readStringArray(path.join(instanceDir, ".bweeep", USER_MODS_FILE));
  const desiredNames = new Set(desiredMods.map((source) => path.basename(source)));
  let removedManagedMods = 0;
  for (const previous of previousMods) {
    if (!desiredNames.has(previous)) {
      await fsp.rm(path.join(modsDir, previous), { force: true });
      removedManagedMods += 1;
    }
  }
  for (const source of desiredMods) {
    const target = path.join(modsDir, path.basename(source));
    await fsp.copyFile(source, target);
  }
  await fsp.mkdir(path.join(instanceDir, ".bweeep"), { recursive: true });
  await fsp.writeFile(path.join(instanceDir, ".bweeep", USER_MODS_FILE), JSON.stringify([...desiredNames].sort(), null, 2), "utf8");

  for (const source of await zipFiles(shaderpacksDir)) {
    await fsp.copyFile(source, path.join(instanceShaders, path.basename(source)));
  }
  return { userModsDir, shaderpacksDir, sharedOptionsPath, copiedMods: desiredMods.length, removedManagedMods };
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

async function exists(filePath: string): Promise<boolean> {
  try { await fsp.access(filePath); return true; } catch { return false; }
}

async function readStringArray(filePath: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !item.includes("/") && !item.includes("\\")) : [];
  } catch { return []; }
}
