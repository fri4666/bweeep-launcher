#!/usr/bin/env node
// Checks scripts/bweeep-notify.mjs without touching any server: the message it
// builds, its text rules (the same as the mod's NoticeText), the gate-file
// lookup, and the real send path against a fake RCON server in this process.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNoticeCommand, loadRcon, normalizeSeconds, sanitizeText, MAX_TEXT, NOTICE_KEY } from "./bweeep-notify.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "bweeep-notify.mjs");
let passed = 0;
const check = (name, fn) => {
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(() => ok(name), (error) => fail(name, error));
    ok(name);
  } catch (error) {
    fail(name, error);
  }
};
const ok = (name) => { passed += 1; console.log(`PASS ${name}`); };
const fail = (name, error) => { console.log(`FAIL ${name}\n  ${error.message}`); process.exitCode = 1; };
const cps = (text) => Array.from(text).length;

// ---- message format
check("command is tellraw with the notice key, a fallback and level/seconds/text", () => {
  const { command } = buildNoticeCommand({ level: "warning", seconds: 8, text: "서버를 곧 재시작합니다" });
  assert.match(command, /^tellraw @a \{/);
  assert.ok(/^[\x20-\x7e]+$/.test(command), "pure ASCII");
  const component = JSON.parse(command.slice("tellraw @a ".length));
  assert.equal(component.translate, NOTICE_KEY);
  assert.equal(component.fallback, "[공지] %3$s");
  assert.deepEqual(component.with, ["warning", "8", "서버를 곧 재시작합니다"]);
});
check("the default length is sent as 0 (the mod picks 5 s)", () => {
  const component = JSON.parse(buildNoticeCommand({ level: "info", text: "hi" }).command.slice(11));
  assert.equal(component.with[1], "0");
});
check("an emoji survives the escaping", () => {
  const component = JSON.parse(buildNoticeCommand({ level: "success", text: "good \u{1F600}" }).command.slice(11));
  assert.equal(component.with[2], "good \u{1F600}");
});
check("quotes and backslashes cannot break out of the JSON", () => {
  const component = JSON.parse(buildNoticeCommand({ level: "info", text: 'say "hi" \\ {"x":1}' }).command.slice(11));
  assert.equal(component.with[2], 'say "hi" \\ {"x":1}');
});
check("a bad level or an empty text is refused", () => {
  assert.throws(() => buildNoticeCommand({ level: "warn", text: "x" }), /등급/);
  assert.throws(() => buildNoticeCommand({ level: "info", text: " §a " }), /비어/);
});

// ---- text rules, mirrored from NoticeText
check("sanitize drops formatting codes, control and invisible characters and collapses spaces", () => {
  assert.equal(sanitizeText("§cred§r text"), "red text");
  assert.equal(sanitizeText("a\n\tb\r\n  c"), "a b c");
  assert.equal(sanitizeText("a​b‮"), "ab");
  assert.equal(sanitizeText("a\u0000b\u0007"), "ab");
  assert.equal(sanitizeText("  trailing  "), "trailing");
  assert.equal(sanitizeText("end§"), "end");
});
check(`text over ${MAX_TEXT} characters is cut to exactly ${MAX_TEXT} with an ellipsis`, () => {
  const cut = sanitizeText("a".repeat(250));
  assert.equal(cps(cut), MAX_TEXT);
  assert.equal(cut, `${"a".repeat(99)}…`);
  const emoji = sanitizeText("\u{1F600}".repeat(150));
  assert.equal(cps(emoji), MAX_TEXT);
  assert.equal(sanitizeText("가".repeat(MAX_TEXT)), "가".repeat(MAX_TEXT));
  assert.equal(buildNoticeCommand({ level: "info", text: "b".repeat(300) }).truncated, true);
  assert.equal(buildNoticeCommand({ level: "info", text: "short" }).truncated, false);
});
check("seconds are rounded into the 2-30 range; nonsense is refused", () => {
  assert.equal(normalizeSeconds(undefined), 0);
  assert.equal(normalizeSeconds("0.4"), 2);
  assert.equal(normalizeSeconds("7.6"), 8);
  assert.equal(normalizeSeconds("999"), 30);
  assert.throws(() => normalizeSeconds("abc"), /--seconds/);
  assert.throws(() => normalizeSeconds("-1"), /--seconds/);
});

// ---- gate file and the real send path
const work = fs.mkdtempSync(path.join(os.homedir(), ".cache", "bweeep-notify-sender-"));
const password = "secret-pw-1234567890";
const received = [];
const fakeRcon = net.createServer((socket) => {
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
        send(id, 0, "");
      }
    }
  });
});
await new Promise((resolve) => fakeRcon.listen(0, "127.0.0.1", resolve));
const rconPort = fakeRcon.address().port;
const gateDir = path.join(work, "gate");
fs.mkdirSync(gateDir);
fs.writeFileSync(path.join(gateDir, "notify-test.json"), JSON.stringify({
  stateDir: path.join(work, "state"),
  servers: [{ name: "알림 시험", unit: "notify-test", listen: 41000, backend: 41001, rcon: { port: rconPort, password } }]
}), { mode: 0o600 });
fs.writeFileSync(path.join(gateDir, "no-rcon.json"), JSON.stringify({
  stateDir: path.join(work, "state"), servers: [{ name: "x", unit: "no-rcon", listen: 41002, backend: 41003 }]
}));

// Asynchronous on purpose: the fake RCON server lives in this process and must keep answering.
const run = (...args) => new Promise((resolve) => {
  execFile("node", [SCRIPT, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout}${stderr}` });
  });
});

check("loadRcon reads the gate file and refuses unsafe or incomplete ones", () => {
  assert.equal(loadRcon("notify-test", gateDir).port, rconPort);
  assert.throws(() => loadRcon("../etc", gateDir), /유닛 이름/);
  assert.throws(() => loadRcon("missing", gateDir), /게이트 설정이 없습니다/);
  assert.throws(() => loadRcon("no-rcon", gateDir), /RCON/);
});
await check("dry-run prints the command, sends nothing and never prints the password", async () => {
  const before = received.length;
  const result = await run("notify-test", "info", "점검 안내", "--gate-dir", gateDir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /dry-run/);
  assert.match(result.out, /tellraw @a/);
  assert.ok(!result.out.includes(password), "password leaked");
  assert.equal(received.length, before);
});
await check("--send delivers exactly the built command over RCON and hides the password", async () => {
  const result = await run("notify-test", "urgent", "5분 뒤 재시작합니다", "--seconds", "10", "--send", "--gate-dir", gateDir);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /보냈습니다/);
  assert.ok(!result.out.includes(password), "password leaked");
  assert.equal(received.length, 1);
  assert.equal(received[0], buildNoticeCommand({ level: "urgent", seconds: 10, text: "5분 뒤 재시작합니다" }).command);
});
await check("--send to a dead port fails with a non-zero exit code", async () => {
  const dead = path.join(work, "dead");
  fs.mkdirSync(dead);
  fs.writeFileSync(path.join(dead, "gone.json"), JSON.stringify({
    stateDir: path.join(work, "state"), servers: [{ name: "gone", unit: "gone", listen: 41010, backend: 41011, rcon: { port: 41012, password } }]
  }));
  const result = await run("gone", "info", "hi", "--send", "--gate-dir", dead);
  assert.equal(result.code, 1);
  assert.match(result.out, /보내지 못했습니다/);
});
await check("usage errors exit non-zero", async () => {
  assert.equal((await run("notify-test", "info", "--gate-dir", gateDir)).code, 1);
  assert.equal((await run("notify-test", "loud", "x", "--gate-dir", gateDir)).code, 1);
  assert.equal((await run("--help")).code, 0);
});

fakeRcon.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ", with failures" : " - ALL PASS"}`);
