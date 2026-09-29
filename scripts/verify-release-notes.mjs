import assert from "node:assert/strict";
import fs from "node:fs";
import { isReleasePageUrl, parseReleaseNotes, parseReleaseNotesText, patchNotesFromReleases, shortenReleaseNotes } from "../dist/src/main/release-notes.js";

// 0.1.35 and older: a plain list without a summary or headings stays one list.
const plainList = "\uFEFFv0.1.35\r\n- 스킨 탭이 생겼어요.\r\n- 게임은 고른 서버에만 접속돼요.\r\n";
assert.deepEqual(parseReleaseNotes(plainList, "0.1.35"), {
  version: "0.1.35",
  summary: null,
  intro: null,
  outro: null,
  sections: [{ kind: "other", title: null, items: ["스킨 탭이 생겼어요.", "게임은 고른 서버에만 접속돼요."] }]
});
assert.equal(parseReleaseNotes(plainList, "0.1.36"), null, "notes for another version are not shown");
assert.equal(parseReleaseNotes("v0.1.36\n\n요약: 비어 있음\n", "0.1.36"), null, "a file without bullets shows nothing");

// The grouped format: summary, greeting, sections in the order written, sign-off.
const grouped = [
  "v0.1.36",
  "",
  "요약: 패치노트 탭이 생겼어요.",
  "",
  "안녕하세요, 개발자입니다!",
  "이번엔 작은 패치예요.",
  "",
  "## 새 기능",
  "- 패치노트 탭",
  "- **테스터**는 새 버전을 먼저 받아요.",
  "",
  "## 고친 문제",
  "* 예전 연결 보호 모드를 정리해요.",
  "",
  "## 알려진 문제",
  "- 아직 없음",
  "",
  "## 기타",
  "- 알 수 없는 제목은 그대로 보여요.",
  "",
  "다음 패치에서 뵙겠습니다!"
].join("\n");
const parsed = parseReleaseNotes(grouped, "0.1.36");
assert.equal(parsed.summary, "패치노트 탭이 생겼어요.");
assert.equal(parsed.intro, "안녕하세요, 개발자입니다!\n이번엔 작은 패치예요.");
assert.equal(parsed.outro, "다음 패치에서 뵙겠습니다!");
assert.deepEqual(parsed.sections.map((section) => [section.kind, section.title, section.items.length]), [
  ["new", "새 기능", 2],
  ["fixed", "고친 문제", 1],
  ["known", "알려진 문제", 1],
  ["other", "기타", 1]
]);
assert.equal(parsed.sections[0].items[1], "테스터는 새 버전을 먼저 받아요.", "Markdown emphasis is dropped");
const short = shortenReleaseNotes(parsed, 3);
assert.deepEqual(short.sections.map((section) => section.items.length), [2, 1]);
assert.equal(short.summary, parsed.summary);
assert.equal(short.intro, null, "the dialog leaves out the greeting");
assert.equal(short.outro, null);

// A beta's body starts with the workflow's note; the version line is then not first and is ignored.
const betaBody = `지정 테스터가 먼저 받는 테스트 버전이에요.\n\n${grouped}`;
const betaParsed = parseReleaseNotesText(betaBody);
assert.equal(betaParsed.version, null);
assert.equal(betaParsed.summary, "패치노트 탭이 생겼어요.");
assert.equal(betaParsed.sections.length, 4);
assert.equal(betaParsed.intro, "지정 테스터가 먼저 받는 테스트 버전이에요.\n안녕하세요, 개발자입니다!\n이번엔 작은 패치예요.", "the copied version line is not part of the greeting");

// Releases before 0.1.34 were prose; it becomes the summary so the tab still says something.
const prose = parseReleaseNotesText("이번 버전은 자동 업데이트 흐름을 복구합니다.\n\nMinecraft 실행 단계를 자세히 표시합니다.");
assert.equal(prose.summary, "이번 버전은 자동 업데이트 흐름을 복구합니다. Minecraft 실행 단계를 자세히 표시합니다.");
assert.deepEqual(prose.sections, []);
assert.equal(prose.intro, null);
assert.equal(parseReleaseNotesText("가".repeat(400)).summary.length, 240);

// Indented "참고:" bullets belong to the item above; the next-patch preview is its own group.
const withNotes = [
  "v0.1.36",
  "요약: 요약",
  "인사",
  "## 바뀐 점",
  "- 첫 항목",
  "  - 참고: 첫 메모",
  "\t- 걱정하지 마세요. 둘째 메모",
  "- 둘째 항목",
  "## 다음 패치 예고",
  "- 준비 중",
  "맺음말"
].join("\n");
const noted = parseReleaseNotes(withNotes, "0.1.36");
assert.deepEqual(noted.sections[0].items, ["첫 항목", "둘째 항목"], "sub-notes are not items of their own");
assert.deepEqual(noted.sections[0].details, [["참고: 첫 메모", "걱정하지 마세요. 둘째 메모"], []]);
assert.equal(noted.sections[1].kind, "upcoming");
assert.equal(noted.sections[1].details, undefined, "a group without notes carries no details");
assert.equal(noted.outro, "맺음말");
const notedShort = shortenReleaseNotes(noted, 6);
assert.deepEqual(notedShort.sections.map((section) => section.kind), ["changed"], "the dialog leaves out the next-patch preview");
assert.equal(notedShort.sections[0].details, undefined, "the dialog leaves out sub-notes");
// A stray indented bullet before any item is still an item.
assert.deepEqual(parseReleaseNotesText("## 새 기능\n  - 들여 쓴 첫 항목").sections[0].items, ["들여 쓴 첫 항목"]);

// The file shipped with this build parses for the package version.
const packageVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const bundledText = fs.readFileSync(new URL("../build/release-notes.txt", import.meta.url), "utf8");
const bundled = parseReleaseNotes(bundledText, packageVersion);
assert.ok(bundled && bundled.sections.length > 0, "build/release-notes.txt must list notes for the package version");
assert.ok(bundled.summary && bundled.intro && bundled.outro, "the notes have a summary, a greeting and a sign-off");
assert.ok(bundled.intro.includes("월급루팡 클로드"), "the greeting names the author persona");
assert.ok(bundled.sections.some((section) => section.details?.some((notes) => notes.length > 0)), "sub-notes are parsed from the shipped notes");
assert.equal(bundled.sections.at(-1).kind, "upcoming", "the next-patch preview comes last");
assert.ok(bundled.sections.at(-1).items.length <= 3, "the next-patch preview is a short teaser, not a feature list");
// Patch notes are for players: nothing about security or operations internals.
assert.doesNotMatch(bundledText, /메모리|RAM|토큰|관리자 탭|오프라인 실행|장애|접속 실패 기록|로그 수집/, "the notes mention internal or sensitive details");
for (const section of shortenReleaseNotes(bundled, 6).sections) {
  assert.notEqual(section.kind, "upcoming");
  assert.equal(section.details, undefined);
}
// GitHub renders the file as the release body: sub-notes must sit under a list item as a nested list.
const lines = bundledText.split(/\r?\n/);
for (const [index, line] of lines.entries()) {
  if (!/^\s+[-*]\s/.test(line)) continue;
  assert.match(line, /^ {2}- /, `sub-note on line ${index + 1} must be indented by two spaces`);
  assert.match(lines[index - 1], /^(?: {2})?- /, `sub-note on line ${index + 1} must follow a list item`);
}

// GitHub releases: newest first, no drafts, betas only for testers, one entry per version.
const release = (tag, extra = {}) => ({
  tag_name: tag,
  body: `v${tag.slice(1).split("-")[0]}\n\n요약: ${tag}\n\n## 새 기능\n- ${tag}`,
  draft: false,
  prerelease: tag.includes("-"),
  published_at: "2026-09-28T12:00:00Z",
  html_url: `https://github.com/fri4666/bweeep-launcher/releases/tag/${tag}`,
  ...extra
});
const payload = [
  release("v0.1.37-beta.2"),
  release("v0.1.37-beta.1"),
  release("v0.1.37", { draft: true }),
  release("v0.1.36"),
  release("v0.1.36-beta.3"),
  release("v0.1.35-test.1"),
  release("v0.1.35", { html_url: "https://evil.example/releases/tag/v0.1.35" }),
  release("v0.1.9"),
  null,
  { tag_name: 7 }
];
assert.deepEqual(patchNotesFromReleases(payload, false).map((note) => note.version), ["0.1.36", "0.1.35", "0.1.9"]);
assert.deepEqual(patchNotesFromReleases(payload, true).map((note) => note.version), ["0.1.37-beta.2", "0.1.36", "0.1.35", "0.1.9"]);
assert.equal(patchNotesFromReleases(payload, false)[1].url, null, "a release page outside the repository is not linked");
assert.equal(patchNotesFromReleases(payload, false)[0].summary, "v0.1.36");
assert.equal(patchNotesFromReleases(payload, false, 1).length, 1);
assert.throws(() => patchNotesFromReleases({ message: "API rate limit exceeded" }, false));

// Only this repository's release pages can be opened.
for (const url of [
  "https://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.36",
  "https://github.com/fri4666/bweeep-launcher/releases/latest"
]) assert.equal(isReleasePageUrl(url), true, url);
for (const url of [
  "http://github.com/fri4666/bweeep-launcher/releases/tag/v0.1.36",
  "https://github.com.evil.example/fri4666/bweeep-launcher/releases/tag/v1",
  "https://evil@github.com/fri4666/bweeep-launcher/releases/tag/v1",
  "https://github.com:8443/fri4666/bweeep-launcher/releases/tag/v1",
  "https://github.com/fri4666/bweeep-launcher/releases/../../other/repo",
  "https://github.com/fri4666/bweeep-launcher/releases/%2e%2e/%2e%2e/other",
  "https://github.com/fri4666/bweeep-launcher/issues/1",
  "https://github.com/fri4666/bweeep-launcher/releases/tag/v1?redirect=https://evil.example",
  "file:///C:/Windows/System32/calc.exe",
  "javascript:alert(1)",
  42,
  null
]) assert.equal(isReleasePageUrl(url), false, String(url));

console.log("release-notes-format=passed");
console.log("release-notes-sub-notes-and-preview=passed");
console.log("patch-notes-release-selection=passed");
