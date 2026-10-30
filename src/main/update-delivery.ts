import { UPDATE_STORAGE_ROOT } from "./file-update-manifest.js";

export const UPDATE_DOWNLOAD_ROOT = "https://bweeep.fri4666.com/releases";

export function vpsArtifactUrl(storageUrl: string): string {
  const prefix = UPDATE_STORAGE_ROOT + "/";
  if (!storageUrl.startsWith(prefix)) throw new Error("Invalid update artifact origin");
  const object = storageUrl.slice(prefix.length);
  if (!/^(?:blobs\/[a-f0-9]{64}|installers\/\d+\.\d+\.\d+(?:-beta\.\d+)?\/(?:x64|arm64)\/[a-f0-9]{64})\/part-\d{4}\.bin$/.test(object)) {
    throw new Error("Invalid immutable update artifact");
  }
  return UPDATE_DOWNLOAD_ROOT + "/" + object;
}

export async function fetchUpdateArtifact(
  storageUrl: string,
  options: RequestInit,
  fetcher: (url: string, options?: RequestInit) => Promise<Response>
): Promise<Response> {
  const response = await fetcher(vpsArtifactUrl(storageUrl), { ...options, redirect: "error" });
  // Old releases and unpublished candidates may still exist only in Storage.
  // Other failures are surfaced; corrupt or redirected bodies never silently fall back.
  if (response.status !== 404) return response;
  await response.body?.cancel();
  return fetcher(storageUrl, options);
}
