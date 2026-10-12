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
// - Outside its optional "schedule" (opening hours) a STOPPED server is not
//   started: joins are refused with the next opening time and status says
//   "closed" (+ `nextOpen`). When the hours end, a running server is warned
//   in-game (5 min, 1 min, 10 s) and stopped with the console "stop" (the
//   world is saved); when they begin it is started. Each boundary once.
//   `<stateDir>/<unit>.open-until` (ISO time) opens it by hand until then.
//
// Usage: node scripts/server-gate.mjs --config <gate.json>
// gate.json: { "stateDir": "...", "servers": [{ "name", "unit", "listen", "backend", "idleMinutes", "rcon": { "port", "password" }, "schedule": { "startsOn", "open": [{ "from", "to" }] } }] }
// SIGHUP re-reads only the schedules (see reloadSchedules).
// With "rcon" the server is stopped with the console "stop" (saves the world), then systemd.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
  rconStopMs: 180_000,
  // A server whose unit still runs but that stopped answering is restarted
  // after this long. A closed port means it crashed or is stopping and has
  // had time to save; silence can be a busy server, so that waits longer.
  hungRefusedMs: 45_000,
  hungSilentMs: 180_000,
  // Opening hours: how often the gate looks at the clock.
  hoursCheckMs: 1_000,
  // A server starts this long after an opening boundary, so the one closing at the same instant (Cobblemon
  // Sunday noon = Sunlit Sunday noon) has time to save and exit before the other JVM comes up.
  openStartDelayMs: 60_000,
  // A start for a boundary older than this is not made: a gate that was not running then leaves a sleeping server asleep.
  startFreshMs: 10 * 60_000,
  // A warning is only sent within this long after its moment; a late one would read wrong ("5분 뒤" with 3 minutes left).
  warningLateMs: 15_000,
  // A close that is found late (gate restart, hours loaded or override ended while players are on) gives this much notice.
  lateCloseWaitMs: 10_000,
  // Another gate's stop marker older than this is ignored (a crashed gate leaves it behind).
  otherStopMaxMs: 6 * 60_000
};

/**
 * What players see before the opening hours end and the server is stopped (the Bweeep notice banner,
 * sent over RCON). Edit the moments and texts here; `"warn": false` in a schedule turns them off for that server.
 */
export const HOURS_WARNINGS = [
  { beforeMs: 5 * 60_000, level: "warning", seconds: 8, text: "5분 뒤 서버가 닫혀요" },
  { beforeMs: 60_000, level: "warning", seconds: 8, text: "1분 뒤 서버가 닫혀요" },
  { beforeMs: 10_000, level: "urgent", seconds: 8, text: "곧 서버가 닫혀요, 지금 저장돼요" }
];

const TEXT = {
  off: "서버가 꺼져 있어요",
  failed: "서버를 켜지 못했어요. 잠시 뒤 다시 들어와 주세요",
  closed: (nextOpen) => `지금은 열려 있지 않아요. ${formatOpenTime(nextOpen)}에 열려요`
};

// ---- opening hours
//
// gate.json: "schedule": { "startsOn": "2026-10-23", "open": [{ "from": "fri 17:00", "to": "sat 02:00" }, { "from": "sat 07:00", "to": "sun 02:00" }], "warn": true }
// Times are Korean time (UTC+9, no daylight saving). A window runs from `from`
// up to, not including, `to`, and may wrap past the end of the week
// ("sun 19:30" -> "fri 17:00"). Before `startsOn` (a Korean date) the server is
// always open and the gate does nothing on its own. No `schedule` at all: always open.
// Inside the schedule the gate keeps the server on the hours: a stopped server
// is not started outside them, a running one is warned (HOURS_WARNINGS) and
// then stopped gracefully when they end, and one is started when they begin.

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NAMES = ["월", "화", "수", "목", "금", "토", "일"];
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const KST_OFFSET_MS = 9 * 3_600_000;
const WINDOW_TIME = /^(mon|tue|wed|thu|fri|sat|sun) ([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_WINDOWS = 14;

/** Seconds since Monday 00:00 Korean time. */
function weekSecond(ms) {
  const kst = ms + KST_OFFSET_MS;
  const days = Math.floor(kst / 86_400_000);
  // 1970-01-01 was a Thursday (index 3 with Monday first).
  const dayIndex = (((days + 3) % 7) + 7) % 7;
  return dayIndex * DAY_SECONDS + Math.floor((kst - days * 86_400_000) / 1000);
}

function parseWindowTime(text, where) {
  const match = typeof text === "string" ? WINDOW_TIME.exec(text) : null;
  if (!match) throw new Error(`${where}: "${text}" 는 "fri 12:00" 모양이어야 합니다.`);
  return DAYS.indexOf(match[1]) * DAY_SECONDS + Number(match[2]) * 3600 + Number(match[3]) * 60;
}

/** Checks a gate.json `schedule` block strictly and returns what the gate uses; throws with a readable reason. */
export function parseSchedule(value, label = "schedule") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: 객체여야 합니다.`);
  for (const key of Object.keys(value)) {
    if (!["timezone", "startsOn", "open", "warn"].includes(key)) throw new Error(`${label}: 알 수 없는 항목 "${key}" 입니다.`);
  }
  if (value.warn !== undefined && typeof value.warn !== "boolean") throw new Error(`${label}: warn 은 true 나 false 여야 합니다.`);
  if (value.timezone !== undefined && value.timezone !== "Asia/Seoul") throw new Error(`${label}: timezone 은 Asia/Seoul 만 쓸 수 있습니다.`);
  let startsOnMs = null;
  if (value.startsOn !== undefined) {
    const match = typeof value.startsOn === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.startsOn) : null;
    const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.startsOn) {
      throw new Error(`${label}: startsOn 은 실제 날짜 "2026-10-26" 모양이어야 합니다.`);
    }
    startsOnMs = date.getTime() - KST_OFFSET_MS;
  }
  if (!Array.isArray(value.open) || value.open.length === 0 || value.open.length > MAX_WINDOWS) {
    throw new Error(`${label}: open 은 1~${MAX_WINDOWS}개의 시간대 목록이어야 합니다.`);
  }
  const windows = value.open.map((window, index) => {
    const where = `${label}.open[${index}]`;
    if (!window || typeof window !== "object" || Array.isArray(window)) throw new Error(`${where}: 객체여야 합니다.`);
    for (const key of Object.keys(window)) {
      if (key !== "from" && key !== "to") throw new Error(`${where}: 알 수 없는 항목 "${key}" 입니다.`);
    }
    const start = parseWindowTime(window.from, `${where}.from`);
    const end = parseWindowTime(window.to, `${where}.to`);
    if (start === end) throw new Error(`${where}: from 과 to 가 같습니다.`);
    return { start, end };
  });
  return { startsOnMs, windows, warn: value.warn !== false };
}

function inWindow(second, { start, end }) {
  return start < end ? second >= start && second < end : second >= start || second < end;
}

/** True when the server may be started at `ms`; no schedule, or before `startsOn`, is always open. */
export function isOpenAt(schedule, ms) {
  if (!schedule) return true;
  if (schedule.startsOnMs !== null && ms < schedule.startsOnMs) return true;
  const second = weekSecond(ms);
  return schedule.windows.some((window) => inWindow(second, window));
}

/** The next moment (ms) a window starts; `ms` itself when it is open now. */
export function nextOpenAt(schedule, ms) {
  if (isOpenAt(schedule, ms)) return ms;
  const second = weekSecond(ms);
  const wait = Math.min(...schedule.windows.map(({ start }) => (start - second + WEEK_SECONDS) % WEEK_SECONDS));
  return Math.floor(ms / 1000) * 1000 + wait * 1000;
}

/** The next moment (ms) the current window ends, or null when it is closed (or before `startsOn`). */
export function nextCloseAt(schedule, ms) {
  if (!schedule || (schedule.startsOnMs !== null && ms < schedule.startsOnMs) || !isOpenAt(schedule, ms)) return null;
  const second = weekSecond(ms);
  const waits = schedule.windows.filter((window) => inWindow(second, window)).map(({ end }) => ((end - second + WEEK_SECONDS) % WEEK_SECONDS) || WEEK_SECONDS);
  return Math.floor(ms / 1000) * 1000 + Math.max(...waits) * 1000;
}

const WEEK_MS = WEEK_SECONDS * 1000;

/** Open by the schedule, or by an admin's hand until `overrideUntilMs` (0: none). */
function effectiveOpenAt(schedule, overrideUntilMs, ms) {
  return isOpenAt(schedule, ms) || ms < overrideUntilMs;
}

/**
 * The moments in [fromMs, toMs] where being open flips, oldest first, as { at, type: "open" | "close" }.
 * The end of a hand-opened period is one too. `startsOn` is not: before it nothing flips, and at it nothing is
 * stopped (a server running then, say Cobblemon's tester period, is left alone until the first window ends).
 */
export function changesBetween(schedule, overrideUntilMs, fromMs, toMs) {
  const candidates = new Set();
  const firstWeek = Math.floor(fromMs / 1000) * 1000 - weekSecond(fromMs) * 1000 - WEEK_MS;
  for (let weekStart = firstWeek; weekStart <= toMs; weekStart += WEEK_MS) {
    for (const { start, end } of schedule.windows) {
      candidates.add(weekStart + start * 1000);
      candidates.add(weekStart + end * 1000);
    }
  }
  if (overrideUntilMs > 0) candidates.add(overrideUntilMs);
  return [...candidates]
    .filter((at) => at >= fromMs && at <= toMs)
    .sort((a, b) => a - b)
    .map((at) => ({ at, before: effectiveOpenAt(schedule, overrideUntilMs, at - 1), after: effectiveOpenAt(schedule, overrideUntilMs, at) }))
    .filter((change) => change.before !== change.after)
    .map((change) => ({ at: change.at, type: change.after ? "open" : "close" }));
}

/** "금 12:00": the weekday and time in Korean time. */
export function formatOpenTime(ms) {
  const second = weekSecond(ms);
  const day = Math.floor(second / DAY_SECONDS);
  const rest = second % DAY_SECONDS;
  const pad = (number) => String(number).padStart(2, "0");
  return `${DAY_NAMES[day]} ${pad(Math.floor(rest / 3600))}:${pad(Math.floor((rest % 3600) / 60))}`;
}

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
  return probeBackend(port, timeoutMs).then((result) => result.status);
}

/** probeStatus, plus whether the port was closed (`refused`) rather than silent. */
export function probeBackend(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let received = Buffer.alloc(0);
    let refused = false;
    const done = (status) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, refused });
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
    socket.on("error", (error) => {
      refused = error.code === "ECONNREFUSED";
      done(null);
    });
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
  constructor(entry, { stateDir, control = systemdControl, rcon = rconCommand, log = console.log, timing = {}, now = Date.now }) {
    this.entry = entry;
    this.stateDir = stateDir;
    this.control = control;
    this.rcon = rcon;
    this.now = now;
    /** Opening hours (see parseSchedule), or null: always open. */
    this.hours = entry.schedule ? parseSchedule(entry.schedule, `${entry.unit}.schedule`) : null;
    /** Boundaries already acted on, kept in a file so a restarted gate does not act twice. */
    this.hoursState = this.readHoursState();
    this.hoursTimer = null;
    this.enforcing = false;
    /** Players the server itself last reported. */
    this.onlineCount = 0;
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
    // While "up": when it stopped answering, and whether every miss was a closed port.
    this.unansweredSince = 0;
    this.refusedOnly = true;
    this.cachedStatus = this.readCache();
    this.waitId = WAIT_ID_BASE;
    this.server = null;
    this.timer = null;
    this.stopped = false;
  }

  get offFile() { return path.join(this.stateDir, `${this.entry.unit}.off`); }
  get openFile() { return path.join(this.stateDir, `${this.entry.unit}.open-until`); }
  get cacheFile() { return path.join(this.stateDir, `${this.entry.unit}.status.json`); }
  isOff() { return fs.existsSync(this.offFile); }

  /** A new schedule from a reloaded gate.json (null removes it); throws and keeps the old one when it is invalid. */
  setSchedule(raw) {
    this.hours = raw ? parseSchedule(raw, `${this.entry.unit}.schedule`) : null;
    this.entry.schedule = raw ?? undefined;
    this.log(raw ? "opening hours loaded" : "opening hours removed");
  }

  /**
   * An admin can open a closed server by hand (`<unit>.open-until` holds an
   * ISO time or epoch milliseconds). The time in the file, or 0 when there is
   * none; it stops counting when that time passes, and its end is a boundary.
   */
  overrideUntil() {
    try {
      const text = fs.readFileSync(this.openFile, "utf8").trim();
      const until = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
      return Number.isFinite(until) && until > 0 ? until : 0;
    } catch {
      return 0;
    }
  }

  openedByHand() { return this.overrideUntil() > this.now(); }

  /** Outside its opening hours (and not opened by hand): a stopped server is not started. */
  isClosed() {
    return this.hours !== null && !isOpenAt(this.hours, this.now()) && !this.openedByHand();
  }

  /** Whether a stopped server may be started now. */
  canWake() { return !this.isOff() && !this.isClosed(); }

  nextOpen() { return this.hours ? nextOpenAt(this.hours, this.now()) : this.now(); }

  /** What a refused join reads. */
  refusalText() { return this.isOff() ? TEXT.off : TEXT.closed(this.nextOpen()); }

  // ---- keeping the server on its opening hours

  get hoursFile() { return path.join(this.stateDir, `${this.entry.unit}.hours.json`); }
  /** Marks a scheduled stop under way, so the gate of the server opening at the same moment waits. */
  get stoppingFile() { return path.join(this.stateDir, `${this.entry.unit}.stopping`); }

  readHoursState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.hoursFile, "utf8"));
      return { stop: Number(state.stop) || 0, start: Number(state.start) || 0, warned: state.warned && typeof state.warned === "object" ? state.warned : {} };
    } catch {
      return { stop: 0, start: 0, warned: {} };
    }
  }

  saveHoursState() {
    // Old warning records are dropped; the boundaries themselves are what is remembered.
    const cutoff = this.now() - 9 * 86_400_000;
    for (const key of Object.keys(this.hoursState.warned)) if (Number(key) < cutoff) delete this.hoursState.warned[key];
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(`${this.hoursFile}.tmp`, JSON.stringify(this.hoursState));
      fs.renameSync(`${this.hoursFile}.tmp`, this.hoursFile);
    } catch (error) {
      this.log(`hours state not saved: ${error.message}`);
    }
  }

  /** The state of the hours now: open, the last boundary, and the next closing. */
  hoursView(now) {
    const until = this.overrideUntil();
    const last = changesBetween(this.hours, until, now - 8 * 86_400_000, now).at(-1) ?? null;
    const nextClose = changesBetween(this.hours, until, now + 1, now + 8 * 86_400_000).find((change) => change.type === "close")?.at ?? null;
    return { open: effectiveOpenAt(this.hours, until, now), last, nextClose };
  }

  scheduleHours() {
    if (this.stopped) return;
    this.hoursTimer = setTimeout(() => {
      this.enforceHours()
        .catch((error) => this.log(`opening hours check failed: ${error.message}`))
        .finally(() => this.scheduleHours());
    }, this.timing.hoursCheckMs);
  }

  /**
   * Keeps the server on its hours. At the end of them a running server is
   * warned and stopped (the console "stop", which saves the world); at the
   * start of them a stopped one is started. Each boundary is acted on once,
   * remembered in a file. Before `startsOn`, without a schedule, or while an
   * admin has the server open by hand, nothing happens on its own.
   */
  async enforceHours() {
    if (!this.hours || this.enforcing || this.stopped) return;
    this.enforcing = true;
    try {
      const now = this.now();
      const view = this.hoursView(now);
      if (this.hours.warn && this.state === "up" && view.open && view.nextClose !== null) await this.sendWarnings(view.nextClose, now);
      if (!view.last) return;
      if (view.last.type === "close") await this.closeForHours(view.last.at, now);
      else await this.openForHours(view.last.at, now);
    } finally {
      this.enforcing = false;
    }
  }

  /** One banner over RCON (the same command as scripts/bweeep-notify.mjs); false when it could not be delivered. */
  async notify(level, seconds, text) {
    const rcon = this.entry.rcon;
    if (!rcon) return false;
    const json = JSON.stringify({ translate: "bweeep.notice", fallback: "[공지] %3$s", with: [level, String(seconds), text] })
      .replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const reply = await this.rcon(rcon.port, rcon.password, `tellraw @a ${json}`);
    if (reply === null) this.log("notice not delivered (rcon did not answer)");
    return reply !== null;
  }

  async sendWarnings(closeAt, now) {
    for (const warning of HOURS_WARNINGS) {
      const at = closeAt - warning.beforeMs;
      const sent = this.hoursState.warned[closeAt] ?? [];
      if (now < at || now - at > this.timing.warningLateMs || sent.includes(warning.beforeMs)) continue;
      this.hoursState.warned[closeAt] = [...sent, warning.beforeMs];
      this.saveHoursState();
      this.log(`warning: ${warning.text}`);
      await this.notify(warning.level, warning.seconds, warning.text);
    }
  }

  async closeForHours(at, now) {
    if (this.hoursState.stop >= at || this.state === "stopping") return;
    if (this.state === "down") {
      this.hoursState.stop = at;
      this.saveHoursState();
      return;
    }
    this.log(`opening hours ended (${formatOpenTime(at)}), stopping the server`);
    // Found late (the gate was restarted, new hours were loaded, a hand-opened period ended): tell the players first.
    const late = now - at > this.timing.warningLateMs;
    if (late && this.hours.warn && this.state === "up" && (this.players.size > 0 || this.onlineCount > 0)) {
      const last = HOURS_WARNINGS.at(-1);
      await this.notify(last.level, last.seconds, last.text);
      await new Promise((resolve) => setTimeout(resolve, this.timing.lateCloseWaitMs));
    }
    this.setState("stopping");
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      fs.writeFileSync(this.stoppingFile, String(Date.now()));
    } catch { /* the marker only spares an overlap of two JVMs */ }
    try {
      await this.stopServer();
    } finally {
      fs.rmSync(this.stoppingFile, { force: true });
      this.setState("down");
      this.hoursState.stop = at;
      this.saveHoursState();
    }
  }

  /** Another gate is stopping its server right now (not older than otherStopMaxMs). */
  otherGateStopping() {
    try {
      return fs.readdirSync(this.stateDir).some((name) => {
        if (!name.endsWith(".stopping") || name === `${this.entry.unit}.stopping`) return false;
        return Date.now() - fs.statSync(path.join(this.stateDir, name)).mtimeMs < this.timing.otherStopMaxMs;
      });
    } catch {
      return false;
    }
  }

  async openForHours(at, now) {
    if (this.hoursState.start >= at) return;
    // Not for a boundary long gone: a gate that was not here then leaves a sleeping server asleep.
    if (now - at > this.timing.startFreshMs) return;
    if (now < at + this.timing.openStartDelayMs || this.otherGateStopping()) return;
    if (this.state === "stopping") return;
    if (this.state === "down" && this.isOff()) return;
    if (this.state === "down") this.log(`opening hours began (${formatOpenTime(at)}), starting the server`);
    if (this.wake("opening hours")) {
      this.hoursState.start = at;
      this.saveHoursState();
    }
  }

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
    this.scheduleHours();
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.hoursTimer);
    for (const socket of [...this.holds, ...this.players]) socket.destroy();
    await new Promise((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }

  setState(state) {
    if (this.state === state) return;
    this.log(`${this.state} -> ${state}`);
    this.state = state;
    this.probeFailures = 0;
    this.unansweredSince = 0;
    if (state === "up" || state === "starting") this.lastActivity = Date.now();
  }

  /** Running as far as systemd knows, but not answering. */
  get unanswered() { return this.state === "up" && this.probeFailures >= 3; }

  schedule() {
    if (this.stopped) return;
    const fast = this.state === "starting" || this.holds.size > 0 || this.probeFailures > 0;
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
      const { status, refused } = await probeBackend(this.entry.backend, this.timing.probeTimeoutMs);
      if (status) {
        this.probeFailures = 0;
        this.unansweredSince = 0;
        this.onlineCount = status.players?.online ?? 0;
        this.writeCache(status);
        if (this.state !== "up") this.setState("up");
        this.releaseHolds();
        await this.maybeSleep(status);
        return;
      }
      if (this.state === "up") {
        // A busy server can miss one ping; a stopped one misses them all.
        this.probeFailures += 1;
        if (this.probeFailures === 1) {
          this.unansweredSince = Date.now();
          this.refusedOnly = true;
        }
        if (!refused) this.refusedOnly = false;
        if (this.probeFailures < 3) return;
        if (!(await this.control.isActive(this.entry.unit))) {
          this.setState("down");
          return;
        }
        // systemd still counts it as running: it crashed and got stuck on the way out, or it hangs.
        const waited = Date.now() - this.unansweredSince;
        if (!this.isOff() && waited >= (this.refusedOnly ? this.timing.hungRefusedMs : this.timing.hungSilentMs)) await this.recover(waited);
      } else if (this.state === "starting") {
        const active = await this.control.isActive(this.entry.unit);
        if (Date.now() - this.startedAt > this.timing.startTimeoutMs || (!active && Date.now() - this.startedAt > 5_000)) {
          this.log(active ? "start timed out" : "unit stopped while starting");
          this.setState("down");
          this.failHolds();
        }
      } else if (this.state === "down" && this.holds.size > 0) {
        // Off or outside opening hours: nobody is waiting for a server that will not start.
        if (!this.wake("held join")) this.failHolds(this.refusalText());
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

  /** Stops what is left of a stuck server and starts it again; joins wait as they do for a start. */
  async recover(waitedMs) {
    this.log(`not answering for ${Math.round(waitedMs / 1000)}s with the unit running, restarting`);
    this.setState("starting");
    this.startedAt = Date.now();
    await this.stopServer();
    this.startedAt = Date.now();
    const result = await this.control.start(this.entry.unit);
    if (!result.ok) this.log("start reported an error");
  }

  wake(reason) {
    this.lastActivity = Date.now();
    // Already running (or starting): nothing to start. Stopping it outside the hours is enforceHours' job, with a warning first.
    if (this.state === "up" || this.state === "starting") return true;
    if (!this.canWake()) return false;
    if (this.state === "stopping") {
      this.wakeAfterStop = true;
      return true;
    }
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
      this.answerStatus(socket, handshake, rest, this.gateLabel());
      return;
    }
    if (this.state === "up" && !this.unanswered) {
      this.pipe(socket, first, false);
      return;
    }
    this.answerStatus(socket, handshake, rest, this.gateLabel());
  }

  /** What a status ping says while the backend is not answering: off, closed (outside opening hours), sleeping or starting. */
  gateLabel() {
    if (this.isOff()) return "off";
    if ((this.state === "down" || this.state === "stopping") && this.isClosed()) return "closed";
    return this.state === "down" ? "sleeping" : "starting";
  }

  statusJson(handshake, gate) {
    const cached = this.cachedStatus ?? {};
    return JSON.stringify({
      ...cached,
      version: cached.version ?? { name: "", protocol: handshake.protocol },
      players: { max: cached.players?.max ?? 20, online: 0 },
      description: cached.description ?? { text: this.entry.name ?? "" },
      // `nextOpen` (epoch ms) lets the launcher say when the server opens.
      bweeep: gate === "closed" ? { gate, nextOpen: this.nextOpen() } : { gate }
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
    // A server that may not start (off, or outside opening hours) turns a join away at once.
    const refused = this.state === "stopping" ? !this.canWake() : !this.wake("join");
    if (refused) {
      socket.end(loginDisconnect(this.refusalText()));
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

  failHolds(text = TEXT.failed) {
    for (const held of [...this.holds]) this.dropHold(held, text);
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
      // Nothing answered: the server went away. The join waits while the next
      // checks tell a stopped server (wake it) from a stuck one (restart it).
      this.log(`backend refused: ${error.code ?? error.message}`);
      if (isPlayer && !closed) {
        closed = true;
        this.players.delete(client);
        client.removeAllListeners("error");
        client.on("error", () => client.destroy());
        client.resume();
        if (!this.canWake()) client.end(loginDisconnect(this.refusalText()));
        else this.hold(client, first);
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

/** SHA-256 of this file as it is on disk; a running gate records it at start. */
export function gateCodeHash(file = fileURLToPath(import.meta.url)) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

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
    if (server.schedule !== undefined) parseSchedule(server.schedule, `${server.unit}.schedule`);
  }
  return config;
}

/**
 * Re-reads gate.json and applies only the opening hours, so they can change
 * without restarting the gate (a restart would cut every player's connection).
 * A file that does not check out changes nothing. Returns the units updated.
 */
export function reloadSchedules(file, gates, log = console.log) {
  let config;
  try {
    config = readConfig(file);
  } catch (error) {
    log(`gate.json reload refused, opening hours unchanged: ${error.message}`);
    return [];
  }
  const updated = [];
  for (const gate of gates) {
    const entry = config.servers.find((server) => server.unit === gate.entry.unit);
    if (!entry) continue;
    gate.setSchedule(entry.schedule);
    updated.push(gate.entry.unit);
  }
  return updated;
}

async function main() {
  const { config: file } = parseArgs(process.argv.slice(2));
  const config = readConfig(file);
  fs.mkdirSync(config.stateDir, { recursive: true });
  const gates = config.servers.map((entry) => new ServerGate(entry, { stateDir: config.stateDir }));
  for (const gate of gates) await gate.listen();
  // Which code is running, so scripts/gate-schedule.mjs install can tell a gate that still needs a restart.
  const codeHash = gateCodeHash();
  for (const gate of gates) fs.writeFileSync(path.join(config.stateDir, `${gate.entry.unit}.gate-code`), `${codeHash}\n`);
  const shutdown = async () => {
    await Promise.all(gates.map((gate) => gate.close()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // `systemctl --user kill --kill-whom=main -s HUP bweeep-gate@<unit>`: new opening hours, connections untouched.
  process.on("SIGHUP", () => reloadSchedules(file, gates, console.log));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
