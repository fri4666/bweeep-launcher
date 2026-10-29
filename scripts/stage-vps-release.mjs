import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { verifyFileUpdateManifest, UPDATE_CHUNK_SIZE } from "../dist/src/main/file-update-manifest.js";
import { verifyInstallerDescriptor } from "../dist/src/main/protected-installer.js";

const [runtime, manifestFile, output, installer, descriptorFile] = process.argv.slice(2);
if (!runtime || !manifestFile || !output || Boolean(installer) !== Boolean(descriptorFile)) {
  throw new Error("usage: stage-vps-release <runtime> <signed-manifest> <private-staging-directory> [installer signed-installer-descriptor]");
}
if (!process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64) throw new Error("Update public key is required");
const publicKey = Buffer.from(process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64, "base64").toString("utf8");
const manifest = JSON.parse(await fsp.readFile(manifestFile, "utf8"));
verifyFileUpdateManifest(manifest, publicKey, "0.0.0", manifest.channel, manifest.arch);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function writeImmutable(relative, bytes) {
  const target = path.join(output, ...relative.split("/"));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try { await fsp.writeFile(target, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || hash(await fsp.readFile(target)) !== hash(bytes)) throw error;
  }
}
async function chunks(prefix, bytes) {
  for (let offset = 0, part = 0; offset < bytes.length; offset += UPDATE_CHUNK_SIZE, part++) {
    await writeImmutable(prefix + "/part-" + String(part).padStart(4, "0") + ".bin", bytes.subarray(offset, offset + UPDATE_CHUNK_SIZE));
  }
}
for (const file of manifest.files) {
  const bytes = await fsp.readFile(path.join(runtime, ...file.path.split("/")));
  if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error("Runtime differs from signed manifest: " + file.path);
  const packed = gzipSync(bytes, { level: 6 });
  if (packed.length !== file.packedSize || hash(packed) !== file.packedSha256) throw new Error("Compressed runtime differs from signed manifest: " + file.path);
  await chunks("blobs/" + file.packedSha256, packed);
}
if (installer) {
  const value = JSON.parse(await fsp.readFile(descriptorFile, "utf8"));
  const descriptor = verifyInstallerDescriptor(value, publicKey, manifest.version, manifest.arch);
  const bytes = await fsp.readFile(installer);
  if (bytes.length !== descriptor.size || hash(bytes) !== descriptor.sha256) throw new Error("Installer differs from signed descriptor");
  await chunks("installers/" + descriptor.version + "/" + descriptor.arch + "/" + descriptor.sha256, bytes);
}
console.log("Staged verified immutable VPS parts for " + manifest.version + "/" + manifest.arch + "; no channels changed");
