import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const base = packageJson.build;

export default {
  ...base,
  appId: "com.fri4666.bweeep.test",
  productName: "Bweeep Test",
  directories: { ...base.directories, output: "release-installer-test" },
  artifactName: "Bweeep-Test-Setup-${version}.${ext}",
  extraMetadata: { bweeepChannel: "test" },
  generateUpdatesFilesForAllChannels: true,
  publish: base.publish.map((publisher) => ({ ...publisher, channel: "test" })),
  protocols: [{ name: "Bweeep Test Invite Link", schemes: ["bwe-e-ep-test"] }],
  nsis: { ...base.nsis, shortcutName: "Bweeep Test" }
};
