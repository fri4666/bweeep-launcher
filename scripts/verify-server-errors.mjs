// A launcher newer than the deployed launcher-access gets "지원하지 않는 요청입니다." (HTTP 400)
// for actions the function does not know yet. The player reads one short line instead.
import assert from "node:assert/strict";
import { SERVER_LACKS_FEATURE_TEXT, describeServerMessage, isUnknownActionResponse } from "../dist/src/shared/server-errors.js";

assert.equal(isUnknownActionResponse(400, "지원하지 않는 요청입니다."), true);
assert.equal(isUnknownActionResponse(400, "  지원하지 않는 요청입니다.\n"), true, "surrounding whitespace is ignored");
assert.equal(isUnknownActionResponse(500, "지원하지 않는 요청입니다."), false, "only an HTTP 400 is the unknown-action reply");
assert.equal(isUnknownActionResponse(403, "지원하지 않는 요청입니다."), false);
assert.equal(isUnknownActionResponse(400, "공지 내용이 올바르지 않습니다."), false, "other 400 messages keep their own text");
assert.equal(isUnknownActionResponse(400, undefined), false);
assert.equal(isUnknownActionResponse(400, null), false);

assert.equal(describeServerMessage(400, "지원하지 않는 요청입니다."), SERVER_LACKS_FEATURE_TEXT);
assert.equal(describeServerMessage(400, "공지 내용이 올바르지 않습니다."), "공지 내용이 올바르지 않습니다.");
assert.equal(describeServerMessage(500, "지원하지 않는 요청입니다."), "지원하지 않는 요청입니다.");
assert.ok(SERVER_LACKS_FEATURE_TEXT.length <= 24, "a single short line");

console.log("server-errors=passed");
