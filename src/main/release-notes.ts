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
//     - 참고: 항목 아래 작은 메모 (두 칸 들여쓰기, 패치노트 탭에만 보임)
//
//   ## 다음 패치 예고
//   - 기능 이름 없는 짧은 떡밥 (패치노트 탭에만 보임)
//
//   맺음말 한 문장 (패치노트 탭에만 보임)
//
// The summary, greeting, headings, sub-notes and sign-off are optional. A
// plain bullet list (0.1.35 and older) becomes one list without a heading.
// The what's new dialog shows only the summary and the top-level bullets,
// without sub-notes or the next-patch preview.
//
// 말투 (tone guide): 글쓴이는 "월급루팡 클로드"입니다. 읽는 사람은 서버를 함께
// 하는 친구들이라, 발로란트 패치노트처럼 개발자가 직접 말을 거는 투로
// 씁니다. 순서는 "요약:" 한 줄 → "여러분 안녕하세요?! 월급루팡 클로드입니다."
// 같은 인사 → 새 기능 / 바뀐 점 / 고친 문제 / 알려진 문제 → 다음 패치 예고 →
// "루팡은 이만 퇴근합니다!" 같은 맺음말입니다. 기본은 "~해요"체에 가끔 월급값
// 농담이나 솔직한 한마디를 섞고, 헷갈릴 만한 항목 밑에는 "참고:" 메모나
// "걱정하지 마세요." 한마디를 들여 씁니다. 항목마다 플레이어에게 무엇이
// 달라졌는지만 쉬운 말로 적고, 내부 용어(파일 이름, 워크플로, 함수 이름)는
// 쓰지 않습니다. 보안이나 운영에 관한 내부 사항(토큰, 관리자 기능, 장애
// 대비, 기록 수집 같은 것)은 예고에도 적지 않습니다. 이번 버전에 실제로
// 들어간 것만 적고, 예고는 기능 이름 없이 두세 줄짜리 떡밥만 적습니다
// (스포일러 금지). 다른 게임의 문장을 그대로 가져오지 말고 말투만 따라
// 합니다. 업데이트 안내 창에는 요약과 항목 6개까지만 나오니, 중요한 항목을
// 먼저 적습니다.

export const RELEASES_PAGE = "https://github.com/fri4666/bweeep-launcher/releases";

const SECTION_KINDS: Record<string, ReleaseNoteSectionKind> = {
  "새 기능": "new",
  "바뀐 점": "changed",
  "고친 문제": "fixed",
  "알려진 문제": "known",
  "다음 패치 예고": "upcoming"
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
  // Sub-notes of each section's items, index-aligned with its items.
  const details = new Map<ReleaseNoteSection, string[][]>();
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const indent = /^[ \t]*/.exec(raw)![0].replace(/\t/g, "    ").length;
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
      // An indented bullet under an item is that item's small note ("참고: …").
      const notes = current ? details.get(current) : undefined;
      if (indent >= 2 && notes && notes.length > 0) {
        notes[notes.length - 1].push(plain(bullet[1]));
        continue;
      }
      if (!current) {
        current = { kind: "other", title: null, items: [] };
        sections.push(current);
      }
      current.items.push(plain(bullet[1]));
      if (!details.has(current)) details.set(current, []);
      details.get(current)!.push([]);
      continue;
    }
    // Other lines are the greeting before the list and the sign-off after it.
    (sections.length === 0 ? intro : outro).push(plain(line));
  }
  for (const section of sections) {
    const notes = details.get(section);
    if (notes?.some((list) => list.length > 0)) section.details = notes;
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

/**
 * The summary and the first few items, in order, so a dialog stays short:
 * no greeting, sub-notes or next-patch preview.
 */
export function shortenReleaseNotes(notes: ReleaseNotes, maxItems: number): ReleaseNotes {
  let left = maxItems;
  const sections: ReleaseNoteSection[] = [];
  for (const section of notes.sections) {
    if (left <= 0) break;
    if (section.kind === "upcoming") continue;
    const items = section.items.slice(0, left);
    left -= items.length;
    sections.push({ kind: section.kind, title: section.title, items });
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
