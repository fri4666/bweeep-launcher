// Opening hours of the server gate: the window logic (Korean time, boundaries,
// week wrap, startsOn), the strict config check, and the gate with a fake
// clock: a stopped server outside its hours is not started and joins are
// turned away with the next opening time, a running server is never touched,
// an admin can open it by hand, and new hours load without cutting anyone off.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ServerGate, WAKE_MARKER, formatOpenTime, isOpenAt, nextCloseAt, nextOpenAt, parseSchedule, readConfig, reloadSchedules
} from "./server-gate.mjs";
import { fakeBackend, fakeControl, freePort, joinClient, sleep, statusPing, until } from "./lib/gate-test-kit.mjs";

let step = 0;
const pass = (name) => console.log(`ok ${++step} ${name}`);
/** Epoch ms of a Korean-time wall clock. */
const kst = (year, month, day, hour = 0, minute = 0, second = 0) => Date.UTC(year, month - 1, day, hour, minute, second) - 9 * 3_600_000;

// The two real servers (2026-10-23 is a Friday).
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

const timing = { holdPingMs: 150, fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 300, idleMs: 400 };
let clock = kst(2026, 10, 26, 9); // Monday 09:00: Cobblemon closed
const lines = [];
function makeGate(unit, { startDelayMs = 200, schedule = { startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] }, control: customControl } = {}) {
  return (async () => {
    const backend = fakeBackend(await freePort());
    const control = customControl ? customControl(backend) : fakeControl(backend, startDelayMs);
    const listen = await freePort();
    const gate = new ServerGate(
      { name: unit, unit, listen, backend: backend.port, ...(schedule ? { schedule } : {}) },
      { stateDir, control, log: (line) => lines.push(line), timing, now: () => clock }
    );
    await gate.listen();
    return { gate, backend, control, listen };
  })();
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

  // 11. Open: it starts as before. A running server is not touched when the hours end.
  {
    const { gate, backend, control, listen } = await makeGate("bweeep-running");
    clock = kst(2026, 10, 24, 15); // Saturday: open
    let status = await statusPing(listen, `x${WAKE_MARKER}`);
    assert.ok(["starting", "sleeping"].includes(status.bweeep.gate));
    await until(() => gate.state === "up", "server up inside its hours");
    assert.deepEqual(control.calls, ["start bweeep-running"]);
    const player = joinClient(listen, "seos_py");
    await until(() => player.welcome, "player is in");
    clock = kst(2026, 10, 25, 12); // the window ends while the player is on
    await sleep(900); // longer than idleMs
    assert.equal(gate.state, "up", "still up after the hours ended");
    assert.deepEqual(control.calls, ["start bweeep-running"], "no stop, no restart at closing time");
    assert.equal(player.closed, false, "the player was not disconnected");
    status = await statusPing(listen);
    assert.equal(status.bweeep, undefined, "a running server answers for itself");
    const second = joinClient(listen, "friend");
    await until(() => second.welcome, "a running server still takes joins after closing");
    second.socket.destroy();
    // Everyone leaves: the normal empty-server sleep applies, and then it stays closed.
    player.socket.destroy();
    await until(() => gate.state === "down", "normal idle sleep");
    assert.deepEqual(control.calls, ["start bweeep-running", "stop bweeep-running"]);
    status = await statusPing(listen);
    assert.equal(status.bweeep.gate, "closed");
    assert.equal(status.bweeep.nextOpen, kst(2026, 10, 30, 12));
    const refused = joinClient(listen, "seos_py");
    await until(() => refused.closed, "refused after the idle stop");
    assert.match(refused.disconnect, /금 12:00에 열려요/);
    assert.equal(control.calls.length, 2, "nothing started after closing");
    await gate.close();
    await backend.close();
    pass("running-server-is-never-touched-when-hours-end");
  }

  // 12. A join waiting for a start that began inside the hours is still handed over after they end.
  {
    clock = kst(2026, 10, 24, 15);
    const { gate, control, listen, backend } = await makeGate("bweeep-held", { startDelayMs: 500 });
    const joiner = joinClient(listen, "seos_py");
    await until(() => control.calls.length === 1, "the join started the server");
    clock = kst(2026, 10, 25, 12);
    await until(() => joiner.welcome, "the held join reaches the server", 6_000);
    assert.equal(backend.joins.length, 1);
    joiner.socket.destroy();
    await until(() => gate.state === "down", "idle stop");
    await gate.close();
    pass("held-join-survives-closing");
  }

  // 13. A join arriving while the server is stopping, after the hours ended, is refused and no restart follows.
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

  // 14. An admin opens a closed server by hand until a time; it ends by itself, and a bad file counts for nothing.
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

  // 15. New hours load from gate.json (what SIGHUP does) without cutting a connection.
  {
    clock = kst(2026, 10, 24, 15);
    const { gate, backend, listen } = await makeGate("bweeep-hours", { schedule: null });
    await statusPing(listen, `x${WAKE_MARKER}`);
    await until(() => gate.state === "up", "up without hours");
    const player = joinClient(listen, "seos_py");
    await until(() => player.welcome, "player is in");
    assert.equal(gate.isClosed(), false, "no schedule: always open");
    clock = kst(2026, 10, 27, 10); // Tuesday: closed once hours exist
    assert.equal(gate.isClosed(), false);
    writeConfig({ startsOn: START, open: [{ from: "fri 12:00", to: "sun 12:00" }] });
    const bad = [];
    assert.deepEqual(reloadSchedules(configFile, [gate], (line) => bad.push(line)), ["bweeep-hours"]);
    assert.equal(gate.isClosed(), true, "hours now apply");
    assert.equal(player.closed, false, "the connection was not touched");
    assert.equal(gate.state, "up");
    writeConfig({ open: [] });
    assert.deepEqual(reloadSchedules(configFile, [gate], (line) => bad.push(line)), [], "an invalid file changes nothing");
    assert.match(bad.join("\n"), /unchanged/);
    assert.equal(gate.isClosed(), true, "old hours kept");
    fs.writeFileSync(configFile, "{ broken");
    assert.deepEqual(reloadSchedules(configFile, [gate], () => undefined), []);
    writeConfig(undefined);
    assert.deepEqual(reloadSchedules(configFile, [gate], () => undefined), ["bweeep-hours"]);
    assert.equal(gate.isClosed(), false, "removed hours: open again");
    player.socket.destroy();
    await gate.close();
    await backend.close();
    pass("reload-hours-without-dropping-players");
  }
} catch (error) {
  console.error(lines.join("\n"));
  throw error;
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log("server schedule: all checks passed");
