import { parseAdminRequest } from "./admin.ts";
import { MAX_NOTICE_LENGTH, normalizeNoticeText, toNotice } from "./notice.ts";

Deno.test("notice text is trimmed, limited and kept to two lines", () => {
  if (normalizeNoticeText("  오늘 9시에 서버 점검해요  ") !== "오늘 9시에 서버 점검해요") throw new Error("Spaces at the ends are removed.");
  if (normalizeNoticeText("첫 줄 \r\n\r\n 둘째 줄") !== "첫 줄\n둘째 줄") throw new Error("Line ends are unified and empty lines dropped.");
  if (normalizeNoticeText("a\nb\nc") !== null) throw new Error("More than two lines are refused.");
  if (normalizeNoticeText("   \n ") !== null || normalizeNoticeText("") !== null || normalizeNoticeText(42) !== null) throw new Error("Empty text is refused.");
  if (normalizeNoticeText("가".repeat(MAX_NOTICE_LENGTH)) === null || normalizeNoticeText("가".repeat(MAX_NOTICE_LENGTH + 1)) !== null) {
    throw new Error("The limit counts characters, not bytes.");
  }
  if (normalizeNoticeText("탭\t문자") !== null || normalizeNoticeText("벨\u0007") !== null) throw new Error("Control characters are refused.");
});

Deno.test("notice actions carry normalized text", () => {
  const set = parseAdminRequest({ action: "setNotice", text: " 공지 " });
  if (!set || set.action !== "setNotice" || set.text !== "공지") throw new Error("setNotice keeps the normalized text.");
  if (parseAdminRequest({ action: "setNotice", text: " " }) !== null || parseAdminRequest({ action: "setNotice" }) !== null) {
    throw new Error("setNotice needs text.");
  }
  if (parseAdminRequest({ action: "clearNotice" })?.action !== "clearNotice") throw new Error("clearNotice needs no fields.");
});

Deno.test("a stored notice row becomes the launcher's shape", () => {
  const notice = toNotice({ id: "0f8fad5b-d9cb-469f-a165-70867728950e", body: "공지", created_at: "2026-10-04T06:00:00+00:00" });
  if (notice?.text !== "공지" || notice.at !== "2026-10-04T06:00:00+00:00") throw new Error("Row fields map to id, text and at.");
  if (toNotice(null) !== null) throw new Error("No row means no notice.");
});
