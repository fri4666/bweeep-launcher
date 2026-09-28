import fs from "node:fs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const base = packageJson.build;

export default {
  ...base,
  appId: "com.fri4666.bweeep.test",
  productName: "Bweeep Test",
  directories: { ...base.directories, output: "release-installer-test" },
  artifactName: "Bweeep-Test-Setup-${version}.${ext}",
  // Each test build gets its own prerelease version (0.1.35-test.2, -test.3, …),
  // so testers receive fixes without the stable version going up.
  extraMetadata: {
    bweeepChannel: "test",
    ...(process.env.BWEEP_TEST_BUILD ? { version: `${packageJson.version}-test.${process.env.BWEEP_TEST_BUILD}` } : {})
  },
  generateUpdatesFilesForAllChannels: true,
  publish: base.publish.map((publisher) => ({ ...publisher, channel: "test" })),
  protocols: [{ name: "Bweeep Test Invite Link", schemes: ["bwe-e-ep-test"] }],
  nsis: { ...base.nsis, shortcutName: "Bweeep Test" }
};
