import { verifyGithubBundle } from "./verify-github-bundle.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { releaseFileUrl, safeUpdatePath, unsignedManifest, updatePartCount, UPDATE_CHUNK_SIZE, verifyFileUpdateManifest } from "../dist/src/main/file-update-manifest.js";

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "bweeep-update-test-"));
try {
  const packageDir = path.join(temporary, "win-unpacked");
  await fsp.mkdir(path.join(packageDir, "resources"), { recursive: true });
  await fsp.writeFile(path.join(packageDir, "Bweeep.exe"), "desktop runtime");
  await fsp.writeFile(path.join(packageDir, "resources", "app.js"), "new version");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const output = path.join(temporary, "stable.json");
  const created = spawnSync(process.execPath, ["scripts/create-file-release.mjs", packageDir, "0.1.40", "stable", "x64", output], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      BWEEP_UPDATE_SIGNING_KEY_BASE64: Buffer.from(privatePem).toString("base64"),
      BWEEP_UPDATE_PUBLIC_KEY_BASE64: Buffer.from(publicPem).toString("base64")
    },
    encoding: "utf8"
  });
  assert.equal(created.status, 0, created.stderr);
  const manifest = JSON.parse(await fsp.readFile(output, "utf8"));
  const bundlePath = path.join(temporary, "file-update-x64.bin");
  await verifyGithubBundle(manifest, bundlePath);
  const goodBundle = await fsp.readFile(bundlePath);
  const corruptBundle = Buffer.from(goodBundle); corruptBundle[0] ^= 1;
  await fsp.writeFile(bundlePath, corruptBundle);
  await assert.rejects(() => verifyGithubBundle(manifest, bundlePath), /hash mismatch/);
  await fsp.writeFile(bundlePath, Buffer.concat([goodBundle, Buffer.from([0])]));
  await assert.rejects(() => verifyGithubBundle(manifest, bundlePath), /length differs/);
  await fsp.writeFile(bundlePath, goodBundle);
  assert.deepEqual(manifest.files.map((file) => file.path), ["Bweeep.exe", "resources/app.js"]);
  assert.equal(manifest.files[0].packedSize, gzipSync(Buffer.from("desktop runtime"), { level: 6 }).length);
  assert.equal(manifest.files[0].packedSha256, createHash("sha256").update(gzipSync(Buffer.from("desktop runtime"), { level: 6 })).digest("hex"));
  assert.equal(verifyFileUpdateManifest(manifest, publicPem, "0.1.39", "stable", "x64")?.version, "0.1.40");
  assert.equal(verifyFileUpdateManifest(manifest, publicPem, "0.1.40", "stable", "x64"), null);
  assert.match(releaseFileUrl(manifest, "resources/app.js"), /\/blobs\/[a-f0-9]{64}\/part-0000\.bin$/);
  const large = { ...manifest, files: manifest.files.map((file) => ({ ...file })) };
  large.files[0].packedSize = UPDATE_CHUNK_SIZE + 1;
  assert.equal(updatePartCount(large.files[0].packedSize), 2);
  assert.match(releaseFileUrl(large, "Bweeep.exe", 1), /\/part-0001\.bin$/);
  assert.throws(() => releaseFileUrl(large, "Bweeep.exe", 2));
  assert.throws(() => safeUpdatePath("../escape.exe"));
  assert.throws(() => safeUpdatePath("C:/escape.exe"));
  assert.throws(() => safeUpdatePath("resources\\escape.exe"));
  assert.throws(() => releaseFileUrl(manifest, "missing.dll"));
  const changed = { ...manifest, files: manifest.files.map((file) => ({ ...file })) };
  changed.files[1].sha256 = "0".repeat(64);
  assert.throws(() => verifyFileUpdateManifest(changed, publicPem, "0.1.39", "stable", "x64"), /서명/);
  const wrongPath = { ...manifest, files: manifest.files.map((file) => ({ ...file })) };
  wrongPath.files[1].path = "../escape.exe";
  wrongPath.signature = sign(null, Buffer.from(JSON.stringify(unsignedManifest(wrongPath))), privateKey).toString("base64");
  assert.throws(() => verifyFileUpdateManifest(wrongPath, publicPem, "0.1.39", "stable", "x64"), /경로/);
  assert.throws(() => verifyFileUpdateManifest(manifest, publicPem, "0.1.39", "beta", "x64"));
  assert.throws(() => verifyFileUpdateManifest(manifest, publicPem, "0.1.39", "stable", "arm64"));
  console.log("signed-file-update-manifest=passed");
} finally {
  await fsp.rm(temporary, { recursive: true, force: true });
}
