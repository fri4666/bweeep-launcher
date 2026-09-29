import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { checkServer, encodeVarInt, readVarInt, wakeServer } from "../dist/src/main/server-status.js";

// VarInt framing, including the 5-byte negative protocol number.
for (const value of [0, 1, 127, 128, 255, 25565, 2097151, 2147483647, -1]) {
  const encoded = encodeVarInt(value);
  assert.deepEqual(readVarInt(encoded), { value, size: encoded.length }, `VarInt ${value}`);
}
assert.deepEqual([...encodeVarInt(-1)], [0xff, 0xff, 0xff, 0xff, 0x0f]);
assert.equal(readVarInt(Buffer.from([0x80, 0x80])), null, "a VarInt cut off mid-way needs more bytes");
assert.throws(() => readVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), /too long/);

const offline = await checkServer({ host: "127.0.0.1", port: 1 });
assert.equal(offline.online, false);
assert.equal(offline.message, "연결 끊김");
assert.equal(offline.latencyMs, undefined);

function packet(id, body) {
  const payload = Buffer.concat([encodeVarInt(id), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function statusReply(json) {
  const text = Buffer.from(typeof json === "string" ? json : JSON.stringify(json), "utf8");
  return packet(0x00, Buffer.concat([encodeVarInt(text.length), text]));
}

/** A fake server; `reply(socket, handshake)` answers once the handshake and status request arrive. */
async function fakeServer(reply) {
  const seen = { connections: 0, handshakes: [] };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (answered) return;
      const length = readVarInt(buffer);
      if (!length || buffer.length < length.size + length.value) return;
      const body = buffer.subarray(length.size, length.size + length.value);
      let offset = 0;
      const next = () => { const read = readVarInt(body, offset); offset += read.size; return read.value; };
      const handshake = { packetId: next(), protocol: next() };
      const hostLength = next();
      handshake.host = body.subarray(offset, offset + hostLength).toString("utf8");
      offset += hostLength;
      handshake.port = body.readUInt16BE(offset);
      offset += 2;
      handshake.nextState = next();
      const rest = buffer.subarray(length.size + length.value);
      // The status request is an empty packet with id 0.
      if (rest.length < 2) return;
      handshake.statusRequest = [...rest.subarray(0, 2)];
      seen.handshakes.push(handshake);
      answered = true;
      reply(socket, handshake);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function timed(action) {
  const startedAt = performance.now();
  const result = await action();
  return { result, ms: performance.now() - startedAt };
}

// A normal reply, split across writes: players, version (colour codes dropped) and latency.
{
  const server = await fakeServer((socket) => {
    const reply = statusReply({
      version: { name: "§a1.20.1 Forge", protocol: 763 },
      players: { online: 3, max: 20, sample: [] },
      description: { text: "hi" },
      forgeData: { d: "x".repeat(40_000) }
    });
    socket.write(reply.subarray(0, 3));
    setTimeout(() => socket.end(reply.subarray(3)), 30);
  });
  const status = await checkServer({ host: "127.0.0.1", port: server.port }, { timeoutMs: 2000 });
  assert.equal(status.online, true);
  assert.deepEqual(status.players, { online: 3, max: 20 });
  assert.equal(status.version, "1.20.1 Forge");
  assert.equal(typeof status.latencyMs, "number");
  const [handshake] = server.seen.handshakes;
  assert.deepEqual(handshake, { packetId: 0, protocol: -1, host: "127.0.0.1", port: server.port, nextState: 1, statusRequest: [1, 0] });
  await server.close();
}

// Silent after connecting: the deadline falls back to "the port is open".
{
  const server = await fakeServer(() => undefined);
  const { result, ms } = await timed(() => checkServer({ host: "127.0.0.1", port: server.port }, { timeoutMs: 300 }));
  assert.equal(result.online, true);
  assert.equal(result.players, undefined);
  assert.ok(ms >= 280 && ms < 1500, `timeout took ${ms}ms`);
  await server.close();
}

// Replies that are not a status response fall back to TCP at once, without waiting for the deadline.
for (const [name, bytes] of [
  ["http text", Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n")],
  ["oversized length", Buffer.concat([encodeVarInt(10 * 1024 * 1024), Buffer.from([0x00])])],
  ["wrong packet id", packet(0x05, Buffer.from([0x00]))],
  ["broken json", statusReply("{\"players\":")],
  ["json array", statusReply("[1,2]")],
  ["cut-off text", packet(0x00, Buffer.concat([encodeVarInt(500), Buffer.from("{}")]))]
]) {
  const server = await fakeServer((socket) => socket.write(bytes));
  const { result, ms } = await timed(() => checkServer({ host: "127.0.0.1", port: server.port }, { timeoutMs: 3000, maxResponseBytes: 64 * 1024 }));
  assert.equal(result.online, true, name);
  assert.equal(result.players, undefined, name);
  assert.ok(ms < 1500, `${name} waited ${ms}ms`);
  await server.close();
}

// A reply over the size limit is refused even when it is well formed.
{
  const server = await fakeServer((socket) => socket.end(statusReply({ players: { online: 1, max: 5 }, pad: "x".repeat(5000) })));
  const status = await checkServer({ host: "127.0.0.1", port: server.port }, { maxResponseBytes: 1024 });
  assert.equal(status.online, true);
  assert.equal(status.players, undefined);
  await server.close();
}

// Bad counts are dropped, the version is kept.
{
  const server = await fakeServer((socket) => socket.end(statusReply({ version: { name: "26.3" }, players: { online: -1, max: "20" } })));
  const status = await checkServer({ host: "127.0.0.1", port: server.port });
  assert.equal(status.players, undefined);
  assert.equal(status.version, "26.3");
  await server.close();
}

// Checks of the same server at the same time share one connection.
{
  const server = await fakeServer((socket) => setTimeout(() => socket.end(statusReply({ players: { online: 0, max: 10 } })), 100));
  const statuses = await Promise.all([1, 2, 3].map(() => checkServer({ host: "127.0.0.1", port: server.port })));
  assert.equal(server.seen.connections, 1);
  assert.ok(statuses.every((status) => status.players?.max === 10));
  await checkServer({ host: "127.0.0.1", port: server.port });
  assert.equal(server.seen.connections, 2, "a later check opens a new connection");
  await server.close();
}

// The server gate's states: sleeping and starting count as reachable, off does not.
for (const [gate, online, sleep] of [["sleeping", true, "sleeping"], ["starting", true, "starting"], ["off", false, undefined], ["weird", true, undefined]]) {
  const server = await fakeServer((socket) => socket.end(statusReply({ version: { name: "26.3" }, players: { online: 0, max: 10 }, bweeep: { gate } })));
  const status = await checkServer({ host: "127.0.0.1", port: server.port });
  assert.equal(status.online, online, gate);
  assert.equal(status.sleep, sleep, gate);
  await server.close();
}

// Play wakes a sleeping server through the real gate; a plain check never does.
{
  const { ServerGate } = await import("./server-gate.mjs");
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const starts = [];
  const gate = new ServerGate({ name: "t", unit: "bweeep-t", listen: port, backend: 1 }, {
    stateDir: path.join(os.tmpdir(), `bweeep-status-gate-${process.pid}`),
    control: { start: async (unit) => { starts.push(unit); return { ok: true }; }, stop: async () => ({ ok: true }), isActive: async () => false },
    log: () => undefined,
    timing: { slowProbeMs: 60_000, fastProbeMs: 60_000, probeTimeoutMs: 100 }
  });
  await gate.listen();
  const plain = await checkServer({ host: "127.0.0.1", port });
  assert.equal(plain.sleep, "sleeping");
  assert.equal(starts.length, 0, "a status check leaves it asleep");
  const woken = await wakeServer({ host: "127.0.0.1", port });
  assert.equal(woken.online, true);
  assert.deepEqual(starts, ["bweeep-t"], "Play starts it");
  await gate.close();
}

console.log("server-status-regression=passed");
