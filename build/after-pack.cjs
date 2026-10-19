const fs = require("node:fs");
const path = require("node:path");

function listFiles(root, relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Package contains a symbolic link: ${next}`);
    if (entry.isDirectory()) files.push(...listFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const key = process.env.BWEEP_UPDATE_PUBLIC_KEY_BASE64;
  if (!key) throw new Error("BWEEP_UPDATE_PUBLIC_KEY_BASE64 is required for file updates");
  fs.writeFileSync(path.join(context.appOutDir, "resources", "bweeep-update-public-key.pem"), Buffer.from(key, "base64"));
  const output = path.join(context.appOutDir, "resources", "bweeep-update-files.json");
  const files = listFiles(context.appOutDir).filter((file) => file !== "resources/bweeep-update-files.json");
  // NSIS adds elevate.exe after afterPack, before the installer is assembled.
  const finalFiles = [...new Set([...files, "resources/elevate.exe"])].sort();
  fs.writeFileSync(output, JSON.stringify({ schema: 1, files: finalFiles }, null, 2) + "\n");
};
