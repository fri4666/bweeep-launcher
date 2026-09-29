import { isNewerLauncherVersion } from "./version.js";

// Where the normal launcher looks for updates.
//
// Everyone: electron-updater's GitHub provider with allowPrerelease off asks
// GitHub for /releases/latest, which is never a draft or a prerelease, so
// members only ever get a published stable build.
//
// Testers and admins: the GitHub provider cannot be used for them. With
// allowPrerelease on it takes the first stable-or-beta entry of releases.atom
// in feed order, not the highest version. The stable draft is created when a
// version is merged and only published later, after its betas, so a tester on
// 0.1.36-beta.2 could keep seeing beta.2 first and never move to 0.1.36.
// Testers therefore pick the highest of the published stable and -beta.N tags
// here and read that release's own update file.

export const RELEASE_OWNER = "fri4666";
export const RELEASE_REPO = "bweeep-launcher";
export const RELEASES_ATOM_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases.atom`;

const TESTER_TAG = /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;

export interface TesterUpdateFeed {
  tag: string;
  version: string;
  /** beta.yml for a beta release, latest.yml for a stable one. */
  channel: "beta" | "latest";
  /** Download folder of that release; electron-updater reads <channel>.yml from it. */
  url: string;
}

/** Tags of the published releases in GitHub's releases.atom feed. Drafts never appear there. */
export function releaseTagsFromAtom(xml: string): string[] {
  const tags = new Set<string>();
  for (const match of xml.matchAll(/https:\/\/github\.com\/fri4666\/bweeep-launcher\/releases\/tag\/([^"'<>\s/?#]+)/g)) {
    try {
      tags.add(decodeURIComponent(match[1]));
    } catch {
      // A malformed link is skipped like any tag that is not a launcher version.
    }
  }
  return [...tags];
}

/**
 * The newest stable or -beta.N release, when it is newer than the running
 * launcher. -test.N tags belong to the old separate test app and are ignored.
 */
export function selectTesterFeed(tags: readonly string[], currentVersion: string): TesterUpdateFeed | null {
  let best: { tag: string; version: string } | null = null;
  for (const tag of tags) {
    const match = TESTER_TAG.exec(tag);
    if (match && (!best || isNewerLauncherVersion(match[1], best.version))) best = { tag, version: match[1] };
  }
  if (!best || !isNewerLauncherVersion(best.version, currentVersion)) return null;
  return {
    tag: best.tag,
    version: best.version,
    channel: best.version.includes("-") ? "beta" : "latest",
    url: `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/${best.tag}`
  };
}

/** A prerelease build may only be installed while the signed-in member is a tester. */
export function isPrereleaseVersion(version: string): boolean {
  return version.replace(/^v/i, "").split("+")[0].includes("-");
}
