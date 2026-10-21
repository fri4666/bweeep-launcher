import fsp from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { UPDATE_CHUNK_SIZE } from "../dist/src/main/file-update-manifest.js";

const [file, version, arch, mode] = process.argv.slice(2);
if (!file || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !["x64", "arm64"].includes(arch) ||
    !["archive", "stable"].includes(mode)) {
  throw new Error("usage: publish-installer <setup-exe> <version> <x64|arm64> <archive|stable>");
}
const serviceKey = process.env.SUPABASE_SECRET_KEY;
const publicKeyBase64 = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
if (!serviceKey || !publicKeyBase64) throw new Error("Supabase service key and update public key are required");
const publicKey = createPublicKey(Buffer.from(publicKeyBase64, "base64"));
const client = createClient("https://tmwvrglzjfzauuygofpp.supabase.co", serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const bucket = client.storage.from("bweeep-launcher-updates");
const bytes = await fsp.readFile(file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const payload = {
  schema: 1,
  version,
  arch,
  size: bytes.length,
  sha256,
  chunkSize: UPDATE_CHUNK_SIZE,
  chunks: Math.ceil(bytes.length / UPDATE_CHUNK_SIZE)
};

if (mode === "archive") {
  const privateKeyBase64 = process.env.BWEEP_UPDATE_SIGNING_KEY_BASE64;
  if (!privateKeyBase64) throw new Error("BWEEP_UPDATE_SIGNING_KEY_BASE64 is required");
  const privateKey = createPrivateKey(Buffer.from(privateKeyBase64, "base64"));
  if (!createPublicKey(privateKey).export({ type: "spki", format: "der" }).equals(publicKey.export({ type: "spki", format: "der" }))) {
    throw new Error("installer signing key does not match public key");
  }
  for (let part = 0; part < payload.chunks; part++) {
    const piece = bytes.subarray(part * UPDATE_CHUNK_SIZE, Math.min(bytes.length, (part + 1) * UPDATE_CHUNK_SIZE));
    // Draft releases can be rebuilt with the same version. The installer hash
    // gives each build immutable part URLs, including through Storage caches.
    const objectPath = `installers/${version}/${arch}/${sha256}/part-${String(part).padStart(4, "0")}.bin`;
    const result = await bucket.upload(objectPath, piece, { contentType: "application/octet-stream", upsert: true });
    if (result.error) throw new Error(`installer chunk upload failed: ${result.error.message}`);
  }
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64");
  const manifest = Buffer.from(JSON.stringify({ ...payload, signature }));
  const result = await bucket.upload(`installers/${version}/${arch}.json`, manifest, {
    contentType: "application/json", upsert: true
  });
  if (result.error) throw new Error(`installer manifest upload failed: ${result.error.message}`);
  console.log(`Archived ${payload.chunks} installer chunks for ${version}/${arch}`);
} else {
  const archived = await bucket.download(`installers/${version}/${arch}.json`);
  if (archived.error || !archived.data) throw new Error("archived installer manifest is missing");
  const manifest = JSON.parse(await archived.data.text());
  const { signature, ...signed } = manifest;
  if (JSON.stringify(signed) !== JSON.stringify(payload) ||
      !verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(signature, "base64"))) {
    throw new Error("archived installer does not match this release");
  }
  const result = await bucket.upload(`installers/stable/${arch}.json`, Buffer.from(JSON.stringify(manifest)), {
    contentType: "application/json", upsert: true, cacheControl: "0"
  });
  if (result.error) throw new Error(`stable installer pointer failed: ${result.error.message}`);
  console.log(`Published stable installer ${version}/${arch}`);
}
