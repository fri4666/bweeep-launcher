import net from "node:net";
import type { ServerStatus } from "../shared/types.js";

export interface CheckServerOptions {
  timeoutMs?: number;
  /** Largest status reply accepted; Forge servers list their mods in it. */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
// Protocol -1 asks for the status without claiming a client version.
const STATUS_PROTOCOL = -1;
/** Added to the handshake host so the server gate (scripts/server-gate.mjs) starts a sleeping server. */
export const WAKE_MARKER = "\0bweeep-wake";

// The launcher polls every server; a check still running is shared, not repeated.
const inFlight = new Map<string, Promise<ServerStatus>>();

/**
 * Minecraft Server List Ping: players and version when the server answers
 * one, otherwise just whether a TCP connection opens.
 */
export function checkServer(server: { host: string; port: number }, options: CheckServerOptions = {}): Promise<ServerStatus> {
  const key = `${server.host}:${server.port}`;
  let check = inFlight.get(key);
  if (!check) {
    check = pingServer(server.host, server.port, options).finally(() => inFlight.delete(key));
    inFlight.set(key, check);
  }
  return check;
}

/**
 * Asks a server stopped while empty to start, as soon as Play is pressed, so
 * it starts while the game files are checked and the game loads. A server
 * without the gate just answers a normal status ping.
 */
export function wakeServer(server: { host: string; port: number }): Promise<ServerStatus> {
  return pingServer(server.host, server.port, {}, true);
}

function pingServer(host: string, port: number, options: CheckServerOptions, wake = false): Promise<ServerStatus> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let latencyMs: number | null = null;
    let received = Buffer.alloc(0);
    let settled = false;
    const offline = (): ServerStatus => ({ online: false, host, port, message: "연결 끊김" });
    const tcpOnly = (): ServerStatus => ({ online: true, host, port, latencyMs: latencyMs ?? 0, message: "서버 연결 가능" });
    const finish = (status: ServerStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(status);
    };
    // One deadline for connecting and reading the reply.
    const timer = setTimeout(() => finish(latencyMs === null ? offline() : tcpOnly()), timeoutMs);

    socket.once("connect", () => {
      latencyMs = Math.round(performance.now() - startedAt);
      socket.write(Buffer.concat([encodeHandshake(wake ? `${host}${WAKE_MARKER}` : host, port), encodePacket(0x00, Buffer.alloc(0))]));
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      try {
        const reply = readStatusReply(received, maxResponseBytes);
        if (!reply) return;
        const { off, ...status } = parseStatusJson(reply);
        // Switched off by the owner: the gate answers, but nobody can get in.
        finish(off ? offline() : { ...tcpOnly(), ...status });
      } catch {
        finish(tcpOnly());
      }
    });
    socket.once("end", () => finish(latencyMs === null ? offline() : tcpOnly()));
    socket.once("error", () => finish(latencyMs === null ? offline() : tcpOnly()));
  });
}

export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

/** The value and its byte length, or null when the buffer ends inside it. */
export function readVarInt(buffer: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    if (offset + index >= buffer.length) return null;
    const byte = buffer[offset + index];
    value |= (byte & 0x7f) << (7 * index);
    if ((byte & 0x80) === 0) return { value, size: index + 1 };
  }
  throw new Error("VarInt is too long");
}

function encodePacket(packetId: number, body: Buffer): Buffer {
  const payload = Buffer.concat([encodeVarInt(packetId), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

export function encodeHandshake(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, "utf8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return encodePacket(0x00, Buffer.concat([
    encodeVarInt(STATUS_PROTOCOL),
    encodeVarInt(hostBytes.length),
    hostBytes,
    portBytes,
    encodeVarInt(1)
  ]));
}

/**
 * The JSON text of a complete status response, or null while more bytes are
 * needed. Throws on a reply that is not a status response or is too large.
 */
export function readStatusReply(buffer: Buffer, maxBytes: number): string | null {
  const length = readVarInt(buffer);
  if (!length) return null;
  if (length.value <= 0 || length.value > maxBytes) throw new Error("status reply size is out of range");
  // The packet id comes first, so something that is not a status reply is refused without waiting for the rest.
  const early = readVarInt(buffer, length.size);
  if (early && early.value !== 0x00) throw new Error("not a status response");
  if (buffer.length < length.size + length.value) return null;
  const packet = buffer.subarray(length.size, length.size + length.value);
  const packetId = readVarInt(packet);
  if (!packetId || packetId.value !== 0x00) throw new Error("not a status response");
  const text = readVarInt(packet, packetId.size);
  if (!text || text.value < 0 || packetId.size + text.size + text.value > packet.length) throw new Error("status text is cut off");
  const start = packetId.size + text.size;
  return packet.subarray(start, start + text.value).toString("utf8");
}

/**
 * Player counts, version name and the server gate's state; fields that are
 * missing or malformed are left out. `off` means the gate refuses joins.
 */
export function parseStatusJson(text: string): Pick<ServerStatus, "players" | "version" | "sleep"> & { off?: true } {
  const status = JSON.parse(text) as unknown;
  if (!status || typeof status !== "object") throw new Error("status is not an object");
  const { players, version, bweeep } = status as { players?: { online?: unknown; max?: unknown }; version?: { name?: unknown }; bweeep?: { gate?: unknown } };
  const result: Pick<ServerStatus, "players" | "version" | "sleep"> & { off?: true } = {};
  if (isCount(players?.online) && isCount(players?.max)) result.players = { online: players.online, max: players.max };
  if (typeof version?.name === "string") {
    const name = version.name.replace(/§./g, "").trim().slice(0, 64);
    if (name) result.version = name;
  }
  const gate = bweeep && typeof bweeep === "object" ? bweeep.gate : undefined;
  if (gate === "sleeping" || gate === "starting") result.sleep = gate;
  if (gate === "off") result.off = true;
  return result;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
}
