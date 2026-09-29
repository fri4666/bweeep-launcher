export interface ModpackFile {
  path: string;
  size: number;
  sha256?: string;
  sha512?: string;
  url: string;
}

export interface ModpackManifest {
  schemaVersion: number;
  id: string;
  name: string;
  audience?: "members" | "testers";
  gameAuth?: "offline" | "yggdrasil";
  version: string;
  minecraftVersion: string;
  java: { majorVersion: number; component: string };
  loader: { kind: string; version: string };
  server: { host: string; port: number };
  files: ModpackFile[];
}

export interface CatalogRow {
  pack_id: string;
  manifest: unknown;
  version: string;
}

export interface CatalogEntry {
  manifest: ModpackManifest;
  version: string;
}

/** Why a stored release is left out of the catalog; the caller logs it. */
export interface SkippedRelease {
  packId: string;
  version: string;
  reason: "invalid" | "offline";
}

export function isModpackManifest(value: unknown): value is ModpackManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ModpackManifest>;
  return typeof manifest.id === "string" && typeof manifest.minecraftVersion === "string" &&
    typeof manifest.loader?.kind === "string" && typeof manifest.loader.version === "string" &&
    manifest.java !== undefined && Number.isSafeInteger(manifest.java.majorVersion) && manifest.java.majorVersion >= 8 &&
    typeof manifest.java.component === "string" && Array.isArray(manifest.files) && manifest.files.every((file) =>
    file && typeof file.path === "string" && typeof file.url === "string" &&
    Number.isSafeInteger(file.size) && file.size >= 0 &&
    (typeof file.sha256 === "string" || typeof file.sha512 === "string")
  );
}

/** Offline-mode servers are not allowed: every server checks players through the Bweeep account API. */
export function usesBweeepAccounts(manifest: ModpackManifest): boolean {
  return manifest.gameAuth === "yggdrasil";
}

/**
 * The newest active release of each pack, as the catalog lists it. One broken
 * or offline release is skipped instead of hiding every server.
 * Rows must come newest first.
 */
export function selectCatalog(
  rows: CatalogRow[],
  options: { testAllowed: boolean }
): { entries: CatalogEntry[]; skipped: SkippedRelease[] } {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  const skipped: SkippedRelease[] = [];
  for (const row of rows) {
    if (seen.has(row.pack_id)) continue;
    seen.add(row.pack_id);
    if (!isModpackManifest(row.manifest)) {
      skipped.push({ packId: row.pack_id, version: row.version, reason: "invalid" });
      continue;
    }
    if (!usesBweeepAccounts(row.manifest)) {
      skipped.push({ packId: row.pack_id, version: row.version, reason: "offline" });
      continue;
    }
    if (row.manifest.audience === "testers" && !options.testAllowed) continue;
    // Cards need metadata only. Download URLs are signed when a player
    // actually launches the selected pack.
    entries.push({
      manifest: { ...row.manifest, files: [], clientFeatures: undefined, mrpack: undefined } as ModpackManifest,
      version: row.version
    });
  }
  return { entries, skipped };
}
