// Fake game servers, a fake systemd and Minecraft clients for the server gate's
// verify scripts (verify-server-gate.mjs, verify-server-schedule.mjs).
import assert from "node:assert/strict";
import net from "node:net";
import {
  encodeHandshake, encodePacket, encodeVarInt, parseHandshake, readFrame, readVarInt
} from "../server-gate.mjs";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

export async function until(check, what, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const string = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
};

/** A fake Minecraft server: answers status, records what joins send, echoes after login. */
export function fakeBackend(port, { players = 0 } = {}) {
  const joins = [];
  let silent = false;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshake = null;
    const join = { frames: [], socket };
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (silent) return;
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
    /** Keeps accepting connections but answers nothing, like a server that hangs. */
    setSilent: (value) => { silent = value; },
    port
  };
}

/** Fake systemd: start brings the fake server up after `startDelayMs`, stop takes it down. */
export function fakeControl(backend, startDelayMs) {
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

export function statusPing(port, host = "127.0.0.1") {
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
export function joinClient(port, name) {
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
