import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { DISCORD_CLIENT_ID, DiscordPresence, decodeFrames, discordIpcPaths, encodeFrame } from "../dist/src/main/discord-presence.js";

// Discord Rich Presence against a fake Discord: a Unix socket speaking the
// same frames (op u32 LE, length u32 LE, JSON).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, timeout = 3_000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

class FakeDiscord {
  constructor(file) {
    this.file = file;
    this.connections = [];
    this.server = null;
  }
  async start() {
    await fsp.rm(this.file, { force: true });
    this.server = net.createServer((socket) => {
      const connection = { socket, frames: [], ended: false };
      this.connections.push(connection);
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        const { frames, rest } = decodeFrames(Buffer.concat([pending, chunk]));
        pending = rest;
        for (const frame of frames) {
          connection.frames.push(frame);
          if (frame.op === 0) socket.write(encodeFrame(1, { cmd: "DISPATCH", evt: "READY", data: { v: 1 }, nonce: null }));
        }
      });
      socket.on("end", () => { connection.ended = true; socket.end(); });
      socket.on("close", () => { connection.ended = true; });
      socket.on("error", () => undefined);
    });
    await new Promise((resolve) => this.server.listen(this.file, resolve));
  }
  async stop() {
    for (const connection of this.connections) connection.socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
  get last() { return this.connections.at(-1); }
  activities(connection = this.last) {
    return connection.frames.filter((frame) => frame.op === 1 && frame.payload?.cmd === "SET_ACTIVITY").map((frame) => frame.payload);
  }
}

// Frame encoding round trip, split across chunks.
const encoded = Buffer.concat([encodeFrame(1, { cmd: "A" }), encodeFrame(3, { n: 1 })]);
const partial = decodeFrames(encoded.subarray(0, 12));
assert.equal(partial.frames.length, 0);
const whole = decodeFrames(Buffer.concat([partial.rest, encoded.subarray(12)]));
assert.deepEqual(whole.frames, [{ op: 1, payload: { cmd: "A" } }, { op: 3, payload: { n: 1 } }]);
assert.equal(encoded.readUInt32LE(4), Buffer.byteLength(JSON.stringify({ cmd: "A" })));
assert.equal(discordIpcPaths("win32")[0], "\\\\?\\pipe\\discord-ipc-0");
assert.equal(discordIpcPaths("win32").length, 10);
const unixPaths = discordIpcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000" });
assert.equal(unixPaths[0], "/run/user/1000/discord-ipc-0");
assert.ok(unixPaths.includes("/tmp/discord-ipc-9"));
assert.match(DISCORD_CLIENT_ID, /^\d{17,20}$/);
console.log("discord-frames-and-paths=passed");

const dir = await fsp.mkdtemp(path.join(tmpdir(), "bweeep-discord-"));
const socketFile = path.join(dir, "discord-ipc-0");
const discord = new FakeDiscord(socketFile);
const options = { clientId: "123456789012345678", paths: () => [path.join(dir, "missing-ipc"), socketFile], retryMs: 150, pid: 4321 };
try {
  await discord.start();

  // No application id: never even connects.
  const off = new DiscordPresence({ ...options, clientId: "" });
  off.gameStarted("선릿벨리", 1_000);
  await sleep(250);
  assert.equal(discord.connections.length, 0, "an empty client id must not connect");
  off.dispose();

  // Only the launcher open: nothing shown, no connection.
  const presence = new DiscordPresence(options);
  await sleep(200);
  assert.equal(discord.connections.length, 0, "no connection while no game runs");

  // Game starts: handshake, then the activity.
  const startedAt = Date.now();
  presence.gameStarted("선릿벨리", startedAt);
  await until(() => discord.last && discord.activities().length === 1, "first activity");
  assert.deepEqual(discord.last.frames[0], { op: 0, payload: { v: 1, client_id: "123456789012345678" } });
  const [set] = discord.activities();
  assert.equal(typeof set.nonce, "string");
  assert.deepEqual(set.args, {
    pid: 4321,
    activity: { details: "선릿벨리", state: "붸에엡", timestamps: { start: startedAt }, assets: { large_image: "bweeep", large_text: "붸에엡" } }
  });

  // Discord pings; the launcher answers.
  discord.last.socket.write(encodeFrame(3, { ping: 7 }));
  await until(() => discord.last.frames.some((frame) => frame.op === 4), "pong");
  assert.deepEqual(discord.last.frames.find((frame) => frame.op === 4).payload, { ping: 7 });

  // Game ends: the activity is cleared and the connection closes.
  presence.gameStopped();
  await until(() => discord.activities().length === 2 && discord.last.ended, "clear and close");
  assert.equal(discord.activities()[1].args.activity, null);
  await sleep(300);
  assert.equal(discord.connections.length, 1, "no reconnect after the game ended");
  console.log("discord-presence-show-and-clear=passed");

  // Discord goes away mid-game: silent, then back within the retry interval.
  presence.gameStarted("바닐라 26.3", startedAt + 5);
  await until(() => discord.connections.length === 2 && discord.activities().length === 1, "second session");
  await discord.stop();
  await sleep(400);
  await discord.start();
  await until(() => discord.connections.length === 3 && discord.activities().length === 1, "reconnect after Discord came back");
  assert.equal(discord.activities()[0].args.activity.details, "바닐라 26.3");
  console.log("discord-presence-reconnects=passed");

  // Turning it off clears right away; turning it on while playing shows it again.
  presence.setEnabled(false);
  await until(() => discord.activities().length === 2 && discord.last.ended, "cleared when turned off");
  assert.equal(discord.activities()[1].args.activity, null);
  await sleep(300);
  assert.equal(discord.connections.length, 3, "no retry while turned off");
  presence.setEnabled(true);
  await until(() => discord.connections.length === 4 && discord.activities().length === 1, "shown again when turned on");
  presence.gameStopped();
  await until(() => discord.last.ended, "closed");
  presence.dispose();
  console.log("discord-presence-setting-toggle=passed");

  // Discord not running at all: no error, and it connects once Discord starts.
  await discord.stop();
  const late = new DiscordPresence(options);
  late.gameStarted("선릿벨리", startedAt);
  await sleep(350);
  const before = discord.connections.length;
  await discord.start();
  await until(() => discord.connections.length === before + 1 && discord.activities().length === 1, "connect after Discord starts");
  late.dispose();
  console.log("discord-presence-waits-for-discord=passed");
} finally {
  await discord.stop().catch(() => undefined);
  await fsp.rm(dir, { recursive: true, force: true });
}
