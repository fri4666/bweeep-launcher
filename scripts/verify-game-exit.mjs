import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createMinecraftProcessWatcher } from "@xmcl/core";
import { describeGameExit } from "../dist/src/main/game-exit.js";
import { createGameOutputObserver } from "../dist/src/main/game-telemetry.js";

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

const milestones = [];
const observeOutput = createGameOutputObserver((event) => milestones.push(event));
observeOutput(Buffer.from("Loading Mine"));
observeOutput(Buffer.from("craft 1.21.4 with Fabric Loader 0.18.1\n"));
observeOutput(Buffer.from("Connecting to server.fri4666.com, 25565\n"));
observeOutput(Buffer.from("[KubeJS Startup/]: Loaded script startup_scripts:fishPondDefinitions.js in 0.246 s\n"));
observeOutput(Buffer.from("BWEEP_TARGET_JOINED\nBWEEP_TARGET_LEFT\nBWEEP_TARGET_REJECTED\n"));
assert.deepEqual(milestones.map((event) => event.stage), ["로더 초기화", "서버 연결", "모드팩 스크립트", "선택 서버 입장", "서버 연결 종료", "서버 접속 실패"]);
assert.doesNotMatch(milestones[1].message, /server\.fri4666\.com/);
assert.equal(milestones[5].kind, "error");

const readyChild = new EventEmitter();
readyChild.stdout = new PassThrough();
const readyWatcher = createMinecraftProcessWatcher(readyChild);
let readySignals = 0;
readyWatcher.on("minecraft-window-ready", () => { readySignals += 1; });
readyChild.stdout.write("Reloading ResourceManager: vanilla\n");
readyChild.stdout.write("OpenAL initialized.\n");
assert.equal(readySignals, 1);
readyChild.emit("exit", 0, null);

const earlyExit = new EventEmitter();
earlyExit.stdout = new PassThrough();
const earlyWatcher = createMinecraftProcessWatcher(earlyExit);
let falseReady = false;
earlyWatcher.on("minecraft-window-ready", () => { falseReady = true; });
earlyExit.emit("exit", 0, null);
assert.equal(falseReady, false);

console.log("game-exit-diagnostics=passed");
