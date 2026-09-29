import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { isNewerLauncherVersion } from "../dist/src/main/version.js";
import { isPrereleaseVersion, releaseTagsFromAtom, selectTesterFeed } from "../dist/src/main/update-feed.js";

const cases = [
  ["0.1.29", "0.1.30", false],
  ["0.1.30", "0.1.30", false],
  ["0.1.31", "0.1.30", true],
  ["v0.1.31", "0.1.30", true],
  ["0.1.30-test.1", "0.1.30", false],
  ["0.1.30", "0.1.30-test.1", true],
  ["0.1.30-test.2", "0.1.30-test.1", true],
  ["0.1.36-beta.10", "0.1.36-beta.9", true],
  ["0.1.36", "0.1.36-beta.3", true],
  ["0.1.36-beta.1", "0.1.36", false]
];

for (const [candidate, current, expected] of cases) {
  const actual = isNewerLauncherVersion(candidate, current);
  if (actual !== expected) {
    throw new Error(`expected ${candidate} newer than ${current} to be ${expected}, got ${actual}`);
  }
}

// --- Tester channel: our own pick over the published tags -------------------

const atom = (tags) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/fri4666/bweeep-launcher/releases</id>
  <link type="text/html" rel="alternate" href="https://github.com/fri4666/bweeep-launcher/releases"/>
${tags.map((tag) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <link rel="alternate" type="text/html" href="https://github.com/fri4666/bweeep-launcher/releases/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">&lt;p&gt;${tag}&lt;/p&gt;</content>
  </entry>`).join("\n")}
</feed>`;

assert.deepEqual(releaseTagsFromAtom(atom(["v0.1.35", "v0.1.35-test.1"])), ["v0.1.35", "v0.1.35-test.1"]);
assert.deepEqual(releaseTagsFromAtom('<link href="https://github.com/someone/else/releases/tag/v9.9.9"/>'), [], "other repositories are ignored");

// (b) newest of the latest beta and stable, whatever the feed order.
let feed = selectTesterFeed(releaseTagsFromAtom(atom(["v0.1.35", "v0.1.36-beta.2", "v0.1.36-beta.1", "v0.1.35-test.1"])), "0.1.35");
assert.equal(feed?.tag, "v0.1.36-beta.2");
assert.equal(feed?.channel, "beta");
assert.equal(feed?.url, "https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.36-beta.2");
// (c) once 0.1.36 is published a tester on beta.2 moves to it, even when beta.2 comes first in the feed.
feed = selectTesterFeed(["v0.1.36-beta.2", "v0.1.36-beta.1", "v0.1.36", "v0.1.35"], "0.1.36-beta.2");
assert.equal(feed?.tag, "v0.1.36");
assert.equal(feed?.channel, "latest");
// (d) the next version's first beta is picked up from stable.
feed = selectTesterFeed(["v0.1.36", "v0.1.37-beta.1", "v0.1.36-beta.2"], "0.1.36");
assert.equal(feed?.tag, "v0.1.37-beta.1");
// Nothing newer: no update. The old test app's -test.N builds are never offered.
assert.equal(selectTesterFeed(["v0.1.36", "v0.1.36-beta.2"], "0.1.36"), null);
assert.equal(selectTesterFeed(["v0.1.37-test.4", "v0.1.36"], "0.1.36"), null);
assert.equal(selectTesterFeed(["v0.1.35"], "0.1.36-beta.1"), null, "a tester never goes back down to an older stable");
assert.equal(isPrereleaseVersion("0.1.36-beta.1"), true);
assert.equal(isPrereleaseVersion("v0.1.36"), false);

// --- electron-updater as installed: what members and testers would get -----

const require = createRequire(import.meta.url);
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider.js");
const { GenericProvider } = require("electron-updater/out/providers/GenericProvider.js");
const { HttpError } = require("builder-util-runtime");
const semver = require("semver");

/** Answers electron-updater's requests from a fake GitHub; records every address asked for. */
function fakeGitHub({ feedTags, latestTag, files }) {
  const requested = [];
  return {
    requested,
    executor: {
      async request(options) {
        const url = `${options.protocol}//${options.hostname}${options.path}`.replace(/\?noCache=[^&]*$/, "");
        requested.push(url);
        if (url === "https://github.com/fri4666/bweeep-launcher/releases.atom") return atom(feedTags);
        if (url === "https://github.com/fri4666/bweeep-launcher/releases/latest") return JSON.stringify({ tag_name: latestTag });
        const download = /\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url);
        const version = download && files[download[1]]?.includes(download[2]) ? download[1].slice(1) : null;
        if (!version) throw new HttpError(404);
        return `version: ${version}\nfiles:\n  - url: Bweeep-Setup-${version}.exe\n    sha512: x\npath: Bweeep-Setup-${version}.exe\nsha512: x\n`;
      }
    }
  };
}

const releases = {
  feedTags: ["v0.1.36-beta.2", "v0.1.36-beta.1", "v0.1.36", "v0.1.35"],
  latestTag: "v0.1.36",
  files: { "v0.1.36": ["latest.yml"], "v0.1.35": ["latest.yml"], "v0.1.36-beta.1": ["beta.yml"], "v0.1.36-beta.2": ["beta.yml"] }
};
const runtime = (executor) => ({ executor, isUseMultipleRangeRequest: false, platform: "win32" });
const updater = (currentVersion, channel, allowPrerelease) => ({
  currentVersion: semver.parse(currentVersion),
  channel,
  allowPrerelease,
  fullChangelog: false,
  isAddNoCacheQuery: false
});

// (a) members: allowPrerelease off reads /releases/latest and that release's latest.yml only.
let github = fakeGitHub(releases);
let info = await new GitHubProvider({ provider: "github", owner: "fri4666", repo: "bweeep-launcher" }, updater("0.1.35", "latest", false), runtime(github.executor)).getLatestVersion();
assert.equal(info.version, "0.1.36");
assert.ok(github.requested.includes("https://github.com/fri4666/bweeep-launcher/releases/latest"));
assert.ok(!github.requested.some((url) => /beta/.test(url)), "a member's check never touches a beta release");
github = fakeGitHub({ ...releases, feedTags: ["v0.1.37-beta.1", ...releases.feedTags] });
info = await new GitHubProvider({ provider: "github", owner: "fri4666", repo: "bweeep-launcher" }, updater("0.1.36", "latest", false), runtime(github.executor)).getLatestVersion();
assert.equal(info.version, "0.1.36", "a newer beta is not offered to members");

// Why testers do not use the GitHub provider: with allowPrerelease on it takes
// the first stable-or-beta entry in feed order. When beta.2 sits above the
// stable release that was drafted earlier, a tester on beta.2 never sees 0.1.36.
github = fakeGitHub(releases);
info = await new GitHubProvider({ provider: "github", owner: "fri4666", repo: "bweeep-launcher" }, updater("0.1.36-beta.2", "beta", true), runtime(github.executor)).getLatestVersion();
assert.equal(info.version, "0.1.36-beta.2", "electron-updater's feed-order pick changed; revisit src/main/update-feed.ts");

// The tester feed instead reads the chosen release's own update file.
for (const [current, expectedVersion, expectedFile] of [
  ["0.1.36-beta.2", "0.1.36", "https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.36/latest.yml"],
  ["0.1.35", "0.1.36", "https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.36/latest.yml"]
]) {
  const picked = selectTesterFeed(releases.feedTags, current);
  github = fakeGitHub(releases);
  const provider = new GenericProvider({ provider: "generic", url: picked.url, channel: picked.channel, useMultipleRangeRequest: false }, updater(current, picked.channel, picked.channel === "beta"), runtime(github.executor));
  const update = await provider.getLatestVersion();
  assert.equal(update.version, expectedVersion);
  assert.deepEqual(github.requested, [expectedFile]);
  assert.equal(provider.resolveFiles(update)[0].url.href, `${picked.url}/Bweeep-Setup-${expectedVersion}.exe`);
}
const beta = selectTesterFeed(["v0.1.37-beta.1", ...releases.feedTags], "0.1.36");
github = fakeGitHub({ ...releases, files: { ...releases.files, "v0.1.37-beta.1": ["beta.yml"] } });
info = await new GenericProvider({ provider: "generic", url: beta.url, channel: beta.channel }, updater("0.1.36", beta.channel, true), runtime(github.executor)).getLatestVersion();
assert.equal(info.version, "0.1.37-beta.1");
assert.deepEqual(github.requested, ["https://github.com/fri4666/bweeep-launcher/releases/download/v0.1.37-beta.1/beta.yml"]);

console.log("launcher-update-version-regressions=passed");
console.log("launcher-update-channel-selection=passed");
