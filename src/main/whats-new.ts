import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { WhatsNew } from "../shared/types.js";
import { parseReleaseNotes, shortenReleaseNotes } from "./release-notes.js";

// Shows the release notes once after each update. The notes are the same
// build/release-notes.txt the release workflow requires for every version,
// so every new version brings its own list without further work.

const STATE_FILE = "whats-new.json";
const MAX_NOTES = 6;

/** Release version without a prerelease suffix: 0.1.36-beta.2 shows the 0.1.36 notes. */
function releaseVersion(): string {
  return app.getVersion().split("-")[0];
}

export async function readBundledReleaseNotes(): Promise<string> {
  return fsp.readFile(path.join(app.getAppPath(), "build", "release-notes.txt"), "utf8").catch(() => "");
}

export async function pendingWhatsNew(): Promise<WhatsNew | null> {
  const version = releaseVersion();
  const statePath = path.join(app.getPath("userData"), STATE_FILE);
  const seen = await readSeen(statePath);
  if (seen === version) return null;
  if (seen === null) {
    // No record: either a fresh install, which needs no "what changed", or an
    // update from a launcher older than this feature, which does. A saved
    // login session tells the two apart.
    const usedBefore = await fsp.stat(path.join(app.getPath("userData"), "supabase-auth.json")).then(() => true, () => false);
    if (!usedBefore) {
      await markWhatsNewSeen(version);
      return null;
    }
  }
  const notes = parseReleaseNotes(await readBundledReleaseNotes(), version);
  return notes ? shortenReleaseNotes(notes, MAX_NOTES) : null;
}

export async function markWhatsNewSeen(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return;
  const statePath = path.join(app.getPath("userData"), STATE_FILE);
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify({ seen: version }), "utf8");
}

async function readSeen(statePath: string): Promise<string | null> {
  try {
    const value = JSON.parse(await fsp.readFile(statePath, "utf8")) as { seen?: unknown };
    return typeof value.seen === "string" ? value.seen : null;
  } catch {
    return null;
  }
}
