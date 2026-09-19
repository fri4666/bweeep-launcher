import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const corePackage = require.resolve("@xmcl/core/package.json");
const shimPath = path.join(path.dirname(corePackage), "utils.js");
const installerBundle = require.resolve("@xmcl/installer");

try {
  await fs.access(shimPath);
} catch {
  await fs.writeFile(
    shimPath,
    "module.exports.isNotNull = (value) => value !== undefined;\n",
    "utf8"
  );
}

const installerPath = path.resolve(installerBundle);
const installerSource = await fs.readFile(installerPath, "utf8");
const patchedInstallerSource = installerSource.replaceAll(
  'require("@xmcl/core/utils")',
  "({ isNotNull: (value) => value !== void 0 })"
);
if (patchedInstallerSource !== installerSource) {
  await fs.writeFile(installerPath, patchedInstallerSource, "utf8");
}
