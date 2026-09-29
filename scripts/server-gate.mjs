#!/usr/bin/env node
// Sits on each Minecraft server's public port so an empty server can be
// stopped to free memory and started again the moment someone wants it.
//
// - Server running: every connection is passed straight through.
// - Nobody on it for `idleMinutes`: the server's systemd unit is stopped.
// - Server stopped ("sleeping"): status pings get the last known status with
//   "bweeep": { "gate": "sleeping" }. A join, or a launcher status ping marked
//   with WAKE_MARKER (sent when Play is pressed), starts the unit. A join is
//   held on the "Logging in" screen until the server is up, then handed over,
//   so the game loads while the server starts.
// - `<stateDir>/<unit>.off` (the desktop toggle's "off"): no waking; joins
//   are refused and status says "off".
//
// Usage: node scripts/server-gate.mjs --config <gate.json>
// gate.json: { "stateDir": "...", "servers": [{ "name", "unit", "listen", "backend", "idleMinutes", "rcon": { "port", "password" } }] }
// With "rcon" the server is stopped with the console "stop" (saves the world), then systemd.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Appended to the handshake host by the launcher to ask a sleeping server to start. */
export const WAKE_MARKER = "\0bweeep-wake";
const WAIT_CHANNEL = "bweeep:wait";
// Login query ids the gate uses while holding a join; far above the ones servers use.
const WAIT_ID_BASE = 0x62770000;
const MAX_HANDSHAKE_BYTES = 2048;
const MAX_HELD_BYTES = 64 * 1024;

export const DEFAULTS = {
  idleMinutes: 10,
  // The client drops a connection that sends nothing for 30 seconds.
  holdPingMs: 8_000,
  holdMaxMs: 5 * 60_000,
  startTimeoutMs: 5 * 60_000,
  probeTimeoutMs: 2_000,
  // Faster while starting or holding a join, slower otherwise.
  fastProbeMs: 1_000,
  slowProbeMs: 15_000,
  // How long a server may take to save and exit after the RCON "stop".
  rconStopMs: 180_000
};

const TEXT = {
  off: "서버가 꺼져 있어요",
  failed: "서버를 켜지 못했어요. 잠시 뒤 다시 들어와 주세요"
};

// ---- protocol helpers

export function encodeVarInt(value) {
  const bytes = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

/** { value, size } or null when the buffer ends inside the VarInt. */
export function readVarInt(buffer, offset = 0) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset + index >= buffer.length) return null;
    const byte = buffer[offset + index];
    value |= (byte & 0x7f) << (7 * index);
    if ((byte & 0x80) === 0) return { value, size: index + 1 };
  }
  throw new Error("VarInt is too long");
}

function encodeString(text) {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

export function encodePacket(packetId, body = Buffer.alloc(0)) {
  const payload = Buffer.concat([encodeVarInt(packetId), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

/** The first complete frame in `buffer`: { frame, payload, rest }, or null for more bytes. */
export function readFrame(buffer, maxBytes) {
  const length = readVarInt(buffer);
  if (!length) return null;
  if (length.value <= 0 || length.value > maxBytes) throw new Error("frame size out of range");
  const end = length.size + length.value;
  if (buffer.length < end) return null;
  return { frame: buffer.subarray(0, end), payload: buffer.subarray(length.size, end), rest: buffer.subarray(end) };
}

export function parseHandshake(payload) {
  let offset = 0;
  const next = () => {
    const read = readVarInt(payload, offset);
    if (!read) throw new Error("handshake cut off");
    offset += read.size;
    return read.value;
  };
  if (next() !== 0x00) throw new Error("not a handshake");
  const protocol = next();
  const hostLength = next();
  if (hostLength < 0 || offset + hostLength + 2 > payload.length) throw new Error("handshake cut off");
  const host = payload.subarray(offset, offset + hostLength).toString("utf8");
  offset += hostLength;
  const port = payload.readUInt16BE(offset);
  offset += 2;
  const nextState = next();
  return { protocol, host, port, nextState };
}

export function encodeHandshake({ protocol, host, port, nextState }) {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return encodePacket(0x00, Buffer.concat([encodeVarInt(protocol), encodeString(host), portBytes, encodeVarInt(nextState)]));
}

function loginDisconnect(text) {
  return encodePacket(0x00, encodeString(JSON.stringify({ text })));
}

// ---- backend probe

/** The server's status JSON, or null when it does not answer one (stopped or still starting). */
export function probeStatus(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let received = Buffer.alloc(0);
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(Buffer.concat([encodeHandshake({ protocol: -1, host: "127.0.0.1", port, nextState: 1 }), encodePacket(0x00)]));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      try {
        const read = readFrame(received, 1024 * 1024);
        if (!read) return;
        const id = readVarInt(read.payload);
        const text = readVarInt(read.payload, id.size);
        const start = id.size + text.size;
        const status = JSON.parse(read.payload.subarray(start, start + text.value).toString("utf8"));
        done(status && typeof status === "object" && status.version ? status : null);
      } catch {
        done(null);
      }
    });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

// ---- RCON

/**
 * Runs one console command over RCON and returns the reply, or null when the
 * server cannot be reached or refuses the password.
 */
export function rconCommand(port, password, command, timeoutMs = 5_000) {
  const packet = (id, type, body) => {
    const text = Buffer.from(body, "utf8");
    const out = Buffer.alloc(14 + text.length);
    out.writeInt32LE(10 + text.length, 0);
    out.writeInt32LE(id, 4);
    out.writeInt32LE(type, 8);
    text.copy(out, 12);
    return out;
  };
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let loggedIn = false;
    const done = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("connect", () => socket.write(packet(1, 3, password)));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const body = buffer.subarray(12, 4 + length - 2).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (!loggedIn) {
          if (id === -1) return done(null);
          loggedIn = true;
          socket.write(packet(2, 2, command));
        } else {
          return done(body);
        }
      }
    });
    // "stop" can close the connection before answering.
    socket.on("close", () => done(loggedIn ? "" : null));
    socket.on("error", () => done(null));
  });
}

// ---- systemd

function systemctl(...args) {
  return new Promise((resolve) => {
    execFile("systemctl", ["--user", ...args], { timeout: 240_000 }, (error, stdout) => {
      resolve({ ok: !error, out: String(stdout ?? "").trim() });
    });
  });
}

export const systemdControl = {
  start: (unit) => systemctl("start", "--no-block", unit),
  stop: (unit) => systemctl("stop", unit),
  isActive: async (unit) => {
    const { out } = await systemctl("is-active", unit);
    return out === "active" || out === "activating" || out === "reloading";
  }
};

// ---- one gated server

export class ServerGate {
  /**
   * @param {{ name: string, unit: string, listen: number, backend: number, idleMinutes?: number }} entry
   * @param {{ stateDir: string, control?: typeof systemdControl, log?: (line: string) => void, timing?: Partial<typeof DEFAULTS> }} options
   */
  constructor(entry, { stateDir, control = systemdControl, rcon = rconCommand, log = console.log, timing = {} }) {
    this.entry = entry;
    this.stateDir = stateDir;
    this.control = control;
    this.rcon = rcon;
    this.timing = { ...DEFAULTS, ...timing };
    this.idleMs = (entry.idleMinutes ?? this.timing.idleMinutes) * 60_000;
    if (timing.idleMs !== undefined) this.idleMs = timing.idleMs;
    this.log = (line) => log(`[${entry.unit}] ${line}`);
    /** down | starting | up | stopping */
    this.state = "down";
    this.startedAt = 0;
    this.lastActivity = Date.now();
    this.players = new Set();
    this.holds = new Set();
    this.probeFailures = 0;
    this.cachedStatus = this.readCache();
    this.waitId = WAIT_ID_BASE;
    this.server = null;
    this.timer = null;
    this.stopped = false;
  }

  get offFile() { return path.join(this.stateDir, `${this.entry.unit}.off`); }
  get cacheFile() { return path.join(this.stateDir, `${this.entry.unit}.status.json`); }
  isOff() { return fs.existsSync(this.offFile); }

  readCache() {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
    } catch {
      return null;
    }
  }

  writeCache(status) {
    const { version, players, description, favicon, forgeData, modinfo, enforcesSecureChat } = status;
    const kept = { version, players: players ? { max: players.max, online: 0 } : undefined, description, favicon, forgeData, modinfo, enforcesSecureChat };
    const text = JSON.stringify(kept);
    if (text === JSON.stringify(this.cachedStatus)) return;
    this.cachedStatus = kept;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(`${this.cacheFile}.tmp`, text);
      fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    } catch (error) {
      this.log(`status cache not saved: ${error.message}`);
    }
  }

  async listen() {
    const initial = await probeStatus(this.entry.backend, this.timing.probeTimeoutMs);
    if (initial) {
      this.setState("up");
      this.writeCache(initial);
    } else if (await this.control.isActive(this.entry.unit)) {
      this.setState("starting");
      this.startedAt = Date.now();
    }
    this.server = net.createServer((socket) => this.accept(socket));
    const bind = (host) => new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ port: this.entry.listen, host }, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    // Both IPv4 and IPv6 like the game server itself, or IPv4 only where IPv6 is off.
    await bind("::").catch((error) => error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL" ? bind("0.0.0.0") : Promise.reject(error));
    this.log(`listening on ${this.entry.listen} -> 127.0.0.1:${this.entry.backend} (${this.state})`);
    this.schedule();
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const socket of [...this.holds, ...this.players]) socket.destroy();
    await new Promise((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }

  setState(state) {
    if (this.state === state) return;
    this.log(`${this.state} -> ${state}`);
    this.state = state;
    if (state === "up" || state === "starting") this.lastActivity = Date.now();
  }

  schedule() {
    if (this.stopped) return;
    const fast = this.state === "starting" || this.holds.size > 0;
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), fast ? this.timing.fastProbeMs : this.timing.slowProbeMs);
  }

  /** Sooner check, e.g. right after a wake. */
  nudge() {
    if (this.stopped || this.ticking) return;
    clearTimeout(this.timer);
    this.schedule();
  }

  async tick() {
    if (this.state === "stopping") return;
    this.ticking = true;
    try {
      const status = await probeStatus(this.entry.backend, this.timing.probeTimeoutMs);
      if (status) {
        this.probeFailures = 0;
        this.writeCache(status);
        if (this.state !== "up") this.setState("up");
        this.releaseHolds();
        await this.maybeSleep(status);
        return;
      }
      if (this.state === "up") {
        // A busy server can miss one ping; a stopped one misses them all.
        this.probeFailures += 1;
        if (this.probeFailures >= 3 && !(await this.control.isActive(this.entry.unit))) this.setState("down");
      } else if (this.state === "starting") {
        const active = await this.control.isActive(this.entry.unit);
        if (Date.now() - this.startedAt > this.timing.startTimeoutMs || (!active && Date.now() - this.startedAt > 5_000)) {
          this.log(active ? "start timed out" : "unit stopped while starting");
          this.setState("down");
          this.failHolds();
        }
      } else if (this.state === "down" && this.holds.size > 0) {
        this.wake("held join");
      }
    } finally {
      this.ticking = false;
    }
  }

  async maybeSleep(status) {
    if (this.players.size > 0 || this.holds.size > 0) {
      this.lastActivity = Date.now();
      return;
    }
    // Someone can be on the server without passing through the gate (it was restarted under them).
    if ((status.players?.online ?? 0) > 0) {
      this.lastActivity = Date.now();
      return;
    }
    if (Date.now() - this.lastActivity < this.idleMs) return;
    this.setState("stopping");
    this.log(`nobody on for ${Math.round(this.idleMs / 1000)}s, stopping`);
    await this.stopServer();
    this.setState("down");
    // Someone tried to join, or pressed Play, while it was stopping.
    const again = this.wakeAfterStop || this.holds.size > 0;
    this.wakeAfterStop = false;
    if (again) this.wake("asked while stopping");
  }

  /**
   * The console "stop" over RCON, which saves the world before exiting; a
   * signal from systemd does not always get that far. systemd stops what is
   * left (no RCON, or the server did not exit in time).
   */
  async stopServer() {
    const rcon = this.entry.rcon;
    if (rcon) {
      const reply = await this.rcon(rcon.port, rcon.password, "stop");
      if (reply === null) {
        this.log("rcon stop failed, stopping with systemd");
      } else {
        const end = Date.now() + this.timing.rconStopMs;
        while (Date.now() < end && await this.control.isActive(this.entry.unit)) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    const result = await this.control.stop(this.entry.unit);
    if (!result.ok) this.log("stop reported an error");
  }

  wake(reason) {
    this.lastActivity = Date.now();
    if (this.state === "stopping") {
      this.wakeAfterStop = true;
      return true;
    }
    if (this.state === "up" || this.state === "starting") return true;
    if (this.isOff()) return false;
    this.log(`waking (${reason})`);
    this.setState("starting");
    this.startedAt = Date.now();
    void this.control.start(this.entry.unit).then((result) => {
      if (!result.ok) this.log("start reported an error");
    });
    this.nudge();
    return true;
  }

  // ---- connections

  accept(socket) {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    const dropTimer = setTimeout(() => socket.destroy(), 10_000);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (buffer[0] === 0xfe) {
          // Pre-1.7 server list ping.
          socket.off("data", onData);
          clearTimeout(dropTimer);
          if (this.state === "up") this.pipe(socket, buffer, false);
          else socket.destroy();
          return;
        }
        const read = readFrame(buffer, MAX_HANDSHAKE_BYTES);
        if (!read) {
          if (buffer.length > MAX_HANDSHAKE_BYTES) socket.destroy();
          return;
        }
        socket.off("data", onData);
        clearTimeout(dropTimer);
        const handshake = parseHandshake(read.payload);
        const wakeAsked = handshake.host.endsWith(WAKE_MARKER);
        if (wakeAsked) handshake.host = handshake.host.slice(0, -WAKE_MARKER.length);
        const first = Buffer.concat([wakeAsked ? encodeHandshake(handshake) : read.frame, read.rest]);
        if (handshake.nextState === 1) this.status(socket, handshake, first, read.rest, wakeAsked);
        else if (handshake.nextState === 2 || handshake.nextState === 3) this.join(socket, first);
        else socket.destroy();
      } catch {
        socket.destroy();
      }
    };
    socket.on("data", onData);
    socket.on("error", () => socket.destroy());
  }

  status(socket, handshake, first, rest, wakeAsked) {
    if (wakeAsked && !this.wake("launcher")) {
      this.answerStatus(socket, handshake, rest, "off");
      return;
    }
    if (this.state === "up") {
      this.pipe(socket, first, false);
      return;
    }
    this.answerStatus(socket, handshake, rest, this.isOff() ? "off" : this.state === "down" ? "sleeping" : "starting");
  }

  statusJson(handshake, gate) {
    const cached = this.cachedStatus ?? {};
    return JSON.stringify({
      ...cached,
      version: cached.version ?? { name: "", protocol: handshake.protocol },
      players: { max: cached.players?.max ?? 20, online: 0 },
      description: cached.description ?? { text: this.entry.name ?? "" },
      bweeep: { gate }
    });
  }

  answerStatus(socket, handshake, initial, gate) {
    let buffer = initial;
    const handle = () => {
      for (;;) {
        const read = readFrame(buffer, 64);
        if (!read) return;
        buffer = read.rest;
        const id = readVarInt(read.payload).value;
        if (id === 0x00) {
          socket.write(encodePacket(0x00, encodeString(this.statusJson(handshake, gate))));
        } else if (id === 0x01) {
          socket.end(encodePacket(0x01, read.payload.subarray(1)));
          return;
        } else {
          socket.destroy();
          return;
        }
      }
    };
    const timer = setTimeout(() => socket.destroy(), 10_000);
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        handle();
      } catch {
        socket.destroy();
      }
    });
    try {
      handle();
    } catch {
      socket.destroy();
    }
  }

  join(socket, first) {
    if (this.state === "up") {
      this.pipe(socket, first, true);
      return;
    }
    if (this.state !== "stopping" && !this.wake("join")) {
      socket.end(loginDisconnect(TEXT.off));
      return;
    }
    this.hold(socket, first);
  }

  /**
   * Keeps a join on the "Logging in" screen: the client's own packets are
   * kept to replay, and a login query it does not know every few seconds
   * keeps its 30-second read timeout from firing. Its "not understood"
   * answers are dropped, so the server never sees them.
   */
  hold(socket, first) {
    const handshake = readFrame(first, MAX_HANDSHAKE_BYTES);
    const held = { socket, kept: [Buffer.from(handshake.frame)], pending: new Set(), buffer: Buffer.from(handshake.rest), heldBytes: 0, releasing: false };
    this.holds.add(held);
    const since = Date.now();
    this.log(`holding a join (${this.state})`);

    const parse = () => {
      for (;;) {
        const read = readFrame(held.buffer, MAX_HELD_BYTES);
        if (!read) break;
        held.buffer = read.rest;
        const id = readVarInt(read.payload);
        if (id.value === 0x02) {
          const message = readVarInt(read.payload, id.size);
          if (message && held.pending.delete(message.value)) continue;
        }
        held.heldBytes += read.frame.length;
        if (held.heldBytes > MAX_HELD_BYTES) throw new Error("too much held");
        held.kept.push(Buffer.from(read.frame));
      }
      if (held.releasing && held.pending.size === 0) this.handOver(held);
    };
    held.onData = (chunk) => {
      held.buffer = Buffer.concat([held.buffer, chunk]);
      try {
        parse();
      } catch {
        this.dropHold(held);
      }
    };
    held.ping = setInterval(() => {
      if (Date.now() - since > this.timing.holdMaxMs) {
        this.dropHold(held, TEXT.failed);
        return;
      }
      if (held.releasing) return;
      const id = this.waitId++;
      if (this.waitId > WAIT_ID_BASE + 0xffff) this.waitId = WAIT_ID_BASE;
      held.pending.add(id);
      socket.write(encodePacket(0x04, Buffer.concat([encodeVarInt(id), encodeString(WAIT_CHANNEL)])));
    }, this.timing.holdPingMs);
    socket.on("data", held.onData);
    socket.on("close", () => this.dropHold(held));
    try {
      parse();
    } catch {
      this.dropHold(held);
    }
    this.nudge();
  }

  dropHold(held, text) {
    if (!this.holds.delete(held)) return;
    clearInterval(held.ping);
    clearTimeout(held.answerTimer);
    if (text) held.socket.end(loginDisconnect(text));
    else held.socket.destroy();
  }

  releaseHolds() {
    for (const held of this.holds) {
      if (held.releasing) continue;
      held.releasing = true;
      clearInterval(held.ping);
      if (held.pending.size === 0) {
        this.handOver(held);
      } else {
        // An answer still on its way would reach the server as an unexpected reply.
        held.answerTimer = setTimeout(() => this.dropHold(held, TEXT.failed), 5_000);
      }
    }
  }

  failHolds() {
    for (const held of [...this.holds]) this.dropHold(held, TEXT.failed);
  }

  handOver(held) {
    if (!this.holds.delete(held)) return;
    clearInterval(held.ping);
    clearTimeout(held.answerTimer);
    held.socket.off("data", held.onData);
    held.socket.removeAllListeners("close");
    this.log(`handing a held join over after ${held.kept.length - 1} packet(s)`);
    this.pipe(held.socket, Buffer.concat([...held.kept, held.buffer]), true);
  }

  pipe(client, first, isPlayer) {
    const backend = net.connect({ host: "127.0.0.1", port: this.entry.backend });
    backend.setNoDelay(true);
    let closed = false;
    let connected = false;
    const close = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      backend.destroy();
      if (isPlayer && this.players.delete(client)) this.lastActivity = Date.now();
    };
    if (isPlayer) {
      this.players.add(client);
      this.lastActivity = Date.now();
    }
    client.pause();
    backend.once("connect", () => {
      connected = true;
      backend.write(first);
      client.pipe(backend);
      backend.pipe(client);
      client.resume();
    });
    backend.on("error", (error) => {
      if (connected) return close();
      // Nothing answered: the server went away; treat this join like one to a sleeping server.
      this.log(`backend refused: ${error.code ?? error.message}`);
      if (isPlayer && !closed) {
        closed = true;
        this.players.delete(client);
        this.setState("down");
        client.removeAllListeners("error");
        client.on("error", () => client.destroy());
        client.resume();
        this.join(client, first);
        return;
      }
      close();
    });
    client.on("error", close);
    client.on("close", close);
    backend.on("close", () => {
      if (!closed) close();
    });
  }
}

// ---- entry point

function parseArgs(argv) {
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) throw new Error("사용법: node scripts/server-gate.mjs --config <gate.json>");
  return { config: argv[index + 1] };
}

export function readConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!config || typeof config.stateDir !== "string" || !Array.isArray(config.servers) || config.servers.length === 0) {
    throw new Error("gate.json 에 stateDir 와 servers 가 필요합니다.");
  }
  const ports = new Set();
  for (const server of config.servers) {
    for (const key of ["listen", "backend"]) {
      if (!Number.isInteger(server[key]) || server[key] < 1 || server[key] > 65535) throw new Error(`${server.unit}: ${key} 포트가 올바르지 않습니다.`);
      if (ports.has(server[key])) throw new Error(`포트 ${server[key]} 가 두 번 쓰였습니다.`);
      ports.add(server[key]);
    }
    if (server.rcon !== undefined) {
      const { port, password } = server.rcon ?? {};
      if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(port)) throw new Error(`${server.unit}: rcon 포트가 올바르지 않습니다.`);
      if (typeof password !== "string" || password.length < 8) throw new Error(`${server.unit}: rcon 비밀번호가 올바르지 않습니다.`);
      ports.add(port);
    }
    if (typeof server.unit !== "string" || !/^[\w@.-]+$/.test(server.unit)) throw new Error("unit 이름이 올바르지 않습니다.");
    if (server.idleMinutes !== undefined && !(server.idleMinutes > 0)) throw new Error(`${server.unit}: idleMinutes 가 올바르지 않습니다.`);
  }
  return config;
}

async function main() {
  const { config: file } = parseArgs(process.argv.slice(2));
  const config = readConfig(file);
  fs.mkdirSync(config.stateDir, { recursive: true });
  const gates = config.servers.map((entry) => new ServerGate(entry, { stateDir: config.stateDir }));
  for (const gate of gates) await gate.listen();
  const shutdown = async () => {
    await Promise.all(gates.map((gate) => gate.close()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
