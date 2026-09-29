// The server gate with fake game servers and a fake systemd: status while
// sleeping, waking from a launcher ping and from a join, holding a join until
// the server is up (the server sees only the client's own packets), stopping
// an empty server, and the "off" switch.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  ServerGate, WAKE_MARKER, encodeHandshake, encodePacket, encodeVarInt, parseHandshake, readConfig, readFrame, readVarInt
} from "./server-gate.mjs";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bweeep-gate-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
async function until(check, what, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const string = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
};

/** A fake Minecraft server: answers status, records what joins send, echoes after login. */
function fakeBackend(port, { players = 0 } = {}) {
  const joins = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshake = null;
    const join = { frames: [], socket };
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const read = readFrame(buffer, 1 << 20);
        if (!read) return;
        buffer = read.rest;
        if (!handshake) {
          handshake = parseHandshake(read.payload);
          if (handshake.nextState === 2) {
            joins.push(join);
            join.handshake = handshake;
          }
          continue;
        }
        if (handshake.nextState === 1) {
          const id = readVarInt(read.payload).value;
          if (id === 0) socket.write(encodePacket(0, string(JSON.stringify({ version: { name: "26.3", protocol: 999 }, players: { max: 12, online: players }, description: { text: "real" } }))));
          else socket.end(encodePacket(1, read.payload.subarray(1)));
        } else {
          join.frames.push(Buffer.from(read.payload));
          socket.write(encodePacket(0x02, Buffer.from("welcome")));
        }
      }
    });
  });
  return {
    joins,
    listen: () => new Promise((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => new Promise((resolve) => {
      for (const join of joins) join.socket.destroy();
      server.close(() => resolve());
    }),
    setPlayers: (count) => { players = count; },
    port
  };
}

/** Fake systemd: start brings the fake server up after `startDelayMs`, stop takes it down. */
function fakeControl(backend, startDelayMs) {
  const calls = [];
  let active = false;
  return {
    calls,
    setActive: (value) => { active = value; },
    start: async (unit) => {
      calls.push(`start ${unit}`);
      active = true;
      setTimeout(() => void backend.listen(), startDelayMs);
      return { ok: true };
    },
    stop: async (unit) => {
      calls.push(`stop ${unit}`);
      await backend.close();
      active = false;
      return { ok: true };
    },
    isActive: async () => active
  };
}

function statusPing(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let status = null;
    socket.on("connect", () => {
      socket.write(Buffer.concat([encodeHandshake({ protocol: -1, host, port, nextState: 1 }), encodePacket(0)]));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const read = readFrame(buffer, 1 << 20);
        if (!read) return;
        buffer = read.rest;
        const id = readVarInt(read.payload);
        if (id.value === 0) {
          const text = readVarInt(read.payload, id.size);
          status = JSON.parse(read.payload.subarray(id.size + text.size).toString("utf8"));
          const ping = Buffer.alloc(8);
          ping.writeBigInt64BE(42n);
          socket.write(encodePacket(1, ping));
        } else if (id.value === 1) {
          assert.equal(read.payload.readBigInt64BE(1), 42n, "pong echoes the ping");
          socket.destroy();
          resolve(status);
        }
      }
    });
    socket.on("error", reject);
    setTimeout(() => reject(new Error("status ping timed out")), 3_000);
  });
}

/** A client that joins, answers every login query with "not understood" like the game, and records what it gets. */
function joinClient(port, name) {
  const socket = net.connect({ host: "127.0.0.1", port });
  const got = { queries: 0, disconnect: null, welcome: false, closed: false, socket };
  let buffer = Buffer.alloc(0);
  socket.on("connect", () => {
    socket.write(Buffer.concat([encodeHandshake({ protocol: 999, host: "play.example", port, nextState: 2 }), encodePacket(0x00, string(name))]));
  });
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const read = readFrame(buffer, 1 << 20);
      if (!read) return;
      buffer = read.rest;
      const id = readVarInt(read.payload);
      if (id.value === 0x04) {
        got.queries += 1;
        const message = readVarInt(read.payload, id.size);
        const channel = readVarInt(read.payload, id.size + message.size);
        const channelName = read.payload.subarray(id.size + message.size + channel.size, id.size + message.size + channel.size + channel.value).toString("utf8");
        assert.equal(channelName, "bweeep:wait");
        socket.write(encodePacket(0x02, Buffer.concat([encodeVarInt(message.value), Buffer.from([0])])));
      } else if (id.value === 0x00) {
        const text = readVarInt(read.payload, id.size);
        got.disconnect = JSON.parse(read.payload.subarray(id.size + text.size).toString("utf8")).text;
      } else if (id.value === 0x02 && read.payload.subarray(id.size).toString() === "welcome") {
        got.welcome = true;
      }
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => { got.closed = true; });
  return got;
}

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

  // 10. Config checks.
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
