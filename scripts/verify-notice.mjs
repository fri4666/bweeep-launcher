// The notice helpers shared by the launcher's main process and its screens.
import assert from "node:assert/strict";
import { MAX_NOTICE_LENGTH, noticeProblem, parseAdminNotice, parseAdminNotices, parseNotice, tidyNoticeText } from "../dist/src/shared/notice.js";

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

// A notice for this member alone says so; everyone-notices keep the old shape.
assert.deepEqual(parseNotice({ id: "p1", text: "너에게", at, personal: true }), { id: "p1", text: "너에게", at, personal: true });
assert.deepEqual(parseNotice({ id: "n1", text: "공지", at, personal: false }), { id: "n1", text: "공지", at }, "only true marks a personal notice");
assert.deepEqual(parseNotice({ id: "n1", text: "공지", at, personal: "yes" }), { id: "n1", text: "공지", at });

// The admin list: who each notice is for, malformed entries left out.
const member = "0f8fad5b-d9cb-469f-a165-70867728950b";
assert.deepEqual(parseAdminNotice({ id: "n1", text: "모두", at, target: null }), { id: "n1", text: "모두", at, target: null });
assert.deepEqual(parseAdminNotice({ id: "n1", text: "모두", at }), { id: "n1", text: "모두", at, target: null });
assert.deepEqual(
  parseAdminNotice({ id: "p1", text: "너에게", at, target: { userId: member, name: "나원", gameName: "nawon" } }),
  { id: "p1", text: "너에게", at, target: { userId: member, name: "나원", gameName: "nawon" } }
);
assert.equal(parseAdminNotice({ id: "p1", text: "너에게", at, target: { userId: member, name: "나원", gameName: 7 } }).target.gameName, null);
assert.equal(parseAdminNotice({ id: "p1", text: "너에게", at, target: { userId: "x", name: "나원" } }), null, "a target needs a real member id");
assert.equal(parseAdminNotice({ id: "p1", text: "너에게", at, target: "나원" }), null);
assert.equal(parseAdminNotice({ id: "p1", text: "", at, target: null }), null);
assert.deepEqual(
  parseAdminNotices([{ id: "n1", text: "모두", at, target: null }, { nope: true }, null, { id: "p1", text: "너에게", at, target: { userId: member, name: "나원", gameName: null } }]).map((notice) => notice.id),
  ["n1", "p1"]
);
assert.deepEqual(parseAdminNotices(undefined), []);
assert.deepEqual(parseAdminNotices({ notices: [] }), []);

console.log("notice: all checks passed");
