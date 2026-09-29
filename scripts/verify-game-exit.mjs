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

const killed = describeGameExit({ code: 4294967295, signal: null });
assert.equal(killed.abnormal, true);
assert.match(killed.message, /코드 0xFFFFFFFF/);
assert.equal(killed.code, 4294967295);
assert.match(describeGameExit({ code: 3221225477, signal: null }).message, /코드 0xC0000005/);

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
const guardEvents = [];
const observeGuard = createGameOutputObserver((event) => guardEvents.push(event));
observeGuard(Buffer.from("BWEEP_GUARD_READY\nBWEEP_TARGET_CONNECTED\nBWEEP_GUARD_BLOCKED 1.2.3.4:25565\nBWEEP_TARGET_DISCONNECTED\nBWEEP_TARGET_UNREACHABLE\n"));
assert.deepEqual(guardEvents.map((event) => [event.kind, event.stage]), [
  ["info", "선택 서버 입장"],
  ["info", "다른 서버 차단"],
  ["info", "서버 연결 종료"],
  ["error", "서버 접속 실패"]
]);
assert.deepEqual(milestones.map((event) => event.stage), ["로더 초기화", "서버 연결", "모드팩 스크립트", "선택 서버 입장", "서버 연결 종료", "서버 접속 실패"]);
assert.doesNotMatch(milestones[1].message, /server\.fri4666\.com/);
assert.equal(milestones[5].kind, "error");

// The guard ends the game when it leaves the server; the one line shown is the reason the game logged.
const leaveEvents = (text) => {
  const events = [];
  createGameOutputObserver((event) => events.push(event))(Buffer.from(text));
  return events.filter((event) => event.stage === "서버 연결 끊김" || event.message === "게임 끔");
};
const kicked = leaveEvents([
  "[12:00:00] [Netty Epoll IO #0/INFO]: [STDOUT]: BWEEP_TARGET_CONNECTED",
  "[12:30:00] [Netty Epoll IO #0/INFO]: [STDOUT]: BWEEP_TARGET_DISCONNECTED",
  "[12:30:00] [Render thread/WARN]: Client disconnected with reason: 서버가 닫혔습니다",
  "[12:30:01] [Bweeep leave watch/INFO]: [STDOUT]: BWEEP_EXIT_ON_LEAVE",
  ""
].join("\n"));
assert.deepEqual(kicked, [{ kind: "error", stage: "서버 연결 끊김", message: "서버가 닫혔습니다" }]);
const quitByChoice = leaveEvents("BWEEP_TARGET_CONNECTED\nBWEEP_TARGET_DISCONNECTED\nBWEEP_EXIT_ON_LEAVE\n");
assert.deepEqual(quitByChoice, [{ kind: "info", stage: "서버 연결 종료", message: "게임 끔" }], "leaving by choice shows nothing");
assert.equal(leaveEvents("Client disconnected with reason: Quitting\nBWEEP_EXIT_ON_LEAVE\n")[0].kind, "info");
assert.equal(leaveEvents("Client disconnected with reason: Timed out\nBWEEP_TARGET_CONNECTED\nBWEEP_EXIT_ON_LEAVE\n")[0].kind, "info",
  "a reason from an earlier connection does not count");
assert.equal(leaveEvents("Client disconnected with reason: Timed out\n").length, 0, "the reason alone shows nothing until the game ends");
const [long] = leaveEvents(`Client disconnected with reason: §c§lBanned§r  for ${"x".repeat(80)}\nBWEEP_EXIT_ON_LEAVE\n`);
assert.equal(long.message.length, 60);
assert.ok(long.message.startsWith("Banned for x") && long.message.endsWith("…"));

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
