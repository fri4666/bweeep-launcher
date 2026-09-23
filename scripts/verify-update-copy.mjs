import assert from "node:assert/strict";
import { koreanReleaseNotes } from "../dist/src/main/update-copy.js";

assert.deepEqual(koreanReleaseNotes(["<p>Vanilla Minecraft 26.3 survival client.</p>"]), ["Minecraft 26.3 생존 서버용 클라이언트 업데이트"]);
assert.deepEqual(koreanReleaseNotes(["Fix launcher startup race"]), ["여러 오류를 수정했습니다."]);
assert.deepEqual(koreanReleaseNotes(["여러 버그를 수정했습니다."]), ["여러 버그를 수정했습니다."]);
console.log("update-copy-regressions=passed");
