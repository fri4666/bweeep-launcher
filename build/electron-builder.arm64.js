import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const base = packageJson.build;

export default {
  ...base,
  directories: { ...base.directories, output: "release-installer-arm64" },
  artifactName: "Bweeep-Setup-${version}-arm64.${ext}"
};
