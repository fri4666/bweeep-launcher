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
