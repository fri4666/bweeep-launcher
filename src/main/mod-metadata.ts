import type { ModpackManifest } from "../shared/types.js";
import { readZipEntries } from "./zip-entries.js";

// What a mod jar says about itself. Every loader keeps its metadata at a
// fixed path, so this works for any Minecraft version without knowing it.

const METADATA_MAX_BYTES = 512 * 1024;
const FABRIC = "fabric.mod.json";
const QUILT = "quilt.mod.json";
const FORGE = "META-INF/mods.toml";
const NEOFORGE = "META-INF/neoforge.mods.toml";

/** Ids every loader reports as dependencies rather than as mods. */
const PLATFORM_IDS = new Set(["minecraft", "java", "fabricloader", "fabric", "quilt_loader", "forge", "neoforge"]);

export interface ModMetadata {
  loaders: Set<"fabric" | "quilt" | "forge" | "neoforge">;
  ids: Set<string>;
}

export async function readModMetadata(jar: string): Promise<ModMetadata> {
  const entries = await readZipEntries(jar, [FABRIC, QUILT, FORGE, NEOFORGE], METADATA_MAX_BYTES);
  const metadata: ModMetadata = { loaders: new Set(), ids: new Set() };
  const fabric = parseJson(entries.get(FABRIC));
  if (fabric) {
    metadata.loaders.add("fabric");
    addId(metadata, fabric.id);
    const provides = fabric.provides;
    if (Array.isArray(provides)) provides.forEach((id) => addId(metadata, id));
  }
  const quilt = parseJson(entries.get(QUILT));
  if (quilt) {
    metadata.loaders.add("quilt");
    const loader = quilt.quilt_loader as Record<string, unknown> | undefined;
    addId(metadata, loader?.id);
  }
  for (const [file, loader] of [[FORGE, "forge"], [NEOFORGE, "neoforge"]] as const) {
    const toml = entries.get(file)?.toString("utf8");
    if (!toml) continue;
    metadata.loaders.add(loader);
    for (const match of toml.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)) addId(metadata, match[1]);
  }
  return metadata;
}

/** Whether a jar can load on the pack's loader at all. */
export function runsOn(metadata: ModMetadata, loader: ModpackManifest["loader"]["kind"]): boolean {
  if (loader === "fabric") return metadata.loaders.has("fabric");
  if (loader === "forge") return metadata.loaders.has("forge");
  // NeoForge still loads mods.toml from the Forge era for its early versions.
  if (loader === "neoforge") return metadata.loaders.has("neoforge") || metadata.loaders.has("forge");
  return false;
}

function addId(metadata: ModMetadata, value: unknown): void {
  if (typeof value !== "string") return;
  const id = value.trim().toLowerCase();
  if (id && !PLATFORM_IDS.has(id)) metadata.ids.add(id);
}

function parseJson(buffer: Buffer | undefined): Record<string, unknown> | null {
  if (!buffer) return null;
  try {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
