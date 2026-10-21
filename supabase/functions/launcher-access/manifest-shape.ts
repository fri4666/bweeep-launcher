// The manifest shape launcher-access accepts from launcher_releases. Kept free
// of Deno and Supabase imports so scripts/publish-manifest.mjs can run the same
// check in Node before a release row is written.

export interface ModpackFile {
  path: string;
  size: number;
  sha256?: string;
  sha512?: string;
  url: string;
}

export interface InitialInstallBundle {
  url: string;
  size: number;
  sha512: string;
  paths?: string[];
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
  initialInstallBundle?: InitialInstallBundle;
}

export function isModpackManifest(value: unknown): value is ModpackManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<ModpackManifest>;
  return (manifest.initialInstallBundle === undefined || isInitialInstallBundle(manifest.initialInstallBundle)) &&
    typeof manifest.id === "string" && typeof manifest.minecraftVersion === "string" &&
    typeof manifest.loader?.kind === "string" && typeof manifest.loader.version === "string" &&
    manifest.java !== undefined && Number.isSafeInteger(manifest.java.majorVersion) && manifest.java.majorVersion >= 8 &&
    typeof manifest.java.component === "string" && Array.isArray(manifest.files) && manifest.files.every((file) =>
    file && typeof file.path === "string" && typeof file.url === "string" &&
    Number.isSafeInteger(file.size) && file.size >= 0 &&
    (typeof file.sha256 === "string" || typeof file.sha512 === "string")
  );
}

function isInitialInstallBundle(value: unknown): value is InitialInstallBundle {
  if (!value || typeof value !== "object") return false;
  const bundle = value as Partial<InitialInstallBundle>;
  if (typeof bundle.url !== "string" || typeof bundle.size !== "number" || !Number.isSafeInteger(bundle.size) || bundle.size < 1 || !/^[a-f0-9]{128}$/i.test(bundle.sha512 ?? "")) return false;
  try {
    const url = new URL(bundle.url);
    if (url.protocol === "storage:") {
      if (!parseStorageObjectUrl(bundle.url) || url.search || url.hash || url.username || url.password) return false;
    } else if (url.protocol !== "https:" || url.username || url.password) return false;
  } catch { return false; }
  if (bundle.paths !== undefined && (!Array.isArray(bundle.paths) || bundle.paths.length < 1 || bundle.paths.length > 20_000 ||
    !Array.from(bundle.paths).every(isBundlePath) || new Set(bundle.paths.map((name) => name.toLowerCase())).size !== bundle.paths.length)) return false;
  return true;
}

function isBundlePath(value: unknown): value is string {
  if (typeof value !== "string" || /[\\<>:"|?*\u0000-\u001f]/.test(value)) return false;
  if (value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return false;
  if (/^mods\/CrashAssistant-[^/]*\.jar$/i.test(value)) return false;
  return /^mods\/.+\.jar$/i.test(value) || /^(resourcepacks|shaderpacks)\/.+\.zip$/i.test(value);
}

/** Catalog cards expose metadata; launch-only download pointers are resolved by the manifest action. */
export function manifestForCatalog<T extends ModpackManifest>(manifest: T): Omit<T, "initialInstallBundle"> {
  const { initialInstallBundle: _downloadOnlyBundle, ...metadata } = manifest;
  return metadata;
}

interface ManifestDownloadStorage {
  storage: { from(bucket: string): { createSignedUrl(object: string, expiresIn: number): Promise<{ data: { signedUrl: string } | null; error: unknown }> } };
}

/** Auth/group checks stay at the caller; private download pointers become fresh 15-minute URLs. */
export async function resolveManifestDownloads(supabase: ManifestDownloadStorage, rawManifest: unknown): Promise<ModpackManifest> {
  if (!isModpackManifest(rawManifest)) throw new Error("Stored launcher manifest has an invalid shape.");
  const sign = async (value: string, label: string): Promise<string> => {
    const object = parseStorageObjectUrl(value);
    if (!object) return value;
    const { data, error } = await supabase.storage.from(object.bucket).createSignedUrl(object.path, 15 * 60);
    if (error || !data?.signedUrl) throw new Error(`Unable to sign ${label}.`);
    return data.signedUrl;
  };
  const files = await Promise.all(rawManifest.files.map(async (file) => ({ ...file, url: await sign(file.url, `modpack file ${file.path}`) })));
  const bundle = rawManifest.initialInstallBundle;
  return { ...rawManifest, files, ...(bundle ? { initialInstallBundle: { ...bundle, url: await sign(bundle.url, "initial install bundle") } } : {}) };
}

/** `storage://<bucket>/<path>` points at a private Supabase Storage object that is signed per download. */
export function parseStorageObjectUrl(value: string): { bucket: string; path: string } | null {
  if (!value.startsWith("storage://")) return null;
  const url = new URL(value);
  const bucket = url.hostname;
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/i.test(bucket) || !path || path.includes("..")) {
    throw new Error("Stored launcher manifest contains an invalid storage object URL.");
  }
  return { bucket, path };
}
