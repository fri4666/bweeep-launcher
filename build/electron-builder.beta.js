import fs from "node:fs";

// The normal launcher built as a prerelease (0.1.36-beta.1, -beta.2, …) for
// testers and admins. It is the same app as the stable build; only the version
// and the update file (beta.yml instead of latest.yml) differ, so a tester's
// launcher moves on to the stable build once that version is published.
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const base = packageJson.build;
const betaBuild = process.env.BWEEP_BETA_BUILD;
if (!/^[1-9]\d*$/.test(betaBuild ?? "")) {
  throw new Error("BWEEP_BETA_BUILD must be the beta number (1, 2, …); a beta must never carry the stable version.");
}

export default {
  ...base,
  directories: { ...base.directories, output: "release-installer-beta" },
  extraMetadata: { version: `${packageJson.version}-beta.${betaBuild}` },
  publish: base.publish.map((publisher) => ({ ...publisher, channel: "beta" }))
};
