// The notice helpers shared by the launcher's main process and its screens.
import assert from "node:assert/strict";
import { MAX_NOTICE_LENGTH, noticeProblem, parseNotice, tidyNoticeText } from "../dist/src/shared/notice.js";

assert.equal(tidyNoticeText("  첫 줄 \r\n\r\n  둘째 줄  "), "첫 줄\n둘째 줄");
assert.equal(noticeProblem("   \n "), "empty");
assert.equal(noticeProblem("가".repeat(MAX_NOTICE_LENGTH)), null);
assert.equal(noticeProblem("가".repeat(MAX_NOTICE_LENGTH + 1)), "long", "the limit counts characters");
assert.equal(noticeProblem("a\nb\nc"), "lines");
assert.equal(noticeProblem("a\n\nb"), null, "empty lines do not count");

const at = "2026-10-04T06:00:00+00:00";
assert.deepEqual(parseNotice({ id: "n1", text: " 공지 ", at }), { id: "n1", text: "공지", at });
assert.equal(parseNotice(null), null);
assert.equal(parseNotice({ id: "n1", text: "", at }), null);
assert.equal(parseNotice({ id: "n1", text: "공지", at: "soon" }), null);
assert.equal(parseNotice({ id: 7, text: "공지", at }), null);
assert.equal(parseNotice({ id: "n1", text: "가".repeat(MAX_NOTICE_LENGTH + 1), at }), null, "a notice over the limit is not shown");

console.log("notice: all checks passed");
