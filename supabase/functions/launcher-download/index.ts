import { createHash } from "node:crypto";

const storageRoot = "https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates";
const chunkSize = 5 * 1024 * 1024;

type Installer = { version: string; arch: "x64" | "arm64"; size: number; sha256: string; chunks: number };

function bytes(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function latestInstaller(arch: "x64" | "arm64") {
  // Public verification key; only the signing key is secret.
  const keyPemBase64 = "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQU9pbjNXR2VGbnFjRTd2aldVazRTQmI5YmZEU204bk93QlBCSlJFcTk1M2M9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=";
  const pem = atob(keyPemBase64);
  const der = bytes(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
  const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
  const response = await fetch(`${storageRoot}/installers/stable/${arch}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error("installer manifest is unavailable");
  const manifest = await response.json();
  if (manifest.schema !== 1 || manifest.arch !== arch ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
      !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || manifest.size > 2_000_000_000 ||
      manifest.chunkSize !== chunkSize || manifest.chunks !== Math.ceil(manifest.size / chunkSize) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.signature !== "string") {
    throw new Error("installer manifest is invalid");
  }
  const { schema, version, size, sha256, chunks } = manifest;
  const payload = { schema, version, arch, size, sha256, chunkSize, chunks };
  const trusted = await crypto.subtle.verify("Ed25519", key, bytes(manifest.signature), new TextEncoder().encode(JSON.stringify(payload)));
  if (!trusted) throw new Error("installer manifest signature is invalid");
  return payload;
}

async function installerPart(manifest: Installer, part: number, fetcher: typeof fetch): Promise<Uint8Array> {
  const name = `part-${String(part).padStart(4, "0")}.bin`;
  const response = await fetcher(`${storageRoot}/installers/${manifest.version}/${manifest.arch}/${manifest.sha256}/${name}`, { cache: "no-store" });
  if (!response.ok) throw new Error("installer part is unavailable");
  const data = new Uint8Array(await response.arrayBuffer());
  const expected = Math.min(chunkSize, manifest.size - part * chunkSize);
  if (data.length !== expected) throw new Error("installer part size is invalid");
  return data;
}

export async function installerResponse(manifest: Installer, fetcher: typeof fetch = fetch): Promise<Response> {
  // Check the first part before sending download headers, so an incomplete
  // release returns an error instead of starting a broken download.
  const firstPart = await installerPart(manifest, 0, fetcher);
  const hash = createHash("sha256");
  let part = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const data = part === 0 ? firstPart : await installerPart(manifest, part, fetcher);
        hash.update(data);
        part++;
        if (part === manifest.chunks) {
          if (hash.digest("hex") !== manifest.sha256) throw new Error("installer checksum is invalid");
          controller.enqueue(data);
          controller.close();
        } else {
          controller.enqueue(data);
        }
      } catch (error) {
        controller.error(error);
      }
    }
  });
  const filename = `Bweeep-Setup-${manifest.version}${manifest.arch === "arm64" ? "-arm64" : ""}.exe`;
  return new Response(stream, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(manifest.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

// GitHub supplies the large body directly; only a matching signed descriptor
// and GitHub's recorded SHA-256 digest can select this redirect.
export async function githubInstallerResponse(manifest: Installer, fetcher: typeof fetch = fetch): Promise<Response | null> {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || !["x64", "arm64"].includes(manifest.arch)) throw new Error("invalid release");
  const filename = `Bweeep-Setup-${manifest.version}${manifest.arch === "arm64" ? "-arm64" : ""}.exe`;
  const url = `https://github.com/fri4666/bweeep-launcher/releases/download/v${manifest.version}/${filename}`;
  const response = await fetcher(`https://api.github.com/repos/fri4666/bweeep-launcher/releases/tags/v${manifest.version}`, {
    headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const release = await response.json();
  if (release.draft !== false || release.prerelease !== false || release.tag_name !== `v${manifest.version}` || !Array.isArray(release.assets)) return null;
  const matches = release.assets.filter((asset: { name?: string }) => asset.name === filename);
  if (matches.length !== 1 || matches[0].size !== manifest.size || matches[0].digest !== `sha256:${manifest.sha256}` || matches[0].browser_download_url !== url) return null;
  return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
}

export async function handleDownload(request: Request): Promise<Response> {
  const requested = new URL(request.url).searchParams.get("arch");
  const arch = requested === "arm64" ? "arm64" : "x64";
  try {
    const manifest = await latestInstaller(arch);
    try {
      const github = await githubInstallerResponse(manifest);
      if (github) return github;
    } catch { /* Legacy signed Storage streaming remains available during migration. */ }
    return await installerResponse(manifest);
  } catch {
    return new Response("런처 설치 파일을 아직 받을 수 없습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
  }
}

if (import.meta.main) Deno.serve(handleDownload);
