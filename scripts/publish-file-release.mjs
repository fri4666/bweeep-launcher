import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createClient } from "@supabase/supabase-js";
import { UPDATE_CHUNK_SIZE, updatePartCount, verifyFileUpdateManifest } from "../dist/src/main/file-update-manifest.js";

const [input, manifestPath, mode] = process.argv.slice(2);
if (!manifestPath || !["files", "channel"].includes(mode) || (mode === "files" && !input)) {
  throw new Error("usage: publish-file-release <win-unpacked|-> <manifest> <files|channel>");
}
const key = process.env.SUPABASE_SECRET_KEY;
if (!key) throw new Error("SUPABASE_SECRET_KEY is required");
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
    const packed = gzipSync(bytes, { level: 6 });
    if (packed.length !== file.packedSize || createHash("sha256").update(packed).digest("hex") !== file.packedSha256) {
      throw new Error(`compressed package differs from signed manifest: ${file.path}`);
    }
    for (let part = 0; part < updatePartCount(file.packedSize); part++) {
      const piece = packed.subarray(part * UPDATE_CHUNK_SIZE, Math.min(packed.length, (part + 1) * UPDATE_CHUNK_SIZE));
      const objectPath = `blobs/${file.packedSha256}/part-${String(part).padStart(4, "0")}.bin`;
      const existingInfo = await bucket.info(objectPath);
      if (!existingInfo.error && existingInfo.data?.size === piece.length) continue;
      if (existingInfo.error && String(existingInfo.error.statusCode) !== "404") {
        throw new Error(`cannot inspect ${objectPath}: ${existingInfo.error.message}`);
      }
      let uploaded = false;
      let lastError = "unknown error";
      const pieceHash = createHash("sha256").update(piece).digest("hex");
      for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
        try {
          const { error } = await bucket.upload(objectPath, piece, { contentType: "application/octet-stream", upsert: false });
          if (!error) {
            uploaded = true;
            break;
          }
          lastError = error.message || String(error);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        try {
          const existing = await bucket.download(objectPath);
          if (!existing.error && existing.data &&
              createHash("sha256").update(Buffer.from(await existing.data.arrayBuffer())).digest("hex") === pieceHash) {
            uploaded = true;
            break;
          }
        } catch { /* The upload can be retried when the read also fails. */ }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
      if (!uploaded) throw new Error(`upload failed after 3 attempts for ${objectPath}: ${lastError}`);
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
