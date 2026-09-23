import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMinecraftProcessWatcher } from "@xmcl/core";
import { describeGameExit } from "../dist/src/main/game-exit.js";

const child = new EventEmitter();
const watcher = createMinecraftProcessWatcher(child);
let observedExit;
watcher.once("minecraft-exit", (exit) => { observedExit = exit; });
child.emit("exit", null, "SIGSEGV");
assert.equal(observedExit.signal, "SIGSEGV");

const crash = describeGameExit(observedExit);
assert.equal(crash.abnormal, true);
assert.match(crash.message, /신호 SIGSEGV/);
assert.doesNotMatch(crash.message, /코드 없음/);

const nonzero = describeGameExit({ code: 1, signal: null });
assert.equal(nonzero.abnormal, true);
assert.match(nonzero.message, /코드 1/);

const clean = describeGameExit({ code: 0, signal: null });
assert.equal(clean.abnormal, false);
assert.equal(clean.message, "Minecraft가 종료되었습니다.");

const unknown = describeGameExit({ code: null, signal: null });
assert.equal(unknown.abnormal, true);
assert.match(unknown.message, /종료 코드 없음/);

const reported = describeGameExit({ code: 0, signal: null, crashReportLocation: "crash-reports/report.txt" });
assert.equal(reported.abnormal, true);
assert.equal(reported.crashReportLocation, "crash-reports/report.txt");

console.log("game-exit-diagnostics=passed");
