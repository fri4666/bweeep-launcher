import fsp from "node:fs/promises";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import path from "node:path";
import { gzipSync } from "node:zlib";

const [input, version, channel, arch, output] = process.argv.slice(2);
if (!input || !output || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version ?? "") ||
    !["stable", "beta"].includes(channel) || !["x64", "arm64"].includes(arch)) {
  throw new Error("usage: create-file-release <win-unpacked> <version> <stable|beta> <x64|arm64> <manifest-output>");
}
if (channel === "stable" && version.includes("-")) throw new Error("stable channel cannot contain a beta version");
const keyBase64 = process.env.BWEEP_UPDATE_SIGNING_KEY_BASE64;
if (!keyBase64) throw new Error("BWEEP_UPDATE_SIGNING_KEY_BASE64 is required");
const key = createPrivateKey(Buffer.from(keyBase64, "base64"));
const publicKeyBase64 = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
if (!publicKeyBase64) throw new Error("BWEEP_UPDATE_PUBLIC_KEY_BASE64 is required");
const expectedPublic = createPublicKey(Buffer.from(publicKeyBase64, "base64")).export({ type: "spki", format: "der" });
const actualPublic = createPublicKey(key).export({ type: "spki", format: "der" });
if (!expectedPublic.equals(actualPublic)) throw new Error("update signing key does not match packaged public key");

async function filesIn(dir, relative = "") {
  const found = [];
  for (const entry of await fsp.readdir(path.join(dir, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not supported: ${next}`);
    if (entry.isDirectory()) found.push(...await filesIn(dir, next));
    else if (entry.isFile()) found.push(next);
  }
  return found;
}

const files = [];
for (const relative of (await filesIn(input)).sort()) {
  const absolute = path.join(input, ...relative.split("/"));
  const bytes = await fsp.readFile(absolute);
  const packed = gzipSync(bytes, { level: 6 });
  files.push({
    path: relative,
    size: bytes.length,
    packedSize: packed.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    packedSha256: createHash("sha256").update(packed).digest("hex")
  });
}
if (!files.some((file) => file.path === "Bweeep.exe")) throw new Error("Bweeep.exe is missing from the package");
const payload = { schema: 1, version, channel, arch, files };
const signature = sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64");
await fsp.mkdir(path.dirname(output), { recursive: true });
await fsp.writeFile(output, JSON.stringify({ ...payload, signature }, null, 2) + "\n");
console.log(`Created signed ${channel}/${arch} file release with ${files.length} files: ${output}`);
