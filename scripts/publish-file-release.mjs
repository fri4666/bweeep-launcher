import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { UPDATE_CHUNK_SIZE, updatePartCount, verifyFileUpdateManifest } from "../dist/src/main/file-update-manifest.js";

const [input, manifestPath, mode] = process.argv.slice(2);
if (!manifestPath || !["files", "channel"].includes(mode) || (mode === "files" && !input)) {
  throw new Error("usage: publish-file-release <win-unpacked|-> <manifest> <files|channel>");
}
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
const client = createClient("https://tmwvrglzjfzauuygofpp.supabase.co", key, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const bucket = client.storage.from("bweeep-launcher-updates");
const manifestBytes = await fsp.readFile(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const publicKeyBase64 = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
if (!publicKeyBase64) throw new Error("BWEEP_UPDATE_PUBLIC_KEY_BASE64 is required");
verifyFileUpdateManifest(manifest, Buffer.from(publicKeyBase64, "base64").toString("utf8"), "0.0.0", manifest.channel, manifest.arch);

if (mode === "files") {
  for (const file of manifest.files) {
    const source = path.join(input, ...file.path.split("/"));
    const bytes = await fsp.readFile(source);
    if (bytes.byteLength !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`local package differs from signed manifest: ${file.path}`);
    }
    for (let part = 0; part < updatePartCount(file.size); part++) {
      const piece = bytes.subarray(part * UPDATE_CHUNK_SIZE, Math.min(bytes.length, (part + 1) * UPDATE_CHUNK_SIZE));
      const objectPath = `blobs/${file.sha256}/part-${String(part).padStart(4, "0")}.bin`;
      const existingInfo = await bucket.info(objectPath);
      if (!existingInfo.error && existingInfo.data?.size === piece.length) continue;
      if (existingInfo.error && String(existingInfo.error.statusCode) !== "404") {
        throw new Error(`cannot inspect ${objectPath}: ${existingInfo.error.message}`);
      }
      const { error } = await bucket.upload(objectPath, piece, { contentType: "application/octet-stream", upsert: false });
      if (error) {
        const existing = await bucket.download(objectPath);
        if (existing.error || !existing.data ||
            createHash("sha256").update(Buffer.from(await existing.data.arrayBuffer())).digest("hex") !== createHash("sha256").update(piece).digest("hex")) {
          throw new Error(`upload failed for ${objectPath}: ${error.message}`);
        }
      }
    }
  }
  const archivePath = `manifests/${manifest.version}/${manifest.arch}/${manifest.channel}.json`;
  const archived = await bucket.upload(archivePath, manifestBytes, { contentType: "application/json", upsert: true });
  if (archived.error) throw new Error(`manifest upload failed: ${archived.error.message}`);
  console.log(`Uploaded ${manifest.files.length} files and archived the signed manifest`);
} else {
  // The mutable channel pointer is changed only after every file has been
  // uploaded and the release has been approved for this audience.
  const target = `channels/${manifest.channel}/${manifest.arch}.json`;
  const result = await bucket.upload(target, manifestBytes, { contentType: "application/json", upsert: true, cacheControl: "0" });
  if (result.error) throw new Error(`channel update failed: ${result.error.message}`);
  console.log(`Published ${manifest.version} to ${manifest.channel}/${manifest.arch}`);
}
