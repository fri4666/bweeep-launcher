import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const env = {
  ...process.env,
  BWEEP_UPDATE_PUBLIC_KEY_BASE64: Buffer.from(publicPem).toString("base64"),
  BWEEP_UPDATE_SIGNING_KEY_BASE64: Buffer.from(privatePem).toString("base64")
};
if (!process.argv.includes("--arm-only")) {
  const build = spawnSync("npm", ["run", "package:win", "--", "--publish", "never"], { env, stdio: "inherit" });
  if (build.status !== 0) throw new Error(`Windows package build failed: ${build.status}`);
  const root = path.resolve("release-installer", "win-unpacked");
  const baseline = JSON.parse(await fsp.readFile(path.join(root, "resources", "bweeep-update-files.json"), "utf8"));
  assert.ok(baseline.files.includes("Bweeep.exe"));
  assert.ok(baseline.files.includes("resources/file-update-helper.ps1"));
  assert.equal(await fsp.readFile(path.join(root, "resources", "bweeep-update-public-key.pem"), "utf8"), publicPem.toString());
  assert.ok((await fsp.stat(path.join(root, "resources", "app", "package.json"))).isFile());
  await assert.rejects(fsp.stat(path.join(root, "resources", "app.asar")), { code: "ENOENT" });
  console.log("unpacked-windows-file-package=passed");
}
const armBuild = spawnSync("npx", ["electron-builder", "--win", "dir", "--arm64", "--config", "build/electron-builder.arm64.js", "--publish", "never"], { env, stdio: "inherit" });
if (armBuild.status !== 0) throw new Error(`Windows ARM64 directory build failed: ${armBuild.status}`);
const armRoot = path.resolve("release-installer-arm64", "win-arm64-unpacked");
assert.ok((await fsp.stat(path.join(armRoot, "Bweeep.exe"))).isFile(), "ARM64 output must be win-arm64-unpacked");
assert.ok((await fsp.stat(path.join(armRoot, "resources", "bweeep-update-files.json"))).isFile());
console.log("unpacked-windows-arm64-package=passed");
