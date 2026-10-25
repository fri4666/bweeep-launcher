import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.BWEEP_PREVIEW_URL ?? "http://127.0.0.1:5193";
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const [major, minor, patch] = version.split(".").map(Number);
const updateVersion = `${major}.${minor}.${patch + 1}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
const errors = [], screens = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir("design/screens", { recursive: true });
const shot = async (name) => { await page.screenshot({ path: `design/screens/${name}.png` }); screens.push(name); };
async function section(label, id) {
  await page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction((target) => {
    const scroll = document.querySelector(".settingsScroll");
    const node = scroll?.querySelector(`[data-settings-section="${target}"]`);
    return node && Math.abs(node.getBoundingClientRect().top - scroll.getBoundingClientRect().top) < 4;
  }, id);
}
async function settingsFit() {
  return page.locator(".settingsHub").evaluate((hub) => {
    const rect = hub.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && hub.scrollWidth <= hub.clientWidth
      && [...hub.querySelectorAll(".embeddedPanel, .modalBody, .skinLayout, .patchDetail")].every((node) => node.scrollWidth <= node.clientWidth + 1);
  });
}
try {
  await page.goto(`${origin}/?design-preview`, { waitUntil: "networkidle" });
  await page.locator(".heroCopy h2").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector(".profileBox canvas")?.getContext("2d").getImageData(32, 48, 1, 1).data[3] > 0);
  assert.equal(await page.locator(".sideAction, .libraryDetails, .supportPanel, .brandWord, .serverSwitcher").count(), 0, "removed controls remain on home");
  const weekendCard = page.locator(".libraryCard").filter({ hasText: "코블버스 주말" });
  const weekdayCard = page.locator(".libraryCard").filter({ hasText: "코블박스 평일" });
  assert.equal(await page.locator(".libraryCard").count(), 2);
  assert.match(await weekendCard.locator(".libraryConnection").innerText(), /3명 접속 중/);
  assert.match(await weekdayCard.locator(".libraryConnection").innerText(), /월 00:00 열림/);
  assert.deepEqual([...new Set(await page.evaluate(() => window.__serverStatusPorts))].sort((a, b) => a - b), [25565, 31234]);
  await shot("home");
  const cards = page.locator(".libraryCard");
  await weekdayCard.click();
  await page.locator(".heroCopy h2").filter({ hasText: "코블박스 평일" }).waitFor();
  assert.match(await page.locator(".heroCopy").innerText(), /새 월드 · 평일 24시간 운영/);
  assert(await page.getByRole("button", { name: "게임 시작", exact: true }).isDisabled());
  await weekendCard.click();
  await page.locator(".heroCopy h2").filter({ hasText: "코블버스 주말" }).waitFor();
  assert(await page.getByRole("button", { name: "게임 시작", exact: true }).isEnabled());
  checks.push("server-only-rail-with-live-summary", "cobbleverse-and-cobblebox-cards-keep-separate-identity-status-and-schedule", "server-card-switch");
  await page.setViewportSize({ width: 920, height: 620 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".launchButton").getBoundingClientRect().right <= innerWidth));
  await shot("home-compact");
  await page.evaluate(() => window.__authFailure("token_expired"));
  await page.locator(".authFailureLine").waitFor(); await shot("error-compact");
  await page.getByRole("button", { name: "오류 닫기" }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "프로필 및 설정 열기" }).click();
  await page.locator(".skinCard").nth(4).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1, "nested settings dialogs");
  for (const selector of [".memoryList", ".contentFolderGroups", ".nameRow", ".skinGrid", ".modsToolbar", ".inviteCreateRow", ".patchLayout"]) assert.equal(await page.locator(selector).count(), 1, `${selector} is duplicated`);
  assert.equal(await page.locator(".serverChoice").count(), 0);
  assert.equal(await page.locator(".settingsDocument .modalBackdrop").count(), 0);
  await page.evaluate(() => { window.__settingsDocument = document.querySelector(".settingsScroll"); });
  checks.push("one-dialog-one-control-per-setting");
  await shot("settings-hub");
  await page.getByRole("textbox", { name: "인게임 이름", exact: true }).fill("review_name");
  await section("게임 및 파일", "game");
  await shot("settings-game");
  await section("내 계정", "account");
  assert.equal(await page.getByRole("textbox", { name: "인게임 이름", exact: true }).inputValue(), "review_name");
  assert(await page.evaluate(() => window.__settingsDocument === document.querySelector(".settingsScroll")));
  const scrollBox = await page.locator(".settingsScroll").boundingBox();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, 750);
  await page.waitForFunction(() => document.querySelector('.settingsNavigation button[aria-current]')?.textContent !== "내 계정");
  await section("내 계정", "account");
  checks.push("continuous-scroll-and-menu-follow", "draft-preserved-between-sections");
  await section("캐릭터 스킨", "skin");
  await shot("settings-skin");
  const before = await page.locator(".profileBox canvas").evaluate((canvas) => canvas.toDataURL());
  await page.locator(".skinCardPick").filter({ hasText: "보라 기사" }).click();
  assert.equal(await page.locator(".profileBox canvas").evaluate((canvas) => canvas.toDataURL()), before);
  await page.getByRole("button", { name: "이 스킨 적용", exact: true }).click();
  await page.waitForFunction((previous) => document.querySelector(".profileBox canvas").toDataURL() !== previous, before);
  await page.getByRole("button", { name: "기본 스킨으로", exact: true }).click();
  await page.locator(".profileBox").getByRole("img", { name: "기본 Minecraft 캐릭터 미리보기" }).waitFor();
  checks.push("profile-skin-apply-reset");
  await section("편의 모드", "mods"); await shot("settings-mods");
  await section("연결 및 초대", "community"); await shot("settings-community");
  await section("패치노트", "patch"); await shot("settings-patch-notes");
  assert(await settingsFit());
  await page.setViewportSize({ width: 920, height: 620 });
  for (const [label, id] of [["내 계정", "account"], ["캐릭터 스킨", "skin"], ["게임 및 파일", "game"], ["편의 모드", "mods"], ["연결 및 초대", "community"], ["패치노트", "patch"]]) {
    await section(label, id); assert(await settingsFit(), `${id} overflows the minimum window`);
  }
  await section("게임 및 파일", "game"); await shot("settings-hub-compact");
  await page.keyboard.press("Escape");
  await page.locator(".settingsHub").waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "프로필 및 설정 열기" }).evaluate((node) => document.activeElement === node), true);
  checks.push("all-sections-fit-920x620", "escape-restores-profile-focus");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/?design-preview&launch-flow`, { waitUntil: "networkidle" });
  await page.evaluate((nextVersion) => window.__emitUpdate({ state: "downloading", update: { version: nextVersion, notes: [] }, percent: 42 }), updateVersion);
  await page.locator(".updateIndicator").waitFor(); await shot("launcher-update");
  await page.evaluate(() => window.__emitUpdate({ state: "current" }));
  await page.getByRole("button", { name: "게임 시작", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".launchProgressHeading span")?.textContent === "33%");
  assert(await cards.first().isDisabled()); await shot("downloading");
  await page.getByRole("button", { name: "게임 실행 중", exact: true }).waitFor(); await shot("game-starting");
  await page.evaluate(() => window.__exitGame());
  await page.getByRole("button", { name: "게임 시작", exact: true }).waitFor(); assert(await cards.first().isEnabled());
  checks.push("actual-stage-progress", "server-lock-unlock", "launcher-update-indicator");
  await page.goto(`${origin}/?design-preview&signed-out`, { waitUntil: "networkidle" });
  await page.locator(".entryCard h1").waitFor(); await shot("login");
  await page.goto(`${origin}/?design-preview&notice`, { waitUntil: "networkidle" });
  await page.locator(".topbarNotice").waitFor();
  assert.equal(await page.locator(".heroNotice").count(), 0);
  assert.equal(await page.locator(".topbarNotice").count(), 1);
  await shot("notice");
  const closedNotice = await page.locator(".topbarNotice").boundingBox();
  assert.equal(closedNotice.width, 400);
  assert.equal(closedNotice.height, 48);
  assert.doesNotMatch(await page.locator(".noticePreview").innerText(), /\n/);
  await page.getByRole("button", { name: "공지 전체 내용 펼치기", exact: true }).click();
  await page.getByRole("region", { name: "공지 전체 내용", exact: true }).waitFor();
  assert.equal((await page.locator(".topbarNotice").boundingBox()).height, 48);
  await shot("notice-expanded");
  await page.keyboard.press("Escape");
  assert(await page.getByRole("button", { name: "공지 전체 내용 펼치기", exact: true }).evaluate((button) => button === document.activeElement));
  assert.equal(await page.getByRole("region", { name: "공지 전체 내용", exact: true }).count(), 0);
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "공지 전체 내용", exact: true }).waitFor();
  await page.keyboard.press("Space");
  assert.equal(await page.getByRole("region", { name: "공지 전체 내용", exact: true }).count(), 0);
  await page.getByRole("button", { name: "공지 전체 내용 펼치기", exact: true }).click();
  await page.getByRole("button", { name: "프로필 및 설정 열기" }).click();
  await page.locator(".settingsHub").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".settingsHub").waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "공지 전체 내용 펼치기", exact: true }).getAttribute("aria-expanded"), "false");
  await page.setViewportSize({ width: 920, height: 620 });
  const noticeFits = await page.locator(".topbarNotice").evaluate((notice) => {
    const rect = notice.getBoundingClientRect(), header = document.querySelector(".launcherHeader").getBoundingClientRect();
    const logo = document.querySelector(".brand").getBoundingClientRect(), profile = document.querySelector(".profileBox").getBoundingClientRect();
    return rect.top >= header.top && rect.bottom <= header.bottom && rect.left >= logo.right && rect.right <= profile.left;
  });
  assert(noticeFits, "notice must be in the top header, between the launcher icon and profile");
  await shot("notice-compact");
  await page.getByRole("button", { name: "공지 전체 내용 펼치기", exact: true }).click();
  await page.locator(".noticeDetails p").evaluate((text) => { text.textContent = `${"가".repeat(50)}\n${"나".repeat(49)}`; });
  assert(await page.locator(".noticeDetails").evaluate((details) => {
    const rect = details.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && details.scrollWidth <= details.clientWidth && details.querySelector("p").scrollHeight <= details.clientHeight;
  }));
  await shot("notice-long-compact");
  await page.locator(".libraryHeading").click();
  assert.equal(await page.getByRole("region", { name: "공지 전체 내용", exact: true }).count(), 0);
  await page.getByRole("button", { name: "공지 닫기" }).click();
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await page.locator(".topbarNotice").count(), 0, "dismissed notice returned after reload");
  await page.route("**/__design_bridge.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("id: 'design-notice'", "id: 'design-notice-new'") });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".topbarNotice").waitFor();
  await page.unroute("**/__design_bridge.js");
  checks.push("notice-only-in-top-header", "notice-400x48-disclosure", "notice-keyboard-and-outside-collapse", "long-notice-fits-with-visible-close", "notice-dismissal-persists", "new-notice-appears-after-dismissal");
  await page.route("**/__design_bridge.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("catalogUnavailable = false", "catalogUnavailable = true") });
  });
  await page.setViewportSize({ width: 920, height: 620 });
  await page.goto(`${origin}/?design-preview`, { waitUntil: "networkidle" });
  assert(await page.getByRole("button", { name: "게임 시작", exact: true }).isDisabled());
  assert.equal(await page.locator(".libraryRetry").count(), 1); await shot("catalog-error-compact");
  checks.push("catalog-error-blocks-launch");
  assert.deepEqual(errors, []);
  const result = { checks, errors, screens, data: "isolated fixture; no live service or game process; launch-flow slows only fixture timers" };
  await writeFile("design/screens/verification.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
