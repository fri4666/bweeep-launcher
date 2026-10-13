// Opening hours of the server gate: the window logic (Korean time, boundaries,
// week wrap, startsOn), the strict config check, and the gate with a fake
// clock with a fake console: a stopped server outside its hours is not started
// and joins are turned away with the next opening time; when the hours end a
// running server is warned (5 min, 1 min, 10 s) and stopped gracefully, once;
// when they begin it is started, once, after the other server has left; a gate
// restart, a hand-opened period, `startsOn`, no schedule and a console that
// does not answer are all handled; new hours load without cutting anyone off.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ServerGate, WAKE_MARKER, changesBetween, formatOpenTime, isOpenAt, nextCloseAt, nextOpenAt, parseSchedule, readConfig, reloadSchedules
} from "./server-gate.mjs";
import { STANDARD_HOURS, STARTS_ON, standardSchedule } from "./gate-schedule.mjs";
import { fakeBackend, fakeControl, freePort, joinClient, sleep, statusPing, until } from "./lib/gate-test-kit.mjs";

let step = 0;
const pass = (name) => console.log(`ok ${++step} ${name}`);
/** Epoch ms of a Korean-time wall clock. */
const kst = (year, month, day, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3_600_000;

// A generic Friday-to-Sunday window and its complement, to test the mechanics (the real hours are checked further down; 2026-10-23 is a Friday).
const START = "2026-10-23";
const cobblemon = parseSchedule({ startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] });
const sunlit = parseSchedule({ startsOn: START, open: [{ from: "sun 12:00", to: "fri 12:00" }] });
const open = (schedule, ...time) => isOpenAt(schedule, kst(...time));

// 1. No schedule, and before startsOn, are always open.
assert.equal(isOpenAt(null, kst(2026, 10, 24, 3)), true);
assert.equal(open(cobblemon, 2026, 10, 22, 12), true, "Thursday before startsOn");
assert.equal(open(cobblemon, 2026, 10, 22, 23, 59, 59), true, "last second before startsOn");
assert.equal(open(sunlit, 2026, 10, 22, 12), true);
pass("always-open-before-startsOn-or-without-schedule");

// 2. Boundaries are [from, to): open at from, closed at to.
assert.equal(open(cobblemon, 2026, 10, 23, 0), false, "startsOn midnight: Cobblemon not open yet");
assert.equal(open(sunlit, 2026, 10, 23, 0), true, "startsOn midnight: Sunlit still open");
assert.equal(open(cobblemon, 2026, 10, 23, 11, 59, 59), false);
assert.equal(open(cobblemon, 2026, 10, 23, 12, 0, 0), true, "Friday 12:00 sharp: Cobblemon opens");
assert.equal(open(sunlit, 2026, 10, 23, 11, 59, 59), true);
assert.equal(open(sunlit, 2026, 10, 23, 12, 0, 0), false, "Friday 12:00 sharp: Sunlit closes");
assert.equal(open(cobblemon, 2026, 10, 25, 11, 59, 59), true);
assert.equal(open(cobblemon, 2026, 10, 25, 12, 0, 0), false, "Sunday 12:00 sharp: Cobblemon closes");
assert.equal(open(sunlit, 2026, 10, 25, 11, 59, 59), false);
assert.equal(open(sunlit, 2026, 10, 25, 12, 0, 0), true, "Sunday 12:00 sharp: Sunlit opens");
pass("window-boundaries");

// 3. The week wraps: Sunlit runs Sunday noon through Monday to Friday noon.
for (const time of [[2026, 10, 25, 23, 59, 59], [2026, 10, 26, 0, 0, 0], [2026, 10, 28, 15], [2026, 10, 30, 11, 59, 59]]) {
  assert.equal(open(sunlit, ...time), true, `Sunlit open ${time.join("-")}`);
  assert.equal(open(cobblemon, ...time), false, `Cobblemon closed ${time.join("-")}`);
}
assert.equal(open(cobblemon, 2026, 10, 24, 3), true, "Saturday night is Cobblemon's");
assert.equal(open(sunlit, 2026, 10, 24, 3), false);
pass("week-wrap-sun-to-fri-and-fri-to-sun");

// 4. Korean time, not UTC: Friday 12:00 KST is 03:00 UTC.
assert.equal(isOpenAt(cobblemon, Date.UTC(2026, 9, 23, 2, 59, 59)), false);
assert.equal(isOpenAt(cobblemon, Date.UTC(2026, 9, 23, 3, 0, 0)), true);
pass("korean-time");

// 5. The two servers never overlap and never leave a gap: every minute of three weeks has exactly one open.
for (let ms = kst(2026, 10, 23); ms < kst(2026, 11, 13); ms += 60_000) {
  assert.notEqual(isOpenAt(cobblemon, ms), isOpenAt(sunlit, ms), `exactly one open at ${new Date(ms).toISOString()}`);
}
pass("servers-never-overlap-or-gap");

// 6. Next opening and closing, and how it reads.
const monday = kst(2026, 10, 26, 9);
assert.equal(nextOpenAt(cobblemon, monday), kst(2026, 10, 30, 12));
assert.equal(formatOpenTime(nextOpenAt(cobblemon, monday)), "금 12:00");
assert.equal(nextOpenAt(sunlit, kst(2026, 10, 30, 12)), kst(2026, 11, 1, 12), "closed Friday noon: reopens Sunday noon");
assert.equal(formatOpenTime(kst(2026, 11, 1, 12)), "일 12:00");
assert.equal(nextOpenAt(sunlit, monday), monday, "open now: now");
assert.equal(nextOpenAt(cobblemon, kst(2026, 10, 25, 12)), kst(2026, 10, 30, 12), "the moment it closes");
assert.equal(nextCloseAt(cobblemon, kst(2026, 10, 24, 8)), kst(2026, 10, 25, 12));
assert.equal(nextCloseAt(sunlit, kst(2026, 10, 26, 8)), kst(2026, 10, 30, 12));
assert.equal(nextCloseAt(cobblemon, monday), null, "closed: no closing time");
assert.equal(nextCloseAt(cobblemon, kst(2026, 10, 20)), null, "before startsOn: no closing time");
pass("next-open-and-close");

// 7. Two windows, and a window that stays inside one day.
const twice = parseSchedule({ open: [{ from: "mon 09:00", to: "mon 10:30" }, { from: "sat 20:00", to: "sun 02:00" }] });
assert.equal(open(twice, 2026, 10, 26, 9, 0), true);
assert.equal(open(twice, 2026, 10, 26, 10, 30), false);
assert.equal(open(twice, 2026, 10, 24, 23), true);
assert.equal(open(twice, 2026, 10, 25, 1, 59), true);
assert.equal(open(twice, 2026, 10, 25, 2, 0), false);
assert.equal(nextOpenAt(twice, kst(2026, 10, 26, 11)), kst(2026, 10, 31, 20));
pass("several-windows");

// 7b. The boundaries the gate acts on: window ends and starts, not startsOn itself, plus the end of a hand-opened period.
const flips = (schedule, from, to, until = 0) => changesBetween(schedule, until, from, to).map((change) => `${change.type} ${formatOpenTime(change.at)}`);
assert.deepEqual(flips(cobblemon, kst(2026, 10, 1), kst(2026, 10, 27)), ["open 금 12:00", "close 일 12:00"], "nothing before startsOn, none at startsOn");
assert.deepEqual(flips(sunlit, kst(2026, 10, 1), kst(2026, 10, 27)), ["close 금 12:00", "open 일 12:00"]);
assert.deepEqual(flips(cobblemon, kst(2026, 10, 1), kst(2026, 10, 22, 23, 59, 59)), [], "the test period has no boundaries");
assert.deepEqual(flips(cobblemon, kst(2026, 10, 26), kst(2026, 11, 8)), ["open 금 12:00", "close 일 12:00", "open 금 12:00"]);
assert.equal(changesBetween(cobblemon, 0, kst(2026, 10, 25, 12), kst(2026, 10, 25, 12))[0].at, kst(2026, 10, 25, 12), "a boundary at the range edge counts");
assert.deepEqual(flips(cobblemon, kst(2026, 10, 26), kst(2026, 10, 28), kst(2026, 10, 27, 10)), ["close 화 10:00"], "the end of a hand-opened period in closed hours is a closing");
assert.deepEqual(flips(cobblemon, kst(2026, 10, 24, 8), kst(2026, 10, 26), kst(2026, 10, 25, 20)), ["close 일 20:00"], "a hand-opened period past the window end moves the closing");
pass("boundaries-the-gate-acts-on");

// 8. Strict checks: anything unclear is refused instead of guessed.
const refuse = (value, reason) => assert.throws(() => parseSchedule(value), reason);
refuse(null, /객체/);
refuse([], /객체/);
refuse({}, /open/);
refuse({ open: [] }, /open/);
refuse({ open: "fri 12:00" }, /open/);
refuse({ open: Array.from({ length: 15 }, () => ({ from: "mon 00:00", to: "tue 00:00" })) }, /open/);
refuse({ open: [{ from: "fri 12:00", to: "sun 12:00" }], extra: 1 }, /알 수 없는/);
refuse({ open: [{ from: "fri 12:00", to: "sun 12:00", also: 1 }] }, /알 수 없는/);
refuse({ open: [{ from: "fri 25:00", to: "sun 12:00" }] }, /fri 25:00/);
refuse({ open: [{ from: "friday 12:00", to: "sun 12:00" }] }, /friday/);
refuse({ open: [{ from: "fri 12:60", to: "sun 12:00" }] }, /12:60/);
refuse({ open: [{ from: "fri 12:00" }] }, /to/);
refuse({ open: [{ from: "fri 12:00", to: "fri 12:00" }] }, /같습니다/);
refuse({ timezone: "UTC", open: [{ from: "fri 12:00", to: "sun 12:00" }] }, /Asia\/Seoul/);
refuse({ startsOn: "2026-02-30", open: [{ from: "fri 12:00", to: "sun 12:00" }] }, /startsOn/);
refuse({ startsOn: "26-10-23", open: [{ from: "fri 12:00", to: "sun 12:00" }] }, /startsOn/);
refuse({ startsOn: 20261023, open: [{ from: "fri 12:00", to: "sun 12:00" }] }, /startsOn/);
assert.equal(parseSchedule({ timezone: "Asia/Seoul", open: [{ from: "fri 12:00", to: "sun 12:00" }] }).startsOnMs, null);
pass("strict-schedule-check");

// 9. gate.json checks go through the same validation, and nothing else changes without a schedule.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bweeep-schedule-"));
const configFile = path.join(stateDir, "gate.json");
const writeConfig = (schedule) => fs.writeFileSync(configFile, JSON.stringify({
  stateDir, servers: [{ unit: "bweeep-hours", listen: 25565, backend: 35565, ...(schedule === undefined ? {} : { schedule }) }]
}));
writeConfig({ startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] });
assert.equal(readConfig(configFile).servers[0].schedule.startsOn, START);
writeConfig({ open: [] });
assert.throws(() => readConfig(configFile), /bweeep-hours\.schedule/);
writeConfig(undefined);
assert.equal(readConfig(configFile).servers[0].schedule, undefined);
pass("gate-json-schedule-check");

// ---- the gate with a fake clock

const baseTiming = { holdPingMs: 150, fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 300, idleMs: 400, hoursCheckMs: 30, lateCloseWaitMs: 50 };
let clock = kst(2026, 10, 26, 9); // Monday 09:00: Cobblemon closed
const lines = [];
const COBBLEMON = { startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] };
const SUNLIT = { startsOn: START, open: [{ from: "sun 12:00", to: "fri 12:00" }] };

function makeGate(unit, { startDelayMs = 200, schedule = COBBLEMON, control: customControl, timing = {} } = {}) {
  return (async () => {
    const backend = fakeBackend(await freePort());
    const control = customControl ? customControl(backend) : fakeControl(backend, startDelayMs);
    const listen = await freePort();
    const gate = new ServerGate(
      { name: unit, unit, listen, backend: backend.port, ...(schedule ? { schedule } : {}) },
      { stateDir, control, log: (line) => lines.push(line), timing: { ...baseTiming, ...timing }, now: () => clock }
    );
    await gate.listen();
    return { gate, backend, control, listen };
  })();
}

/**
 * A gate with a console: `events` is the ordered record of what it did to the server (notices, console stop,
 * systemd stop, start); the console "stop" takes `stopMs` and really stops the fake server.
 */
async function makeRig(unit, { schedule = COBBLEMON, rconWorks = true, stopMs = 20, running = false, timing = {}, events = [], label = unit } = {}) {
  const backend = fakeBackend(await freePort());
  const base = fakeControl(backend, 100);
  const control = {
    calls: base.calls,
    isActive: base.isActive,
    setActive: base.setActive,
    start: async (name) => { events.push(`${label} start`); return base.start(name); },
    stop: async (name) => { events.push(`${label} systemd stop`); return base.stop(name); }
  };
  const rcon = async (_port, password, command) => {
    assert.equal(password, "secret-password");
    if (command.startsWith("tellraw @a ")) {
      const notice = JSON.parse(command.slice("tellraw @a ".length));
      assert.equal(notice.translate, "bweeep.notice");
      assert.equal(notice.fallback, "[공지] %3$s");
      assert.match(command, /^[\x00-\x7f]*$/, "the command is plain ASCII (non-ASCII is escaped)");
      events.push(`${label} notice ${notice.with[0]} ${notice.with[1]}s ${notice.with[2]}`);
      return rconWorks ? "" : null;
    }
    events.push(`${label} rcon ${command}`);
    if (!rconWorks) return null;
    await sleep(stopMs);
    await backend.close();
    base.setActive(false);
    return "Stopping the server";
  };
  if (running) {
    await backend.listen();
    base.setActive(true);
  }
  const listen = await freePort();
  const gate = new ServerGate(
    { name: unit, unit, listen, backend: backend.port, rcon: { port: 1, password: "secret-password" }, ...(schedule ? { schedule } : {}) },
    { stateDir, control, rcon, log: (line) => lines.push(`${label}: ${line}`), timing: { ...baseTiming, idleMs: 60_000, ...timing }, now: () => clock }
  );
  await gate.listen();
  return { gate, backend, control, listen, events, base };
}

try {
  // 10. Closed and stopped: status says closed with the next opening, nothing starts, joins are turned away.
  {
    const { gate, backend, control, listen } = await makeGate("bweeep-closed");
    let status = await statusPing(listen);
    assert.deepEqual(status.bweeep, { gate: "closed", nextOpen: kst(2026, 10, 30, 12) });
    status = await statusPing(listen, `play.example${WAKE_MARKER}`);
    assert.deepEqual(status.bweeep, { gate: "closed", nextOpen: kst(2026, 10, 30, 12) }, "the launcher's Play ping does not start it either");
    const refused = joinClient(listen, "seos_py");
    await until(() => refused.closed, "refused join closed");
    assert.equal(refused.disconnect, "지금은 열려 있지 않아요. 금 12:00에 열려요");
    await sleep(300);
    assert.deepEqual(control.calls, [], "nothing was started");
    assert.equal(backend.joins.length, 0);
    assert.equal(gate.state, "down");
    await gate.close();
    pass("closed-and-stopped-never-starts");
  }

  // 11. The hours end while a player is on: warned at 5 min, 1 min and 10 s, then the console "stop" and systemd, once.
  {
    clock = kst(2026, 10, 24, 15); // Saturday: open
    const rig = await makeRig("bweeep-closing");
    const { gate, events, listen, backend } = rig;
    await statusPing(listen, `x${WAKE_MARKER}`);
    await until(() => gate.state === "up", "up inside its hours");
    const player = joinClient(listen, "seos_py");
    await until(() => player.welcome, "player is in");
    const notices = () => events.filter((event) => event.includes(" notice "));
    clock = kst(2026, 10, 25, 11, 54, 59);
    await sleep(200);
    assert.equal(notices().length, 0, "nothing before 5 minutes are left");
    clock = kst(2026, 10, 25, 11, 55, 0);
    await until(() => notices().length === 1, "the 5-minute warning");
    assert.equal(notices()[0], "bweeep-closing notice warning 8s 5분 뒤 서버가 닫혀요");
    clock = kst(2026, 10, 25, 11, 57, 0);
    await sleep(200);
    assert.equal(notices().length, 1, "each warning once");
    clock = kst(2026, 10, 25, 11, 59, 0);
    await until(() => notices().length === 2, "the 1-minute warning");
    assert.equal(notices()[1], "bweeep-closing notice warning 8s 1분 뒤 서버가 닫혀요");
    clock = kst(2026, 10, 25, 11, 59, 50);
    await until(() => notices().length === 3, "the 10-second warning");
    assert.equal(notices()[2], "bweeep-closing notice urgent 8s 곧 서버가 닫혀요, 지금 저장돼요");
    clock = kst(2026, 10, 25, 11, 59, 59);
    await sleep(200);
    assert.equal(gate.state, "up", "still up one second before the end");
    assert.equal(player.closed, false);
    assert.ok(!events.some((event) => event.includes("stop")), "no stop before the end");
    clock = kst(2026, 10, 25, 12, 0, 0);
    await until(() => gate.state === "down", "stopped at the end");
    assert.deepEqual(events, [
      "bweeep-closing start",
      "bweeep-closing notice warning 8s 5분 뒤 서버가 닫혀요",
      "bweeep-closing notice warning 8s 1분 뒤 서버가 닫혀요",
      "bweeep-closing notice urgent 8s 곧 서버가 닫혀요, 지금 저장돼요",
      "bweeep-closing rcon stop",
      "bweeep-closing systemd stop"
    ]);
    // Once per boundary: more time passing changes nothing, and a join is turned away rather than starting it.
    for (const time of [[2026, 10, 25, 12, 0, 5], [2026, 10, 25, 14], [2026, 10, 27, 10]]) {
      clock = kst(...time);
      await sleep(150);
    }
    const late = joinClient(listen, "friend");
    await until(() => late.closed, "refused once stopped");
    assert.match(late.disconnect, /열려 있지 않아요/);
    assert.equal(events.length, 6, "no second stop, no start");
    // Someone starts it by hand in the closed hours: the boundary was already handled, so it is left alone.
    rig.base.setActive(true);
    await backend.listen();
    await sleep(300);
    assert.equal(events.length, 6, "no stop/start loop");
    await gate.close();
    await backend.close();
    pass("closing-boundary-warns-then-stops-once");
  }

  // 12. The hours begin: started once, after the grace; then the normal rules (idle sleep, wake on join) apply.
  {
    clock = kst(2026, 10, 25, 11, 59, 0); // Sunday just before noon: Sunlit closed
    const rig = await makeRig("bweeep-opening", { schedule: SUNLIT, timing: { idleMs: 500 } });
    const { gate, events, listen } = rig;
    await sleep(200);
    assert.deepEqual(events, [], "closed: nothing");
    clock = kst(2026, 10, 25, 12, 0, 0);
    await sleep(200);
    assert.deepEqual(events, [], "the boundary itself waits out the grace");
    clock = kst(2026, 10, 25, 12, 0, 59);
    await sleep(200);
    assert.deepEqual(events, []);
    clock = kst(2026, 10, 25, 12, 1, 0);
    await until(() => gate.state === "up", "started after the grace");
    assert.deepEqual(events, ["bweeep-opening start"]);
    // Nobody comes: it sleeps again by itself, and the boundary does not start it a second time.
    await until(() => gate.state === "down", "idle sleep");
    clock = kst(2026, 10, 25, 13);
    await sleep(300);
    assert.deepEqual(events, ["bweeep-opening start", "bweeep-opening rcon stop", "bweeep-opening systemd stop"]);
    // A join wakes it as usual.
    const joiner = joinClient(listen, "seos_py");
    await until(() => joiner.welcome, "woken by a join inside the hours");
    assert.equal(events.filter((event) => event.endsWith(" start")).length, 2);
    joiner.socket.destroy();
    await gate.close();
    await rig.backend.close();
    pass("opening-boundary-starts-once");
  }

  // 13. A gate (re)started while a server runs in closed hours: the players get the last warning, then it is stopped, once, also across restarts.
  {
    clock = kst(2026, 10, 26, 9); // Monday: closed since Sunday noon
    const events = [];
    const rig = await makeRig("bweeep-restarted", { running: true, events });
    const { gate, listen, backend } = rig;
    assert.equal(gate.state, "up");
    const player = joinClient(listen, "seos_py");
    await until(() => player.welcome, "player is in");
    await until(() => gate.state === "down", "stopped by the hours");
    assert.deepEqual(events, [
      "bweeep-restarted notice urgent 8s 곧 서버가 닫혀요, 지금 저장돼요",
      "bweeep-restarted rcon stop",
      "bweeep-restarted systemd stop"
    ]);
    await gate.close();
    // The same gate restarted later (same state directory) with the server running again: this boundary is done.
    const again = await makeRig("bweeep-restarted", { running: true, events });
    assert.equal(again.gate.state, "up");
    await sleep(400);
    assert.equal(again.gate.state, "up", "not stopped twice for one boundary");
    assert.equal(events.length, 3);
    await again.gate.close();
    await again.backend.close();
    await backend.close();
    pass("gate-restart-in-closed-hours");
  }

  // 14. A hand-opened period is respected, and its end is a boundary like any other.
  {
    clock = kst(2026, 10, 27, 10); // Tuesday: closed
    const handUntil = clock + 20 * 60_000;
    fs.writeFileSync(path.join(stateDir, "bweeep-byhand.open-until"), new Date(handUntil).toISOString());
    const events = [];
    const rig = await makeRig("bweeep-byhand", { running: true, events });
    const { gate } = rig;
    assert.equal(gate.state, "up");
    await sleep(300);
    assert.deepEqual(events, [], "opened by hand: nothing happens on its own");
    clock = handUntil - 5 * 60_000;
    await until(() => events.length === 1, "5-minute warning before the hand-opened period ends");
    assert.match(events[0], /notice warning 8s 5분 뒤/);
    clock = handUntil;
    await until(() => gate.state === "down", "stopped when the hand-opened period ended");
    assert.deepEqual(events.slice(1), ["bweeep-byhand rcon stop", "bweeep-byhand systemd stop"]);
    await gate.close();
    await rig.backend.close();
    pass("hand-opened-hours-respected");
  }

  // 15. Before startsOn, without a schedule, and with warnings off.
  {
    // Before startsOn nothing happens on its own, whatever the weekday and hour.
    const events = [];
    clock = kst(2026, 10, 18, 11, 0); // the Sunday a week before startsOn
    const rig = await makeRig("bweeep-early", { running: true, events });
    // ...and startsOn itself stops nothing: Cobblemon's tester period runs through that Friday morning until the first window ends.
    for (const time of [[2026, 10, 18, 11, 55], [2026, 10, 18, 12, 0, 1], [2026, 10, 19, 9], [2026, 10, 22, 23, 59, 59], [2026, 10, 23, 0, 0, 5], [2026, 10, 23, 8]]) {
      clock = kst(...time);
      await sleep(150);
    }
    assert.deepEqual(events, []);
    assert.equal(rig.gate.state, "up");
    await rig.gate.close();
    await rig.backend.close();

    // No schedule at all.
    clock = kst(2026, 10, 25, 11, 0);
    const none = await makeRig("bweeep-none", { running: true, schedule: null, events });
    for (const time of [[2026, 10, 25, 11, 55], [2026, 10, 25, 12, 0, 1], [2026, 10, 27, 9]]) {
      clock = kst(...time);
      await sleep(150);
    }
    assert.deepEqual(events, []);
    assert.equal(none.gate.state, "up");
    await none.gate.close();
    await none.backend.close();

    // "warn": false: stopped at the end, without notices.
    clock = kst(2026, 10, 25, 11, 40);
    const quiet = await makeRig("bweeep-quiet", { running: true, schedule: { ...COBBLEMON, warn: false }, events });
    clock = kst(2026, 10, 25, 11, 59, 50);
    await sleep(200);
    assert.deepEqual(events, [], "no warnings");
    clock = kst(2026, 10, 25, 12, 0, 0);
    await until(() => quiet.gate.state === "down", "stopped without warnings");
    assert.deepEqual(events, ["bweeep-quiet rcon stop", "bweeep-quiet systemd stop"]);
    await quiet.gate.close();
    await quiet.backend.close();
    pass("nothing-before-startsOn-or-without-schedule");
  }

  // 16. The real hours. Cobblemon rests every night from 02:00 to 07:00: warned, stopped at 02:00, started at 07:00 (after the grace).
  for (const [month, day, name, nextOpenText] of [[10, 31, "sat", "토 07:00"], [11, 1, "sun", "일 07:00"]]) {
    clock = kst(2026, month, day, 1, 40);
    const events = [];
    const rig = await makeRig(`bweeep-night-${name}`, { running: true, schedule: standardSchedule("bweeep-cobblemon-fabric"), events, label: "c" });
    assert.equal(rig.gate.state, "up");
    clock = kst(2026, month, day, 1, 55, 0);
    await until(() => events.length === 1, `5-minute warning before ${name} 02:00`);
    clock = kst(2026, month, day, 1, 59, 0);
    await until(() => events.length === 2, "1-minute warning");
    clock = kst(2026, month, day, 1, 59, 50);
    await until(() => events.length === 3, "10-second warning");
    clock = kst(2026, month, day, 1, 59, 59);
    await sleep(150);
    assert.equal(rig.gate.state, "up", "still up one second before 02:00");
    clock = kst(2026, month, day, 2, 0, 0);
    await until(() => rig.gate.state === "down", `stopped at ${name} 02:00`);
    assert.deepEqual(events, [
      "c notice warning 8s 5분 뒤 서버가 닫혀요",
      "c notice warning 8s 1분 뒤 서버가 닫혀요",
      "c notice urgent 8s 곧 서버가 닫혀요, 지금 저장돼요",
      "c rcon stop",
      "c systemd stop"
    ]);
    // During the rest the server says when it opens, and a join is turned away with the same time.
    clock = kst(2026, month, day, 3, 0, 0);
    const status = await statusPing(rig.listen);
    assert.deepEqual(status.bweeep, { gate: "closed", nextOpen: kst(2026, month, day, 7, 0, 0) });
    const refused = joinClient(rig.listen, "seos_py");
    await until(() => refused.closed, "refused during the rest");
    assert.equal(refused.disconnect, `지금은 열려 있지 않아요. ${nextOpenText}에 열려요`);
    clock = kst(2026, month, day, 6, 59, 59);
    await sleep(150);
    assert.equal(events.length, 5, "nothing before 07:00");
    clock = kst(2026, month, day, 7, 0, 30);
    await sleep(150);
    assert.equal(events.length, 5, "07:00 itself waits out the grace");
    clock = kst(2026, month, day, 7, 1, 0);
    await until(() => rig.gate.state === "up", "started at 07:00");
    assert.deepEqual(events.slice(5), ["c start"]);
    await sleep(150);
    assert.equal(events.length, 6, "started once");
    await rig.gate.close();
    await rig.backend.close();
  }
  pass("cobblemon-nightly-rest-02-to-07");

  // 17. The two weekend hand-overs happen at the same instant: Friday 17:00 Sunlit closes as Cobblemon opens,
  //     Sunday 19:30 the other way round. The one that opens waits for the grace and for the other to be gone.
  for (const [name, closingUnit, openingUnit, at] of [
    ["friday", "bweeep-society-server", "bweeep-cobblemon-fabric", kst(2026, 10, 30, 17)],
    ["sunday", "bweeep-cobblemon-fabric", "bweeep-society-server", kst(2026, 11, 1, 19, 30)]
  ]) {
    clock = at - 30_000;
    const order = [];
    const quiet = (unit) => ({ ...standardSchedule(unit), warn: false });
    const closing = await makeRig(`bweeep-${name}-closing`, { running: true, events: order, label: "closing", stopMs: 700, schedule: quiet(closingUnit) });
    const opening = await makeRig(`bweeep-${name}-opening`, { events: order, label: "opening", schedule: quiet(openingUnit) });
    assert.equal(closing.gate.state, "up");
    clock = at;
    await until(() => fs.existsSync(path.join(stateDir, `bweeep-${name}-closing.stopping`)), "the closing server is stopping");
    clock = at + 70_000; // past the grace, but the other JVM is still saving
    await sleep(300);
    assert.ok(!order.includes("opening start"), `${name}: the opening server waits while the other is still stopping`);
    await until(() => order.includes("opening start"), "the opening server starts once the other is down");
    await until(() => opening.gate.state === "up", "it is up");
    assert.ok(order.indexOf("opening start") > order.indexOf("closing systemd stop"), order.join(" | "));
    assert.equal(fs.existsSync(path.join(stateDir, `bweeep-${name}-closing.stopping`)), false, "the marker is gone");
    assert.equal(order.filter((event) => event === "opening start").length, 1);
    await closing.gate.close();
    await opening.gate.close();
    await closing.backend.close();
    await opening.backend.close();
  }
  pass("weekend-hand-overs-friday-17-and-sunday-1930");

  // 17. The console does not answer: the notices are logged as not delivered and the stop falls back to systemd's (SIGTERM; the server saves), never anything harsher.
  {
    clock = kst(2026, 10, 25, 11, 40);
    const events = [];
    const rig = await makeRig("bweeep-noconsole", { running: true, rconWorks: false, events });
    clock = kst(2026, 10, 25, 11, 55, 0);
    await until(() => events.length === 1, "the warning is tried");
    clock = kst(2026, 10, 25, 12, 0, 0);
    await until(() => rig.gate.state === "down", "stopped without the console");
    assert.deepEqual(events.at(-2), "bweeep-noconsole rcon stop");
    assert.deepEqual(events.at(-1), "bweeep-noconsole systemd stop");
    const log = lines.join("\n");
    assert.match(log, /bweeep-noconsole\] notice not delivered/);
    assert.match(log, /bweeep-noconsole\] rcon stop failed, stopping with systemd/);
    assert.deepEqual(Object.keys(rig.control).sort(), ["calls", "isActive", "setActive", "start", "stop"], "the gate can only start and stop the unit");
    await rig.gate.close();
    await rig.backend.close();
    pass("failed-console-falls-back-to-systemd-stop");
  }

  // 18. A join arriving while the server is stopping after the hours ended is refused and no restart follows.
  {
    clock = kst(2026, 10, 24, 15);
    const slowStop = (backend) => {
      const base = fakeControl(backend, 100);
      const stop = base.stop;
      base.stop = async (unit) => { await sleep(500); return stop(unit); };
      return base;
    };
    const { gate, control, listen } = await makeGate("bweeep-stopping", { control: slowStop });
    await statusPing(listen, `x${WAKE_MARKER}`);
    await until(() => gate.state === "up", "up");
    await until(() => gate.state === "stopping", "idle stop under way");
    clock = kst(2026, 10, 25, 12);
    const late = joinClient(listen, "seos_py");
    await until(() => late.closed, "join refused while stopping");
    assert.match(late.disconnect, /열려 있지 않아요/);
    await until(() => gate.state === "down", "stopped");
    await sleep(400);
    assert.deepEqual(control.calls, ["start bweeep-stopping", "stop bweeep-stopping"], "not started again");
    await gate.close();
    pass("no-restart-after-stop-when-closed");
  }

  // 19. An admin opens a closed stopped server by hand: it can be woken; a bad or ended file counts for nothing.
  {
    clock = kst(2026, 10, 27, 10); // Tuesday: closed
    const { gate, backend, control, listen } = await makeGate("bweeep-hand");
    const file = path.join(stateDir, "bweeep-hand.open-until");
    fs.writeFileSync(file, "not a time");
    assert.equal(gate.isClosed(), true, "garbage opens nothing");
    fs.writeFileSync(file, new Date(clock - 1000).toISOString());
    assert.equal(gate.isClosed(), true, "an ended override opens nothing");
    fs.writeFileSync(file, new Date(clock + 3_600_000).toISOString());
    assert.equal(gate.isClosed(), false, "an ISO time in the future opens it");
    fs.writeFileSync(file, String(clock + 3_600_000));
    assert.equal(gate.isClosed(), false, "epoch milliseconds work too");
    const status = await statusPing(listen, `x${WAKE_MARKER}`);
    assert.ok(["starting", "sleeping"].includes(status.bweeep.gate));
    await until(() => gate.state === "up", "started by hand-opened hours");
    assert.deepEqual(control.calls, ["start bweeep-hand"]);
    await until(() => gate.state === "down", "idle stop");
    clock += 2 * 3_600_000; // the override has ended
    assert.equal(gate.isClosed(), true);
    assert.equal((await statusPing(listen)).bweeep.gate, "closed");
    await gate.close();
    await backend.close();
    pass("admin-open-until-override");
  }

  // 20. New hours load from gate.json (what SIGHUP does) without cutting a connection while the server is inside them.
  {
    clock = kst(2026, 10, 24, 15); // Saturday: open once Cobblemon's hours exist
    const { gate, backend, listen } = await makeGate("bweeep-hours", { schedule: null, timing: { idleMs: 60_000 } });
    await statusPing(listen, `x${WAKE_MARKER}`);
    await until(() => gate.state === "up", "up without hours");
    const player = joinClient(listen, "seos_py");
    await until(() => player.welcome, "player is in");
    assert.equal(gate.isClosed(), false, "no schedule: always open");
    writeConfig({ startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] });
    const bad = [];
    assert.deepEqual(reloadSchedules(configFile, [gate], (line) => bad.push(line)), ["bweeep-hours"]);
    await sleep(200);
    assert.equal(gate.isClosed(), false, "inside the new hours");
    assert.equal(player.closed, false, "the connection was not touched");
    assert.equal(gate.state, "up");
    writeConfig({ open: [] });
    assert.deepEqual(reloadSchedules(configFile, [gate], (line) => bad.push(line)), [], "an invalid file changes nothing");
    assert.match(bad.join("\n"), /unchanged/);
    fs.writeFileSync(configFile, "{ broken");
    assert.deepEqual(reloadSchedules(configFile, [gate], () => undefined), []);
    clock = kst(2026, 10, 27, 10); // Tuesday: closed by the loaded hours
    assert.equal(gate.isClosed(), true, "old hours kept");
    player.socket.destroy();
    writeConfig(undefined);
    assert.deepEqual(reloadSchedules(configFile, [gate], () => undefined), ["bweeep-hours"]);
    assert.equal(gate.isClosed(), false, "removed hours: open again");
    await gate.close();
    await backend.close();
    pass("reload-hours-without-dropping-players");
  }
} catch (error) {
  console.error(lines.join("\n"));
  throw error;
} finally {
  // (stateDir is removed at the very end)
}

// ---- the standard hours and the helper that puts them in place (scripts/gate-schedule.mjs)

{
  const { withStandardHours, withoutHours, describeHours } = await import("./gate-schedule.mjs");
  const { execFile, execFileSync, spawn } = await import("node:child_process");
  const { gateCodeHash } = await import("./server-gate.mjs");

  // The real hours, written out so an accidental edit shows up here.
  assert.deepEqual(STANDARD_HOURS["bweeep-cobblemon-fabric"], [
    { from: "fri 17:00", to: "sat 02:00" },
    { from: "sat 07:00", to: "sun 02:00" },
    { from: "sun 07:00", to: "sun 19:30" }
  ]);
  assert.deepEqual(STANDARD_HOURS["bweeep-society-server"], [{ from: "sun 19:30", to: "fri 17:00" }]);
  assert.equal(STARTS_ON, "2026-10-23");

  // They parse, start on a Friday, and never overlap; the only time neither is open is Cobblemon's nightly rest (Sat and Sun 02:00-07:00).
  const real = Object.fromEntries(Object.keys(STANDARD_HOURS).map((unit) => [unit, parseSchedule(standardSchedule(unit), unit)]));
  assert.deepEqual(Object.keys(real).sort(), ["bweeep-cobblemon-fabric", "bweeep-society-server"]);
  const startsOnMs = real["bweeep-cobblemon-fabric"].startsOnMs;
  assert.equal(startsOnMs, real["bweeep-society-server"].startsOnMs);
  assert.equal(formatOpenTime(startsOnMs), "금 00:00", `${STARTS_ON} is a Friday`);
  const cob = real["bweeep-cobblemon-fabric"];
  const sun = real["bweeep-society-server"];
  let restMinutes = 0;
  for (let ms = startsOnMs; ms < startsOnMs + 15 * 86_400_000; ms += 60_000) {
    const label = formatOpenTime(ms);
    const isRest = (label.startsWith("토") || label.startsWith("일")) && label.slice(2) >= "02:00" && label.slice(2) < "07:00";
    const [a, b] = [isOpenAt(cob, ms), isOpenAt(sun, ms)];
    assert.ok(!(a && b), `never both open at ${label}`);
    if (isRest) { assert.ok(!a && !b, `both closed during the rest at ${label}`); restMinutes += 1; }
    else assert.ok(a || b, `one of them is open at ${label}`);
  }
  assert.equal(restMinutes, 4 * 300, "two 5-hour rests a week, for two weeks");
  // Boundaries to the second.
  const at = (day, ...time) => kst(2026, 10, day, ...time);
  const state = (...time) => [isOpenAt(cob, kst(...time)), isOpenAt(sun, kst(...time))];
  assert.deepEqual(state(2026, 10, 30, 16, 59, 59), [false, true], "Friday 16:59:59: Sunlit's");
  assert.deepEqual(state(2026, 10, 30, 17, 0, 0), [true, false], "Friday 17:00: hand-over to Cobblemon");
  assert.deepEqual(state(2026, 10, 31, 1, 59, 59), [true, false]);
  assert.deepEqual(state(2026, 10, 31, 2, 0, 0), [false, false], "Saturday 02:00: rest");
  assert.deepEqual(state(2026, 10, 31, 6, 59, 59), [false, false]);
  assert.deepEqual(state(2026, 10, 31, 7, 0, 0), [true, false], "Saturday 07:00: Cobblemon again");
  assert.deepEqual(state(2026, 11, 1, 1, 59, 59), [true, false]);
  assert.deepEqual(state(2026, 11, 1, 2, 0, 0), [false, false], "Sunday 02:00: rest");
  assert.deepEqual(state(2026, 11, 1, 6, 59, 59), [false, false]);
  assert.deepEqual(state(2026, 11, 1, 7, 0, 0), [true, false], "Sunday 07:00");
  assert.deepEqual(state(2026, 11, 1, 19, 29, 59), [true, false]);
  assert.deepEqual(state(2026, 11, 1, 19, 30, 0), [false, true], "Sunday 19:30: hand-over to Sunlit");
  assert.deepEqual(state(2026, 11, 2, 0, 0, 0), [false, true], "Sunday night into Monday: week wrap");
  assert.deepEqual(state(2026, 11, 5, 12), [false, true]);
  // The first weekend: nothing at startsOn itself, then Cobblemon opens Friday 17:00.
  assert.deepEqual(state(2026, 10, 23, 0, 0, 0), [false, true], "startsOn Friday morning: Sunlit still open");
  assert.deepEqual(state(2026, 10, 23, 17, 0, 0), [true, false]);
  // What is said when it opens next, including from the rest hours.
  assert.equal(formatOpenTime(nextOpenAt(cob, kst(2026, 10, 31, 3))), "토 07:00");
  assert.equal(formatOpenTime(nextOpenAt(cob, kst(2026, 11, 1, 3))), "일 07:00");
  assert.equal(formatOpenTime(nextOpenAt(cob, kst(2026, 11, 1, 20))), "금 17:00");
  assert.equal(formatOpenTime(nextOpenAt(sun, kst(2026, 10, 31, 3))), "일 19:30", "Sunlit during Cobblemon's rest");
  assert.equal(formatOpenTime(nextCloseAt(cob, kst(2026, 10, 31, 12))), "일 02:00");
  pass("standard-hours-tile-the-week");

  // 17. Applying and clearing are pure and repeatable; unknown units are left alone.
  const before = { stateDir, servers: [
    { unit: "bweeep-cobblemon-fabric", listen: 25565, backend: 35565 },
    { unit: "bweeep-society-server", listen: 31234, backend: 41234, schedule: { open: [{ from: "mon 00:00", to: "tue 00:00" }] } },
    { unit: "bweeep-other", listen: 1, backend: 2 }
  ] };
  const applied = withStandardHours(before);
  assert.deepEqual(applied.changed, ["bweeep-cobblemon-fabric", "bweeep-society-server"]);
  assert.equal(applied.config.servers[2].schedule, undefined);
  assert.equal(before.servers[0].schedule, undefined, "the input is not changed");
  assert.deepEqual(withStandardHours(applied.config).changed, [], "applying twice changes nothing");
  assert.deepEqual(withoutHours(applied.config).changed, ["bweeep-cobblemon-fabric", "bweeep-society-server"]);
  assert.deepEqual(withoutHours(withoutHours(applied.config).config).changed, []);
  assert.match(describeHours(applied.config, kst(2026, 10, 20, 12)).join("\n"), /bweeep-cobblemon-fabric: 2026-10-23 전이라 항상 열림/);
  assert.match(describeHours(applied.config, kst(2026, 10, 24, 12)).join("\n"), /bweeep-cobblemon-fabric: 지금 열림 · 일 02:00에 닫힘/);
  assert.match(describeHours(applied.config, kst(2026, 10, 27, 12)).join("\n"), /bweeep-society-server: 지금 열림 · 금 17:00에 닫힘/);
  assert.match(describeHours(applied.config, kst(2026, 10, 27, 12)).join("\n"), /bweeep-cobblemon-fabric: 지금 닫힘 · 금 17:00에 열림/);
  assert.match(describeHours(applied.config, kst(2026, 10, 27, 12)).join("\n"), /bweeep-other: 시간표 없음/);
  pass("apply-and-clear-are-pure");

  // 18. The command line: nothing changes without --write; --write backs up and keeps the file private.
  const toolDir = fs.mkdtempSync(path.join(os.tmpdir(), "bweeep-gate-tool-"));
  const toolConfig = path.join(toolDir, "bweeep-cobblemon-fabric.json");
  const toolState = path.join(toolDir, "state");
  fs.writeFileSync(toolConfig, JSON.stringify({ stateDir: toolState, servers: [{ unit: "bweeep-cobblemon-fabric", listen: await freePort(), backend: await freePort(), rcon: { port: await freePort(), password: "long-enough-password" } }] }, null, 2), { mode: 0o600 });
  const tool = (...args) => execFileSync(process.execPath, [path.join(import.meta.dirname, "gate-schedule.mjs"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const original = fs.readFileSync(toolConfig, "utf8");
  assert.match(tool("show", "--config", toolConfig), /시간표 없음/);
  assert.match(tool("apply", "--config", toolConfig), /미리보기/);
  assert.equal(fs.readFileSync(toolConfig, "utf8"), original, "apply without --write changes nothing");
  assert.match(tool("apply", "--config", toolConfig, "--write"), /백업/);
  const written = JSON.parse(fs.readFileSync(toolConfig, "utf8"));
  assert.deepEqual(written.servers[0].schedule, { startsOn: START, open: STANDARD_HOURS["bweeep-cobblemon-fabric"] });
  assert.equal(written.servers[0].rcon.password, "long-enough-password", "other settings are kept");
  assert.equal(fs.statSync(toolConfig).mode & 0o777, 0o600, "gate.json stays private");
  assert.equal(fs.readdirSync(toolDir).filter((name) => name.includes(".bak-")).length, 1, "one backup");
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-27T10:00+09:00"), /지금 닫힘 · 금 17:00에 열림/);
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-24T10:00+09:00"), /지금 열림 · 일 02:00에 닫힘/);
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-31T03:00+09:00"), /지금 닫힘 · 토 07:00에 열림/);
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-10T10:00+09:00"), /전이라 항상 열림/);
  // `show` says what a gate would do on reading the hours: nothing for a stopped server, a warned stop for a running one.
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-27T10:00+09:00"), /bweeep-cobblemon-fabric: 서버가 꺼져 있어 아무것도 하지 않음/);
  const runningBackend = fakeBackend(written.servers[0].backend);
  await runningBackend.listen();
  const forecastRun = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(import.meta.dirname, "gate-schedule.mjs"), "show", "--config", toolConfig, "--at", "2026-10-27T10:00+09:00"], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  assert.match(forecastRun, /서버가 켜져 있어 경고 후 끕니다\(일 19:30에 닫혔어야 함\)/);
  const forecastOpen = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(import.meta.dirname, "gate-schedule.mjs"), "show", "--config", toolConfig, "--at", "2026-10-30T17:00:30+09:00"], { encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  assert.match(forecastOpen, /이미 켜져 있음/);
  await runningBackend.close();
  // Opening by hand and ending it.
  tool("open", "--config", toolConfig, "--hours", "2", "--write");
  const handFile = path.join(toolState, "bweeep-cobblemon-fabric.open-until");
  assert.ok(Date.parse(fs.readFileSync(handFile, "utf8").trim()) > Date.now() + 3_000_000);
  assert.match(tool("show", "--config", toolConfig, "--at", "2026-10-27T10:00+09:00"), /손으로 열어 둔/);
  tool("close-by-hand", "--config", toolConfig, "--write");
  assert.equal(fs.existsSync(handFile), false);
  assert.throws(() => tool("open", "--config", toolConfig, "--hours", "0"), /hours/);
  // install is a preview unless --write; the gate dir here has no copy yet, and nobody is on the (absent) server.
  const preview = tool("install", "--config", toolConfig);
  assert.match(preview, /교체/);
  assert.equal(fs.existsSync(path.join(toolDir, "server-gate.mjs")), false, "install without --write copies nothing");
  tool("clear", "--config", toolConfig, "--write");
  assert.equal(JSON.parse(fs.readFileSync(toolConfig, "utf8")).servers[0].schedule, undefined);
  pass("gate-schedule-tool");

  // 19. A real gate process: it records its code hash, reports closed, and a SIGHUP opens it again without a restart.
  {
    // A one-minute window three days from now, so it is closed whenever this runs.
    const later = Date.now() + 3 * 86_400_000;
    const day = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][(Math.floor((later + 9 * 3_600_000) / 86_400_000) + 3) % 7];
    const closedNow = { open: [{ from: `${day} 03:00`, to: `${day} 03:01` }] };
    const listenPort = await freePort();
    const processConfig = path.join(toolDir, "bweeep-e2e-hours.json");
    const write = (schedule) => fs.writeFileSync(processConfig, JSON.stringify({
      stateDir: path.join(toolDir, "state2"),
      servers: [{ unit: "bweeep-e2e-hours", name: "e2e", listen: listenPort, backend: 1, ...(schedule ? { schedule } : {}) }]
    }));
    write(closedNow);
    const child = spawn(process.execPath, [path.join(import.meta.dirname, "server-gate.mjs"), "--config", processConfig], { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(String(chunk)));
    child.stderr.on("data", (chunk) => output.push(String(chunk)));
    try {
      await until(() => output.join("").includes("listening on"), "the gate process listens");
      // The gate logs that it listens first and writes the code record right after; wait for the file.
      const codeFile = path.join(toolDir, "state2", "bweeep-e2e-hours.gate-code");
      await until(() => fs.existsSync(codeFile), "the gate records its code");
      assert.equal(fs.readFileSync(codeFile, "utf8").trim(), gateCodeHash(), "it records the code it runs");
      let status = await statusPing(listenPort);
      assert.equal(status.bweeep.gate, "closed");
      assert.ok(status.bweeep.nextOpen > Date.now());
      const connection = joinClient(listenPort, "seos_py");
      await until(() => connection.closed, "turned away");
      assert.match(connection.disconnect, /열려 있지 않아요/);
      write(null);
      child.kill("SIGHUP");
      await until(() => output.join("").includes("opening hours removed"), "hours reloaded");
      status = await statusPing(listenPort);
      assert.equal(status.bweeep.gate, "sleeping", "open again after SIGHUP, same process");
      assert.equal(child.exitCode, null, "the gate was not restarted");
      write({ open: [] });
      child.kill("SIGHUP");
      await until(() => output.join("").includes("reload refused"), "bad file refused");
      assert.equal((await statusPing(listenPort)).bweeep.gate, "sleeping", "a bad file changes nothing");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    pass("real-gate-process-sighup");
  }
  fs.rmSync(toolDir, { recursive: true, force: true });
}

fs.rmSync(stateDir, { recursive: true, force: true });
console.log("server schedule: all checks passed");
