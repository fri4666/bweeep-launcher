import beta from "./electron-builder.beta.js";

export default {
  ...beta,
  directories: { ...beta.directories, output: "release-installer-beta-arm64" },
  artifactName: "Bweeep-Setup-${version}-arm64.${ext}"
};
