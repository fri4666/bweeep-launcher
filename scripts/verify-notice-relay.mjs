#!/usr/bin/env node
// Checks scripts/notice-relay.mjs without touching a real server or the real
// table: a fake REST endpoint serves "the current notice", fake RCON servers
// stand in for running game servers, and the real send path (rconCommand,
// buildNoticeCommand) runs against them.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { backoffDelay, createRelay, fetchCurrentNotice, loadServers, MAX_AGE_MS, POLL_MS } from "./notice-relay.mjs";

// Under ~/.cache rather than /tmp, which is memory-backed on the dev machine.
fs.mkdirSync(path.join(os.homedir(), ".cache"), { recursive: true });
const root = fs.mkdtempSync(path.join(os.homedir(), ".cache", "bweeep-notice-relay-check-"));
let passed = 0;
const cleanups = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.log(`FAIL ${name}\n  ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

/** A server speaking just enough RCON: login, then one command with a canned reply. */
function fakeRcon({ password, reply = "" }) {
  const received = [];
  const state = { reply };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const send = (id, type, body) => {
      const text = Buffer.from(body, "utf8");
      const out = Buffer.alloc(14 + text.length);
      out.writeInt32LE(10 + text.length, 0);
      out.writeInt32LE(id, 4);
      out.writeInt32LE(type, 8);
      text.copy(out, 12);
      socket.write(out);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0);
        const id = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + length - 2).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (type === 3) send(body === password ? id : -1, 2, "");
        else if (type === 2) {
          received.push(body);
          send(id, 0, state.reply);
        }
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const handle = { port: server.address().port, received, state, close: () => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }) };
    cleanups.push(handle.close);
    resolve(handle);
  }));
}

/** A gate folder with one config per unit; rconPort may be a port nobody listens on (a sleeping server). */
function gateDir(name, units) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  let next = 41000 + Math.floor(Math.random() * 15000);
  for (const unit of units) {
    fs.writeFileSync(path.join(dir, `${unit.name}.json`), JSON.stringify({
      stateDir: path.join(dir, "state"),
      servers: [{ name: unit.name, unit: unit.name, listen: next++, backend: next++, rcon: { port: unit.port, password: unit.password } }]
    }));
  }
  fs.writeFileSync(path.join(dir, "old.json.stale-1"), "not json at all");
  return dir;
}

function makeRelay({ dir, notice, now = () => 1_000_000_000_000, logs = [], stateName = "state.json" }) {
  const stateFile = path.join(root, `${path.basename(dir)}-${stateName}`);
  const relay = createRelay({ readNotice: async () => (typeof notice === "function" ? notice() : notice), gateDir: dir, stateFile, now, log: (line) => logs.push(line) });
  return { relay, stateFile, logs };
}
const noticeAt = (now, body, ageMs = 0, id = "n1") => ({ id, body, created_at: new Date(now - ageMs).toISOString() });
const NOW = 1_000_000_000_000;
const textOf = (command) => JSON.parse(command.slice("tellraw @a ".length)).with;

await check("a new notice is sent once as an info banner to a running server, and not again on the next poll", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("once", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, "서버 점검이 있어요") });
  assert.deepEqual((await relay.tick()).delivered, ["server-a"]);
  assert.deepEqual((await relay.tick()).delivered, []);
  assert.equal(a.received.length, 1);
  assert.match(a.received[0], /^tellraw @a \{/);
  assert.deepEqual(textOf(a.received[0]), ["info", "8", "서버 점검이 있어요"]);
});

await check("a restarted relay does not announce the same notice again", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("restart", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const notice = noticeAt(NOW, "다시 안 보내요");
  const first = makeRelay({ dir, notice });
  await first.relay.tick();
  const second = makeRelay({ dir, notice }); // new instance, same state file
  await second.relay.tick();
  assert.equal(a.received.length, 1);
});

await check("a notice older than 10 minutes is not sent, and the state remembers it was skipped", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("stale", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const logs = [];
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, "옛 공지", MAX_AGE_MS + 60_000), logs });
  await relay.tick();
  await relay.tick();
  assert.equal(a.received.length, 0);
  assert.equal(logs.filter((line) => line.includes("오래된")).length, 1, "logged once, not every poll");
});

await check("a server that is not running is skipped without error and is never contacted for a send", async () => {
  const asleep = await freePort(); // nothing listens: a sleeping server
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("asleep", [{ name: "server-sleeping", port: asleep, password: "password-zz1" }, { name: "server-a", port: a.port, password: "password-a1" }]);
  const { relay, logs } = makeRelay({ dir, notice: noticeAt(NOW, "깨어 있는 곳에만") });
  assert.deepEqual((await relay.tick()).delivered, ["server-a"]);
  assert.ok(!logs.some((line) => line.includes("server-sleeping")), "a sleeping server is skipped quietly");
});

await check("a server that wakes up while the notice is still fresh gets it later, once", async () => {
  const late = await freePort();
  const dir = gateDir("late", [{ name: "server-late", port: late, password: "password-l1" }]);
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, "나중에 깨어난 서버") });
  assert.deepEqual((await relay.tick()).delivered, []);
  const wake = { received: [] };
  fakeRconOn(late, "password-l1", wake); // the server comes up on the same port
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual((await relay.tick()).delivered, ["server-late"]);
  assert.deepEqual((await relay.tick()).delivered, []);
  assert.equal(wake.received.length, 1);
});

function fakeRconOn(port, password, handle) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const send = (id, type, body) => {
      const text = Buffer.from(body, "utf8");
      const out = Buffer.alloc(14 + text.length);
      out.writeInt32LE(10 + text.length, 0); out.writeInt32LE(id, 4); out.writeInt32LE(type, 8); text.copy(out, 12);
      socket.write(out);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readInt32LE(0)) {
        const length = buffer.readInt32LE(0), id = buffer.readInt32LE(4), type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + length - 2).toString("utf8");
        buffer = buffer.subarray(4 + length);
        if (type === 3) send(body === password ? id : -1, 2, "");
        else if (type === 2) { handle.received.push(body); send(id, 0, ""); }
      }
    });
    socket.on("error", () => {});
  });
  server.listen(port, "127.0.0.1");
  cleanups.push(() => new Promise((done) => { server.close(done); server.closeAllConnections?.(); }));
  return server;
}

await check("one server failing (wrong password) does not stop the others, and is retried next poll", async () => {
  const bad = await fakeRcon({ password: "the-real-password" });
  const good = await fakeRcon({ password: "password-g1" });
  const dir = gateDir("failing", [{ name: "server-bad", port: bad.port, password: "wrong-password" }, { name: "server-good", port: good.port, password: "password-g1" }]);
  const { relay, logs } = makeRelay({ dir, notice: noticeAt(NOW, "하나가 실패해도") });
  assert.deepEqual((await relay.tick()).delivered, ["server-good"]);
  assert.ok(logs.some((line) => line.startsWith("server-bad: 실패")));
  assert.equal(good.received.length, 1);
  assert.deepEqual((await relay.tick()).delivered, [], "the good one is not repeated; the bad one just fails again");
});

await check("'no player was found' counts as not delivered, so a player who joins soon still sees it", async () => {
  const a = await fakeRcon({ password: "password-a1", reply: "No player was found" });
  const dir = gateDir("empty", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, "빈 서버") });
  assert.deepEqual((await relay.tick()).delivered, []);
  a.state.reply = ""; // a player is on now
  assert.deepEqual((await relay.tick()).delivered, ["server-a"]);
  assert.deepEqual((await relay.tick()).delivered, []);
  assert.equal(a.received.length, 2);
});

await check("clearing the notice sends nothing; the next notice is sent", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("clear", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  let current = noticeAt(NOW, "첫 공지", 0, "n1");
  const { relay } = makeRelay({ dir, notice: () => current });
  await relay.tick();
  current = null; // cleared
  assert.deepEqual((await relay.tick()).delivered, []);
  assert.equal(a.received.length, 1);
  current = noticeAt(NOW, "둘째 공지", 0, "n2");
  assert.deepEqual((await relay.tick()).delivered, ["server-a"]);
  assert.deepEqual(textOf(a.received[1]), ["info", "8", "둘째 공지"]);
});

await check("the text is sanitised and cut to 100 characters like the mod does", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("text", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, `§c빨강§r\n${"가".repeat(150)}`) });
  await relay.tick();
  const [, , text] = textOf(a.received[0]);
  assert.equal(Array.from(text).length, 100);
  assert.ok(text.startsWith("빨강 가") && text.endsWith("…") && !text.includes("§"));
});

await check("a failed read of the table does not throw, counts failures, and backs off", async () => {
  const dir = gateDir("rest-error", []);
  let broken = true;
  const { relay, logs } = makeRelay({ dir, notice: () => { if (broken) throw new Error("HTTP 503"); return null; } });
  assert.equal((await relay.tick()).ok, false);
  assert.equal((await relay.tick()).ok, false);
  assert.equal(relay.failures, 2);
  assert.ok(backoffDelay(2) > backoffDelay(1) && backoffDelay(1) > POLL_MS);
  assert.ok(backoffDelay(50) <= 5 * 60_000);
  assert.equal(backoffDelay(0), POLL_MS);
  broken = false;
  assert.equal((await relay.tick()).ok, true);
  assert.equal(relay.failures, 0);
  assert.ok(logs.some((line) => line.includes("다시 됩니다")));
});

await check("a damaged state file is treated as empty and rewritten", async () => {
  const a = await fakeRcon({ password: "password-a1" });
  const dir = gateDir("badstate", [{ name: "server-a", port: a.port, password: "password-a1" }]);
  const { relay, stateFile } = makeRelay({ dir, notice: noticeAt(NOW, "상태 파일이 깨졌어도") });
  fs.writeFileSync(stateFile, "{ not json");
  assert.deepEqual((await relay.tick()).delivered, ["server-a"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(stateFile, "utf8")).notices), ["n1"]);
});

await check("neither the service key nor an RCON password ever reaches the log", async () => {
  const a = await fakeRcon({ password: "super-secret-rcon-pw" });
  const bad = await fakeRcon({ password: "another-secret-pw" });
  const dir = gateDir("secrets", [{ name: "server-a", port: a.port, password: "super-secret-rcon-pw" }, { name: "server-bad", port: bad.port, password: "wrong-wrong-pw" }]);
  const logs = [];
  const { relay } = makeRelay({ dir, notice: noticeAt(NOW, "비밀 확인"), logs });
  await relay.tick();
  const joined = logs.join("\n");
  for (const secret of ["super-secret-rcon-pw", "another-secret-pw", "wrong-wrong-pw"]) assert.ok(!joined.includes(secret), `${secret} must not appear`);
});

await check("the table read sends the service key as headers only and asks for the one shown notice", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, apikey: request.headers.apikey, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ id: "n9", body: "hello", created_at: new Date().toISOString() }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const notice = await fetchCurrentNotice({ url, key: "service-key-value" });
  assert.equal(notice.id, "n9");
  assert.match(requests[0].url, /^\/rest\/v1\/launcher_notices\?ended_at=is\.null&select=id,body,created_at/);
  assert.ok(!requests[0].url.includes("service-key-value"), "the key is never put in the URL");
  assert.equal(requests[0].apikey, "service-key-value");
  assert.equal(requests[0].authorization, "Bearer service-key-value");
  server.closeAllConnections?.();
  server.close();
  const failing = http.createServer((request, response) => { response.statusCode = 500; response.end("nope"); });
  await new Promise((resolve) => failing.listen(0, "127.0.0.1", resolve));
  await assert.rejects(fetchCurrentNotice({ url: `http://127.0.0.1:${failing.address().port}`, key: "k" }), /HTTP 500/);
  failing.closeAllConnections?.();
  failing.close();
  const empty = http.createServer((request, response) => { response.end("[]"); });
  await new Promise((resolve) => empty.listen(0, "127.0.0.1", resolve));
  assert.equal(await fetchCurrentNotice({ url: `http://127.0.0.1:${empty.address().port}`, key: "k" }), null);
  empty.closeAllConnections?.();
  empty.close();
});

await check("only *.json gate files are read; stale copies and broken files are skipped", async () => {
  const dir = path.join(root, "loadservers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ stateDir: "/tmp/x", servers: [{ unit: "unit-a", listen: 1111, backend: 1112, rcon: { port: 1113, password: "password-a1" } }, { unit: "no-rcon", listen: 1114, backend: 1115 }] }));
  fs.writeFileSync(path.join(dir, "a.json.stale-25577"), JSON.stringify({ stateDir: "/tmp/x", servers: [{ unit: "stale", listen: 2, backend: 3, rcon: { port: 4, password: "password-s1" } }] }));
  fs.writeFileSync(path.join(dir, "broken.json"), "{");
  const logs = [];
  const servers = loadServers(dir, (line) => logs.push(line));
  assert.deepEqual(servers.map((server) => server.unit), ["unit-a"]);
  assert.ok(logs.some((line) => line.includes("broken.json")));
  assert.ok(!logs.join("\n").includes("password-a1"));
});

for (const cleanup of cleanups) await cleanup().catch(() => {});
fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} checks passed`);
