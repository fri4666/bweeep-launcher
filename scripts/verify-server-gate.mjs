// The server gate with fake game servers and a fake systemd: status while
// sleeping, waking from a launcher ping and from a join, holding a join until
// the server is up (the server sees only the client's own packets), stopping
// an empty server, and the "off" switch.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ServerGate, WAKE_MARKER, encodeHandshake, encodePacket, readConfig, readFrame, readVarInt
} from "./server-gate.mjs";
import { fakeBackend, fakeControl, freePort, joinClient, sleep, statusPing, until } from "./lib/gate-test-kit.mjs";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bweeep-gate-"));

const listen = await freePort();
const backendPort = await freePort();
const backend = fakeBackend(backendPort);
const control = fakeControl(backend, 600);
const lines = [];
const gate = new ServerGate(
  { name: "테스트", unit: "bweeep-fake", listen, backend: backendPort },
  { stateDir, control, log: (line) => lines.push(line), timing: { holdPingMs: 150, fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 300, idleMs: 400 } }
);
let step = 0;
const pass = (name) => console.log(`ok ${++step} ${name}`);

try {
  // 1. Stopped server, no cache yet: a sleeping status, no start.
  await gate.listen();
  assert.equal(gate.state, "down");
  let status = await statusPing(listen);
  assert.deepEqual(status.bweeep, { gate: "sleeping" });
  assert.equal(status.players.online, 0);
  assert.equal(control.calls.length, 0, "a plain status ping never wakes the server");
  pass("sleeping-status-without-wake");

  // The complete normal exchange may be pipelined or fragmented at any byte.
  const ping = Buffer.alloc(8);
  ping.writeBigInt64BE(42n);
  const exchange = Buffer.concat([
    encodeHandshake({ protocol: -1, host: "127.0.0.1", port: listen, nextState: 1 }),
    encodePacket(0), encodePacket(1, ping)
  ]);
  for (const chunks of [[exchange], [...exchange].map((byte) => Buffer.from([byte]))]) {
    const received = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port: listen });
      const data = [];
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("fragmented status timed out")); }, 3_000);
      socket.on("data", (chunk) => data.push(chunk));
      socket.on("error", reject);
      socket.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(data)); });
      socket.on("connect", async () => {
        for (const chunk of chunks) { socket.write(chunk); if (chunks.length > 1) await sleep(2); }
      });
    });
    const response = readFrame(received, 1 << 20);
    assert.equal(response.payload[0], 0);
    assert.deepEqual(readFrame(response.rest, 9).payload, Buffer.concat([Buffer.from([1]), ping]));
  }
  pass("status-fragmentation-and-pipelining");

  // A peer that never reads must cause at most one JSON allocation/write,
  // including when every write reports backpressure.
  class SlowStatusSocket extends EventEmitter {
    writes = [];
    ended = 0;
    destroyed = false;
    write(packet) { this.writes.push(packet.length); return false; }
    end(packet) { this.writes.push(packet.length); this.ended++; this.emit("close"); }
    destroy() { this.destroyed = true; this.emit("close"); }
  }
  let serializations = 0;
  const statusOnly = { statusJson: () => { serializations++; return JSON.stringify({ description: "x".repeat(32 * 1024) }); } };
  const flood = new SlowStatusSocket();
  ServerGate.prototype.answerStatus.call(statusOnly, flood, {}, Buffer.concat(Array.from({ length: 64 }, () => encodePacket(0))), "sleeping");
  assert.equal(serializations, 1);
  assert.equal(flood.writes.length, 1, "write(false) cannot accumulate repeated status responses");
  assert.equal(flood.destroyed, true);
  const afterPong = new SlowStatusSocket();
  ServerGate.prototype.answerStatus.call(statusOnly, afterPong, {}, Buffer.concat([encodePacket(0), encodePacket(1, ping)]), "sleeping");
  afterPong.emit("data", encodePacket(0));
  assert.equal(afterPong.ended, 1);
  assert.equal(afterPong.writes.length, 2, "no writes after the pong ends the exchange");
  for (const invalid of [
    encodePacket(1, ping), encodePacket(0, Buffer.from([0])),
    Buffer.from([2, 0x80, 0]), encodePacket(2),
    Buffer.concat([encodePacket(0), encodePacket(1)]),
    Buffer.concat([encodePacket(0), encodePacket(1, Buffer.alloc(9))])
  ]) {
    const socket = new SlowStatusSocket();
    ServerGate.prototype.answerStatus.call(statusOnly, socket, {}, invalid, "sleeping");
    assert.equal(socket.destroyed, true, `invalid status payload ${invalid.toString("hex")}`);
    assert.equal(socket.ended, 0);
  }
  pass("status-request-amplification-and-invalid-payloads");

  // 2. The launcher's marked ping wakes it; the server comes up and later pings pass through.
  status = await statusPing(listen, `play.example${WAKE_MARKER}`);
  assert.deepEqual(control.calls, ["start bweeep-fake"]);
  assert.ok(["starting", "sleeping"].includes(status.bweeep.gate));
  await until(() => gate.state === "up", "server up");
  status = await statusPing(listen);
  assert.equal(status.description.text, "real");
  assert.equal(status.bweeep, undefined, "a running server's own status is passed through");
  pass("launcher-wake-then-pass-through");

  // 3. Empty for idleMs: stopped, and the sleeping status keeps the real server's version and size.
  await until(() => gate.state === "down", "idle stop");
  assert.deepEqual(control.calls, ["start bweeep-fake", "stop bweeep-fake"]);
  status = await statusPing(listen);
  assert.deepEqual(status.bweeep, { gate: "sleeping" });
  assert.equal(status.version.name, "26.3");
  assert.equal(status.players.max, 12);
  pass("idle-stop-keeps-cached-status");

  // 4. A join to the sleeping server wakes it, is held with login queries, then handed over untouched.
  const player = joinClient(listen, "seos_py");
  await until(() => backend.joins.length === 1, "held join handed over", 5_000);
  await until(() => player.welcome, "server reply reaches the client");
  assert.ok(player.queries >= 2, `the held client got wait queries (${player.queries})`);
  const join = backend.joins[0];
  assert.equal(join.handshake.host, "play.example");
  assert.equal(join.frames.length, 1, "the server sees only the login start, not the query answers");
  assert.equal(readVarInt(join.frames[0]).value, 0x00);
  assert.equal(control.calls.filter((call) => call.startsWith("start")).length, 2);
  pass("join-held-until-up-then-handed-over");

  // 5. While someone is on, it stays up past idleMs; after they leave it stops.
  await sleep(700);
  assert.equal(gate.state, "up", "not stopped with a player on");
  player.socket.destroy();
  await until(() => gate.state === "down", "stop after the player left");
  pass("stays-up-while-played-stops-after");

  // 6. Players the gate does not know about (status count) also keep it up.
  await statusPing(listen, `x${WAKE_MARKER}`);
  await until(() => gate.state === "up", "up again");
  backend.setPlayers(1);
  await sleep(700);
  assert.equal(gate.state, "up", "status says someone is on");
  backend.setPlayers(0);
  await until(() => gate.state === "down", "stop when status count is 0");
  pass("status-player-count-blocks-stop");

  // 7. Off switch: joins refused with a message, status says off, nothing started.
  fs.writeFileSync(path.join(stateDir, "bweeep-fake.off"), "");
  const before = control.calls.length;
  status = await statusPing(listen, `x${WAKE_MARKER}`);
  assert.deepEqual(status.bweeep, { gate: "off" });
  const refused = joinClient(listen, "seos_py");
  await until(() => refused.closed, "refused join closed");
  assert.equal(refused.disconnect, "서버가 꺼져 있어요");
  assert.equal(control.calls.length, before);
  fs.rmSync(path.join(stateDir, "bweeep-fake.off"));
  pass("off-switch-refuses");

  // 8. The server dies before it answers: the held join gets a message instead of hanging.
  const deadBackendControl = {
    start: async () => ({ ok: true }), stop: async () => ({ ok: true }), isActive: async () => false
  };
  const listen2 = await freePort();
  const gate2 = new ServerGate(
    { name: "죽는 서버", unit: "bweeep-dead", listen: listen2, backend: await freePort() },
    { stateDir, control: deadBackendControl, log: () => undefined, timing: { holdPingMs: 150, fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 200, startTimeoutMs: 100_000 } }
  );
  await gate2.listen();
  const stuck = joinClient(listen2, "seos_py");
  await until(() => stuck.closed, "failed start ends the join", 8_000);
  assert.match(stuck.disconnect ?? "", /켜지 못했어요/);
  await gate2.close();
  pass("failed-start-tells-the-player");

  // 9. With RCON the idle stop is the console "stop" first (it saves the world), systemd after;
  //    when RCON does not answer, systemd alone.
  for (const rconWorks of [true, false]) {
    const order = [];
    let active = true;
    const backend3 = fakeBackend(await freePort());
    await backend3.listen();
    const gate3 = new ServerGate(
      { name: "rcon", unit: "bweeep-rcon", listen: await freePort(), backend: 0, rcon: { port: 1, password: "secret-password" } },
      {
        stateDir, log: () => undefined,
        control: {
          start: async () => ({ ok: true }),
          stop: async () => { order.push(`systemd stop (active ${active})`); await backend3.close(); active = false; return { ok: true }; },
          isActive: async () => active
        },
        rcon: async (_port, password, command) => {
          order.push(`rcon ${command}`);
          assert.equal(password, "secret-password");
          if (!rconWorks) return null;
          await backend3.close();
          active = false;
          return "Stopping the server";
        },
        timing: { fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 300, idleMs: 300 }
      }
    );
    gate3.entry.backend = backend3.port;
    await gate3.listen();
    await until(() => gate3.state === "down", "rcon idle stop");
    assert.deepEqual(order, rconWorks ? ["rcon stop", "systemd stop (active false)"] : ["rcon stop", "systemd stop (active true)"]);
    await gate3.close();
  }
  // The RCON client against a fake console: login, a command, a wrong password.
  {
    const rconPort = await freePort();
    const console_ = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
          const length = buffer.readInt32LE(0);
          const id = buffer.readInt32LE(4);
          const type = buffer.readInt32LE(8);
          const body = buffer.subarray(12, 4 + length - 2).toString("utf8");
          buffer = buffer.subarray(4 + length);
          const reply = (replyId, text) => {
            const bytes = Buffer.from(text);
            const out = Buffer.alloc(14 + bytes.length);
            out.writeInt32LE(10 + bytes.length, 0);
            out.writeInt32LE(replyId, 4);
            out.writeInt32LE(type === 3 ? 2 : 0, 8);
            bytes.copy(out, 12);
            socket.write(out);
          };
          if (type === 3) reply(body === "right-password" ? id : -1, "");
          else reply(id, `ran ${body}`);
        }
      });
    });
    await new Promise((resolve) => console_.listen(rconPort, "127.0.0.1", resolve));
    const { rconCommand } = await import("./server-gate.mjs");
    assert.equal(await rconCommand(rconPort, "right-password", "list"), "ran list");
    assert.equal(await rconCommand(rconPort, "wrong-password", "list"), null);
    assert.equal(await rconCommand(1, "right-password", "list"), null, "nothing listening");
    await new Promise((resolve) => console_.close(resolve));
  }
  pass("rcon-stop-then-systemd");

  // 10. A server that crashed and got stuck on the way out: its port is closed but systemd still
  //     counts the unit as running. Status says "starting", a join waits, and after hungRefusedMs
  //     the unit is stopped and started again and the join is handed over.
  const hungTiming = { holdPingMs: 150, fastProbeMs: 50, slowProbeMs: 100, probeTimeoutMs: 300, idleMs: 60_000 };
  {
    const backend4 = fakeBackend(await freePort());
    const control4 = fakeControl(backend4, 300);
    await backend4.listen();
    control4.setActive(true);
    const listen4 = await freePort();
    const gate4 = new ServerGate(
      { name: "먹통", unit: "bweeep-hung", listen: listen4, backend: backend4.port },
      { stateDir, control: control4, log: (line) => lines.push(line), timing: { ...hungTiming, hungRefusedMs: 1_000, hungSilentMs: 60_000 } }
    );
    await gate4.listen();
    assert.equal(gate4.state, "up");
    await backend4.close();
    const crashedAt = Date.now();
    const waiting = joinClient(listen4, "seos_py");
    await until(() => gate4.unanswered, "the gate notices the closed port");
    status = await statusPing(listen4);
    assert.deepEqual(status.bweeep, { gate: "starting" });
    await until(() => control4.calls.length > 0, "restart of the stuck server");
    assert.ok(Date.now() - crashedAt >= 900, "not before hungRefusedMs");
    await until(() => waiting.welcome, "the waiting join reaches the restarted server");
    assert.deepEqual(control4.calls, ["stop bweeep-hung", "start bweeep-hung"]);
    assert.equal(gate4.state, "up");
    assert.equal(backend4.joins.at(-1).frames.length, 1, "the server sees only the login start");
    waiting.socket.destroy();

    // Switched off from the desktop: a closed port is left alone and joins are refused.
    fs.writeFileSync(path.join(stateDir, "bweeep-hung.off"), "");
    await backend4.close();
    await until(() => gate4.unanswered, "the gate notices the closed port again");
    const refusedWhileOff = joinClient(listen4, "seos_py");
    await until(() => refusedWhileOff.closed, "join refused while off");
    await sleep(1_300);
    assert.equal(control4.calls.length, 2, "no restart while switched off");
    fs.rmSync(path.join(stateDir, "bweeep-hung.off"));

    // Stopped from outside (the unit is no longer running): asleep, not restarted.
    control4.setActive(false);
    await until(() => gate4.state === "down", "down after an outside stop");
    assert.equal(control4.calls.length, 2);
    await gate4.close();
  }
  pass("stuck-after-crash-is-restarted");

  // 11. A server that accepts connections but answers nothing gets the longer hungSilentMs.
  {
    const backend5 = fakeBackend(await freePort());
    const control5 = fakeControl(backend5, 100);
    await backend5.listen();
    control5.setActive(true);
    const gate5 = new ServerGate(
      { name: "조용", unit: "bweeep-silent", listen: await freePort(), backend: backend5.port },
      { stateDir, control: control5, log: (line) => lines.push(line), timing: { ...hungTiming, probeTimeoutMs: 100, hungRefusedMs: 100, hungSilentMs: 1_200 } }
    );
    await gate5.listen();
    backend5.setSilent(true);
    const silentAt = Date.now();
    await until(() => control5.calls.length > 0, "restart of the silent server");
    assert.ok(Date.now() - silentAt >= 1_100, "silence waits for hungSilentMs, not hungRefusedMs");
    backend5.setSilent(false);
    await until(() => gate5.state === "up" && control5.calls.length === 2, "silent server back up");
    assert.deepEqual(control5.calls, ["stop bweeep-silent", "start bweeep-silent"]);
    await gate5.close();
    await backend5.close();
  }
  pass("silent-server-waits-longer");

  // 12. Config checks.
  const configFile = path.join(stateDir, "gate.json");
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, servers: [{ unit: "a", listen: 1, backend: 1 }] }));
  assert.throws(() => readConfig(configFile), /두 번/);
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, servers: [{ unit: "a b", listen: 1, backend: 2 }] }));
  assert.throws(() => readConfig(configFile), /unit/);
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, servers: [{ unit: "bweeep-x", listen: 25565, backend: 35565, idleMinutes: 10 }] }));
  assert.equal(readConfig(configFile).servers.length, 1);
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, servers: [{ unit: "bweeep-x", listen: 25565, backend: 35565, rcon: { port: 35565, password: "long-enough" } }] }));
  assert.throws(() => readConfig(configFile), /rcon 포트/);
  fs.writeFileSync(configFile, JSON.stringify({ stateDir, servers: [{ unit: "bweeep-x", listen: 25565, backend: 35565, rcon: { port: 35566, password: "short" } }] }));
  assert.throws(() => readConfig(configFile), /rcon 비밀번호/);
  pass("config-checks");
} catch (error) {
  console.error(lines.join("\n"));
  throw error;
} finally {
  await gate.close();
  await backend.close().catch(() => undefined);
  fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log("server gate: all checks passed");
