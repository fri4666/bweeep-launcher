import type { PatchNote, ReleaseNoteSection, ReleaseNoteSectionKind, ReleaseNotes } from "../shared/types.js";
import { isNewerLauncherVersion } from "./version.js";

// build/release-notes.txt, which the release workflow also posts as the
// GitHub release body, so it has to read well as Markdown too:
//
//   v0.1.36
//
//   요약: 한 줄 요약
//
//   ## 새 기능
//   - 짧은 항목
//
// The summary and the headings are optional. A plain bullet list (0.1.35 and
// older) becomes one list without a heading.

export const RELEASES_PAGE = "https://github.com/fri4666/bweeep-launcher/releases";

const SECTION_KINDS: Record<string, ReleaseNoteSectionKind> = {
  "새 기능": "new",
  "바뀐 점": "changed",
  "고친 문제": "fixed",
  "알려진 문제": "known"
};

const VERSION_LINE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/;
/** Stable tags and the normal launcher's -beta.N builds; -test.N belongs to the old separate test app. */
const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;

export function parseReleaseNotesText(text: string): { version: string | null; summary: string | null; sections: ReleaseNoteSection[] } {
  let version: string | null = null;
  let summary: string | null = null;
  let started = false;
  const loose: string[] = [];
  const sections: ReleaseNoteSection[] = [];
  let current: ReleaseNoteSection | null = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const versionLine = !started ? VERSION_LINE.exec(line) : null;
    started = true;
    if (versionLine) {
      version = versionLine[1];
      continue;
    }
    const summaryLine = /^요약\s*[:：]\s*(.+)$/.exec(line);
    if (summaryLine && summary === null && sections.length === 0) {
      summary = plain(summaryLine[1]);
      continue;
    }
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      const title = plain(heading[1]);
      current = { kind: SECTION_KINDS[title] ?? "other", title, items: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!current) {
        current = { kind: "other", title: null, items: [] };
        sections.push(current);
      }
      current.items.push(plain(bullet[1]));
      continue;
    }
    // Other lines, such as the note the workflow puts above a beta's text, are not part of the list.
    loose.push(plain(line));
  }
  const listed = sections.filter((section) => section.items.length > 0);
  // Releases before 0.1.34 were written as prose; their first lines stand in as the summary.
  if (summary === null && listed.length === 0 && loose.length > 0) {
    const prose = loose.join(" ");
    summary = prose.length > 240 ? `${prose.slice(0, 239)}…` : prose;
  }
  return { version, summary, sections: listed };
}

/** The notes for exactly this version, or null when the file is for another one or empty. */
export function parseReleaseNotes(text: string, version: string): ReleaseNotes | null {
  const parsed = parseReleaseNotesText(text);
  if (parsed.version !== version || parsed.sections.length === 0) return null;
  return { version, summary: parsed.summary, sections: parsed.sections };
}

/** Keeps the first few items, in order, so a dialog stays short. */
export function shortenReleaseNotes(notes: ReleaseNotes, maxItems: number): ReleaseNotes {
  let left = maxItems;
  const sections: ReleaseNoteSection[] = [];
  for (const section of notes.sections) {
    if (left <= 0) break;
    const items = section.items.slice(0, left);
    left -= items.length;
    sections.push({ ...section, items });
  }
  return { ...notes, sections };
}

/**
 * Patch notes from the GitHub releases API, newest version first. Drafts are
 * never shown, betas only to testers, and a beta disappears once its stable
 * version is out, so each version appears once.
 */
export function patchNotesFromReleases(payload: unknown, includePrereleases: boolean, limit = 10): PatchNote[] {
  if (!Array.isArray(payload)) throw new Error("릴리스 목록 형식이 올바르지 않습니다.");
  const notes: PatchNote[] = [];
  for (const release of payload as Array<Record<string, unknown> | null>) {
    if (!release || typeof release !== "object" || release.draft !== false) continue;
    const tag = typeof release.tag_name === "string" ? RELEASE_TAG.exec(release.tag_name) : null;
    if (!tag) continue;
    const version = tag[1];
    const prerelease = release.prerelease === true || version.includes("-");
    if (prerelease && !includePrereleases) continue;
    const parsed = parseReleaseNotesText(typeof release.body === "string" ? release.body : "");
    notes.push({
      version,
      summary: parsed.summary,
      sections: parsed.sections,
      prerelease,
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      url: isReleasePageUrl(release.html_url) ? release.html_url : null
    });
  }
  const stable = new Set(notes.filter((note) => !note.prerelease).map((note) => note.version));
  const newestBeta = new Map<string, string>();
  for (const note of notes) {
    const core = note.version.split("-")[0];
    if (!note.prerelease || stable.has(core)) continue;
    const best = newestBeta.get(core);
    if (!best || isNewerLauncherVersion(note.version, best)) newestBeta.set(core, note.version);
  }
  return notes
    .filter((note) => !note.prerelease || newestBeta.get(note.version.split("-")[0]) === note.version)
    .sort((left, right) => isNewerLauncherVersion(left.version, right.version) ? -1 : isNewerLauncherVersion(right.version, left.version) ? 1 : 0)
    .slice(0, limit);
}

/** Only this repository's release pages may be opened from the patch notes. */
export function isReleasePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 300) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username && !url.password
    && !url.search && !url.hash && url.pathname.startsWith("/fri4666/bweeep-launcher/releases/") && url.href === value;
}

/** Bullets are shown as plain text, so Markdown emphasis and code marks are dropped. */
function plain(value: string): string {
  return value.replace(/\*\*|__|`/g, "").trim();
}
