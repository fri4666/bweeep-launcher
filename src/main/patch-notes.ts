import { app, net } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { PatchNote, PatchNotes } from "../shared/types.js";
import { isReleasePageUrl, parseReleaseNotes, patchNotesFromReleases, RELEASES_PAGE } from "./release-notes.js";
import { isPrereleaseVersion, RELEASE_OWNER, RELEASE_REPO } from "./update-feed.js";
import { readBundledReleaseNotes } from "./whats-new.js";

// The patch notes tab reads the published GitHub releases. It is loaded only
// when the tab opens, so a slow or offline network never holds up the
// launcher; the last good list and then this build's own notes stand in.

const RELEASES_API = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases?per_page=20`;
const CACHE_FILE = "patch-notes.json";
const FETCH_TIMEOUT_MS = 5_000;
/** GitHub allows 60 API calls an hour per address without a token. */
const REUSE_MS = 10 * 60_000;

let recent: { at: number; releases: StoredRelease[] } | null = null;

/** The release fields the notes need; the cache keeps only these. */
interface StoredRelease {
  tag_name: unknown;
  body: unknown;
  draft: unknown;
  prerelease: unknown;
  published_at: unknown;
  html_url: unknown;
}

export async function loadPatchNotes(includePrereleases: boolean): Promise<PatchNotes> {
  const currentVersion = app.getVersion();
  try {
    const releases = await fetchReleases();
    return { currentVersion, source: "live", notes: patchNotesFromReleases(releases, includePrereleases) };
  } catch {
    const cached = await readCache();
    if (cached) {
      try {
        return { currentVersion, source: "cache", notes: patchNotesFromReleases(cached, includePrereleases) };
      } catch {
        // A damaged cache falls through to the notes inside this build.
      }
    }
    return { currentVersion, source: "bundled", notes: await bundledNotes(currentVersion) };
  }
}

async function fetchReleases(): Promise<StoredRelease[]> {
  if (recent && Date.now() - recent.at < REUSE_MS) return recent.releases;
  const response = await net.fetch(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`릴리스 목록을 받지 못했습니다. (서버 응답 ${response.status})`);
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) throw new Error("릴리스 목록 형식이 올바르지 않습니다.");
  const releases = payload.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").map((item) => ({
    tag_name: item.tag_name,
    body: item.body,
    draft: item.draft,
    prerelease: item.prerelease,
    published_at: item.published_at,
    html_url: item.html_url
  }));
  recent = { at: Date.now(), releases };
  await writeCache(releases).catch(() => undefined);
  return releases;
}

async function bundledNotes(currentVersion: string): Promise<PatchNote[]> {
  const notes = parseReleaseNotes(await readBundledReleaseNotes(), currentVersion.split("-")[0]);
  if (!notes) return [];
  const url = `${RELEASES_PAGE}/tag/v${currentVersion}`;
  return [{
    ...notes,
    version: currentVersion,
    prerelease: isPrereleaseVersion(currentVersion),
    publishedAt: null,
    url: isReleasePageUrl(url) ? url : null
  }];
}

function cachePath(): string {
  return path.join(app.getPath("userData"), CACHE_FILE);
}

async function readCache(): Promise<StoredRelease[] | null> {
  try {
    const value = JSON.parse(await fsp.readFile(cachePath(), "utf8")) as { releases?: unknown };
    return Array.isArray(value.releases) ? value.releases as StoredRelease[] : null;
  } catch {
    return null;
  }
}

async function writeCache(releases: StoredRelease[]): Promise<void> {
  const target = cachePath();
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify({ savedAt: new Date().toISOString(), releases }), "utf8");
  await fsp.rename(temporary, target);
}
