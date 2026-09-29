import type { ModpackManifest } from "../shared/types.js";
import { acceptsMinecraft, type MinecraftRequirement } from "./version-range.js";
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

type MetadataLoader = "fabric" | "quilt" | "forge" | "neoforge";

export interface ModMetadata {
  loaders: Set<MetadataLoader>;
  ids: Set<string>;
  /** Minecraft versions each loader's metadata allows; every requirement must hold. */
  minecraft: Map<MetadataLoader, MinecraftRequirement[]>;
}

export async function readModMetadata(jar: string): Promise<ModMetadata> {
  const entries = await readZipEntries(jar, [FABRIC, QUILT, FORGE, NEOFORGE], METADATA_MAX_BYTES);
  return parseModMetadata(entries);
}

export function parseModMetadata(entries: Map<string, Buffer>): ModMetadata {
  const metadata: ModMetadata = { loaders: new Set(), ids: new Set(), minecraft: new Map() };
  const fabric = parseJson(entries.get(FABRIC));
  if (fabric) {
    metadata.loaders.add("fabric");
    addId(metadata, fabric.id);
    const provides = fabric.provides;
    if (Array.isArray(provides)) provides.forEach((id) => addId(metadata, id));
    const depends = fabric.depends as Record<string, unknown> | undefined;
    const alternatives = strings(depends?.minecraft);
    if (alternatives.length > 0) metadata.minecraft.set("fabric", [{ syntax: "semver", alternatives }]);
  }
  const quilt = parseJson(entries.get(QUILT));
  if (quilt) {
    metadata.loaders.add("quilt");
    const loader = quilt.quilt_loader as Record<string, unknown> | undefined;
    addId(metadata, loader?.id);
    metadata.minecraft.set("quilt", quiltRequirements(loader?.depends));
  }
  for (const [file, loader] of [[FORGE, "forge"], [NEOFORGE, "neoforge"]] as const) {
    const toml = entries.get(file)?.toString("utf8");
    if (!toml) continue;
    metadata.loaders.add(loader);
    for (const match of toml.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)) addId(metadata, match[1]);
    metadata.minecraft.set(loader, tomlMinecraftRanges(toml).map((range) => ({ syntax: "maven", alternatives: [range] })));
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

/**
 * False only when the metadata the pack's loader reads clearly rules out this
 * Minecraft version. Ranges that cannot be read, or none at all, let it through.
 */
export function fitsMinecraft(metadata: ModMetadata, loader: ModpackManifest["loader"]["kind"], minecraftVersion: string): boolean {
  const source: MetadataLoader | null = loader === "fabric" ? "fabric"
    : loader === "forge" ? "forge"
    : loader === "neoforge" ? (metadata.loaders.has("neoforge") ? "neoforge" : "forge")
    : null;
  const requirements = source ? metadata.minecraft.get(source) ?? [] : [];
  return requirements.every((requirement) => acceptsMinecraft(requirement, minecraftVersion) !== false);
}

function quiltRequirements(depends: unknown): MinecraftRequirement[] {
  if (!Array.isArray(depends)) return [];
  const requirements: MinecraftRequirement[] = [];
  for (const entry of depends) {
    const dependency = entry as Record<string, unknown> | null;
    if (!dependency || typeof dependency !== "object" || dependency.id !== "minecraft" || dependency.optional === true) continue;
    const versions = dependency.versions as unknown;
    if (versions && typeof versions === "object" && !Array.isArray(versions)) {
      const group = versions as Record<string, unknown>;
      if (Array.isArray(group.all)) strings(group.all).forEach((range) => requirements.push({ syntax: "semver", alternatives: [range] }));
      else if (strings(group.any).length > 0) requirements.push({ syntax: "semver", alternatives: strings(group.any) });
    } else if (strings(versions).length > 0) {
      requirements.push({ syntax: "semver", alternatives: strings(versions) });
    }
  }
  return requirements;
}

/**
 * versionRange of every [[dependencies.*]] table on "minecraft". Optional
 * ones count too: Minecraft is always present, so loaders check their range.
 */
function tomlMinecraftRanges(toml: string): string[] {
  const ranges: string[] = [];
  let table: Record<string, string> | null = null;
  const flush = () => {
    if (table?.modid?.toLowerCase() === "minecraft" && table.versionrange !== undefined && !/^(incompatible|discouraged)$/i.test(table.type ?? "")) {
      ranges.push(table.versionrange);
    }
  };
  for (const line of toml.split(/\r?\n/)) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line);
    if (header) {
      flush();
      table = /^dependencies\b/i.test(header[1]) ? {} : null;
      continue;
    }
    const pair = table && /^\s*([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/.exec(line);
    if (table && pair) table[pair[1].toLowerCase()] = pair[2] ?? pair[3] ?? pair[4];
  }
  flush();
  return ranges;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
