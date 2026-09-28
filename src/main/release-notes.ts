import type { PatchNote, ReleaseNoteSection, ReleaseNoteSectionKind, ReleaseNotes } from "../shared/types.js";
import { isNewerLauncherVersion } from "./version.js";

// build/release-notes.txt, which the release workflow also posts as the
// GitHub release body, so it has to read well as Markdown too:
//
//   v0.1.36
//
//   요약: 한 줄 요약
//
//   인사 한두 문장 (패치노트 탭에만 보임)
//
//   ## 새 기능
//   - 짧은 항목
//
//   맺음말 한 문장 (패치노트 탭에만 보임)
//
// The summary, greeting, headings and sign-off are optional. A plain bullet
// list (0.1.35 and older) becomes one list without a heading. The what's new
// dialog shows only the summary and the bullets.
//
// 말투 (tone guide): 게임 패치노트처럼 개발자가 플레이어에게 직접 말하듯
// 씁니다. 맨 위 "요약:" 한 줄, 짧은 인사와 맺음말, 기본은 "~합니다"체에
// 가끔 가벼운 농담이나 솔직한 한마디("깜빡했네요!" 같은)를 섞습니다. 항목마다
// 플레이어에게 무엇이 달라졌는지만 쉬운 말로 적고, 내부 용어(파일 이름,
// 워크플로, 함수 이름)는 쓰지 않습니다. 다른 게임의 문장을 그대로 가져오지
// 말고 말투만 따라 합니다. 업데이트 안내 창에는 요약과 항목 6개까지만
// 나오니, 중요한 항목을 먼저 적습니다.

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

export function parseReleaseNotesText(text: string): { version: string | null } & Omit<ReleaseNotes, "version"> {
  let version: string | null = null;
  let summary: string | null = null;
  let started = false;
  const intro: string[] = [];
  const outro: string[] = [];
  const sections: ReleaseNoteSection[] = [];
  let current: ReleaseNoteSection | null = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const versionLine = VERSION_LINE.exec(line);
    if (versionLine) {
      // Only a first line names the version; a beta's copy of it further down is skipped.
      if (!started) version = versionLine[1];
      started = true;
      continue;
    }
    started = true;
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
    // Other lines are the greeting before the list and the sign-off after it.
    (sections.length === 0 ? intro : outro).push(plain(line));
  }
  const listed = sections.filter((section) => section.items.length > 0);
  // Releases before 0.1.34 were written as prose; their first lines stand in as the summary.
  if (summary === null && listed.length === 0 && intro.length > 0) {
    const prose = intro.splice(0).join(" ");
    summary = prose.length > 240 ? `${prose.slice(0, 239)}…` : prose;
  }
  return { version, summary, intro: intro.join("\n") || null, outro: outro.join("\n") || null, sections: listed };
}

/** The notes for exactly this version, or null when the file is for another one or empty. */
export function parseReleaseNotes(text: string, version: string): ReleaseNotes | null {
  const { version: written, ...notes } = parseReleaseNotesText(text);
  if (written !== version || notes.sections.length === 0) return null;
  return { version, ...notes };
}

/** The summary and the first few items, in order, so a dialog stays short. */
export function shortenReleaseNotes(notes: ReleaseNotes, maxItems: number): ReleaseNotes {
  let left = maxItems;
  const sections: ReleaseNoteSection[] = [];
  for (const section of notes.sections) {
    if (left <= 0) break;
    const items = section.items.slice(0, left);
    left -= items.length;
    sections.push({ ...section, items });
  }
  return { ...notes, intro: null, outro: null, sections };
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
    const { summary, intro, outro, sections } = parseReleaseNotesText(typeof release.body === "string" ? release.body : "");
    notes.push({
      version,
      summary,
      intro,
      outro,
      sections,
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
