import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

// "Playing" status on Discord through the local Discord client's IPC socket,
// without a library: each frame is an op code and a length (both u32 little
// endian) followed by JSON. It shows only while a game runs, and when Discord
// is closed or goes away the launcher quietly retries every 30 seconds.

/** The Bweeep application on the Discord developer portal. Empty turns the feature off. */
export const DISCORD_CLIENT_ID = "1554357569844285484";

const RETRY_MS = 30_000;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_FRAME_BYTES = 64 * 1024;

const OP = { handshake: 0, frame: 1, close: 2, ping: 3, pong: 4 } as const;

export interface DiscordFrame {
  op: number;
  payload: unknown;
}

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

/** Whole frames at the start of `buffer`, and the bytes of an unfinished one. */
export function decodeFrames(buffer: Buffer): { frames: DiscordFrame[]; rest: Buffer } {
  const frames: DiscordFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    const op = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    if (length > MAX_FRAME_BYTES) throw new Error("Discord frame too large");
    if (buffer.length - offset - 8 < length) break;
    const body = buffer.subarray(offset + 8, offset + 8 + length).toString("utf8");
    let payload: unknown = null;
    try {
      payload = JSON.parse(body);
    } catch {
      // A frame we cannot read is skipped; the next one may still be fine.
    }
    frames.push({ op, payload });
    offset += 8 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** Where a running Discord client listens, in the order Discord's own SDK tries them. */
export function discordIpcPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const numbers = Array.from({ length: 10 }, (_, index) => index);
  if (platform === "win32") return numbers.map((index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  const bases = [...new Set([env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, "/tmp"].filter((base): base is string => Boolean(base)))];
  // Flatpak and Snap builds of Discord put the socket one folder deeper.
  const dirs = bases.flatMap((base) => [base, path.join(base, "app", "com.discordapp.Discord"), path.join(base, "snap.discord")]);
  return dirs.flatMap((dir) => numbers.map((index) => path.join(dir, `discord-ipc-${index}`)));
}

export interface DiscordPresenceOptions {
  clientId?: string;
  paths?: () => string[];
  retryMs?: number;
  pid?: number;
}

interface Playing {
  server: string;
  startedAt: number;
}

export class DiscordPresence {
  private readonly clientId: string;
  private readonly paths: () => string[];
  private readonly retryMs: number;
  private readonly pid: number;
  private enabled = true;
  private playing: Playing | null = null;
  private socket: net.Socket | null = null;
  private connecting = false;
  private ready = false;
  private sent: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(options: DiscordPresenceOptions = {}) {
    this.clientId = options.clientId ?? DISCORD_CLIENT_ID;
    this.paths = options.paths ?? (() => discordIpcPaths());
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.pid = options.pid ?? process.pid;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.sync();
  }

  gameStarted(server: string, startedAt: number): void {
    this.playing = { server, startedAt };
    this.sync();
  }

  gameStopped(): void {
    this.playing = null;
    this.sync();
  }

  dispose(): void {
    this.playing = null;
    this.stopRetry();
    this.socket?.destroy();
  }

  private wanted(): Playing | null {
    return this.clientId && this.enabled ? this.playing : null;
  }

  private sync(): void {
    if (!this.clientId) return;
    const wanted = this.wanted();
    if (wanted) {
      if (this.ready) this.send(wanted);
      else void this.connect();
      return;
    }
    this.stopRetry();
    const socket = this.socket;
    if (!socket) return;
    // Cleared first, then the connection closes; Discord drops it either way.
    if (this.ready) this.send(null);
    this.socket = null;
    this.ready = false;
    this.sent = null;
    socket.end();
    setTimeout(() => socket.destroy(), 1_000).unref();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.socket) return;
    this.connecting = true;
    let socket: net.Socket | null = null;
    for (const candidate of this.paths()) {
      socket = await openSocket(candidate);
      if (socket) break;
    }
    this.connecting = false;
    if (!socket) {
      this.scheduleRetry();
      return;
    }
    if (!this.wanted()) {
      socket.destroy();
      return;
    }
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    this.socket = socket;
    this.ready = false;
    this.sent = null;
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      try {
        const { frames, rest } = decodeFrames(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const frame of frames) this.onFrame(socket, frame);
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.sent = null;
      this.scheduleRetry();
    });
    socket.write(encodeFrame(OP.handshake, { v: 1, client_id: this.clientId }));
  }

  private onFrame(socket: net.Socket, frame: DiscordFrame): void {
    // A connection already let go of may still deliver a frame or two.
    if (this.socket !== socket) return;
    if (frame.op === OP.ping) {
      socket.write(encodeFrame(OP.pong, frame.payload));
      return;
    }
    if (frame.op === OP.close) {
      socket.destroy();
      return;
    }
    const message = frame.payload as { cmd?: unknown; evt?: unknown } | null;
    if (frame.op === OP.frame && message?.cmd === "DISPATCH" && message.evt === "READY") {
      this.ready = true;
      const wanted = this.wanted();
      if (wanted) this.send(wanted);
      else socket.end();
    }
  }

  private send(playing: Playing | null): void {
    const activity = playing && {
      details: playing.server,
      state: "붸에엡",
      timestamps: { start: playing.startedAt },
      assets: { large_image: "bweeep", large_text: "붸에엡" }
    };
    const key = JSON.stringify(activity);
    if (!this.socket || key === this.sent) return;
    this.sent = key;
    this.socket.write(encodeFrame(OP.frame, { cmd: "SET_ACTIVITY", args: { pid: this.pid, activity }, nonce: randomUUID() }));
  }

  private scheduleRetry(): void {
    if (this.retryTimer || !this.wanted()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted() && !this.socket) void this.connect();
    }, this.retryMs);
    this.retryTimer.unref();
  }

  private stopRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function openSocket(target: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(target);
    const fail = () => {
      socket.destroy();
      resolve(null);
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    socket.once("error", () => {
      clearTimeout(timer);
      fail();
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socket);
    });
  });
}
