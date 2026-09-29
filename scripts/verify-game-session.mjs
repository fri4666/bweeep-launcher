// Game token upkeep, refusal reporting and diagnostics masking in the main
// process. Run after `npm run build`.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDiagnosticsUrl, MAX_DIAGNOSTIC_LOG_BYTES, readLogTail, redactSecrets, tailText } from "../dist/src/main/diagnostics.js";
import { GameSessionWatch } from "../dist/src/main/game-session-watch.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ failure = null, extendFails = 0 } = {}) {
  const calls = { extend: [], lastFailure: [], reports: [], logs: [] };
  let failuresLeft = extendFails;
  const watch = new GameSessionWatch({
    intervalMs: 20,
    checkDelayMs: 10,
    extend: async (token) => {
      calls.extend.push(token);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("network down");
      }
    },
    lastFailure: async (since) => {
      calls.lastFailure.push(since);
      return failure;
    },
    report: (value) => calls.reports.push(value),
    log: (event) => calls.logs.push(event)
  });
  return { watch, calls };
}

// The token is extended on every interval while the game runs, and a failed
// extension is retried on the next one.
{
  const { watch, calls } = harness({ extendFails: 1 });
  watch.started("token-a", Date.parse("2026-09-30T00:00:00Z"));
  await sleep(75);
  assert.ok(calls.extend.length >= 3, `extended ${calls.extend.length} times`);
  assert.ok(calls.extend.every((token) => token === "token-a"));
  assert.ok(calls.logs.includes("launch.token.extend-failed") && calls.logs.includes("launch.token.extended"), "a failure is logged and the next try goes on");
  watch.observe({ kind: "info", stage: "선택 서버 입장", message: "접속됨" });
  watch.exited();
  const count = calls.extend.length;
  await sleep(60);
  assert.equal(calls.extend.length, count, "no extension after the game exits");
  assert.equal(calls.lastFailure.length, 0, "a run that got in asks nothing");
  assert.equal(calls.reports.length, 0);
}

// A run that never got in reports the recorded reason once.
{
  const failure = { reason: "token_expired", at: "2026-09-30T00:10:00Z" };
  const { watch, calls } = harness({ failure });
  watch.started("token-b", Date.parse("2026-09-30T00:00:00Z"));
  watch.observe({ kind: "error", stage: "서버 접속 실패", message: "서버가 접속을 거절했어요" });
  await sleep(30);
  assert.deepEqual(calls.reports, [failure], "the guard's refusal line brings the reason");
  assert.equal(calls.lastFailure[0], "2026-09-30T00:00:00.000Z", "only refusals since this run started count");
  watch.exited();
  await sleep(20);
  assert.equal(calls.reports.length, 1, "the same run does not report twice");
}

// Exiting without joining asks once; nothing recorded means nothing shown.
{
  const { watch, calls } = harness();
  watch.started("token-c");
  watch.exited();
  await sleep(20);
  assert.equal(calls.lastFailure.length, 1);
  assert.equal(calls.reports.length, 0);
}

// The connection opened, then closed and the game ended: the login may have
// been refused, so the run is asked once.
{
  const failure = { reason: "not_member", at: "2026-09-30T00:01:00Z" };
  const { watch, calls } = harness({ failure });
  watch.started("token-g");
  watch.observe({ kind: "info", stage: "선택 서버 입장", message: "접속됨" });
  watch.observe({ kind: "info", stage: "서버 연결 종료", message: "게임 끔" });
  watch.exited();
  await sleep(20);
  assert.equal(calls.lastFailure.length, 1);
  assert.deepEqual(calls.reports, [failure]);
}

// A launch that failed before the game ran stops the upkeep without asking.
{
  const { watch, calls } = harness({ failure: { reason: "not_member", at: "x" } });
  watch.started("token-d");
  watch.stop();
  watch.exited();
  await sleep(40);
  assert.equal(calls.extend.length, 0);
  assert.equal(calls.lastFailure.length, 0);
  // Progress from a run without a token is ignored.
  watch.observe({ kind: "error", stage: "서버 접속 실패", message: "x" });
  await sleep(20);
  assert.equal(calls.lastFailure.length, 0);
}

// A late answer from an old run is not shown over a new run.
{
  const { watch, calls } = harness({ failure: { reason: "token_revoked", at: "x" } });
  watch.started("token-e");
  watch.observe({ kind: "error", stage: "서버 접속 실패", message: "x" });
  watch.started("token-f");
  await sleep(30);
  assert.equal(calls.reports.length, 0);
  watch.stop();
}

// Masking before upload.
{
  const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU";
  const gameToken = "q3Zr8Xk2bT0vLmN9pQwE4sYhG7uJ1aFcD6eKiOoP5lA";
  const text = [
    `--username Seo_Py --version 26.3 --accessToken ${gameToken} --userType msa`,
    `"Authorization":"Bearer ${jwt}"`,
    `bwe-e-ep://auth/callback?code=abc123def456&sb_flow_id=ffee`,
    `C:\\Users\\서준\\AppData\\Roaming\\Bweeep\\instances\\vanilla\\logs\\latest.log`,
    `ticket=${gameToken}`,
    `BWEEP-0123456789AB-CDEF01234567`
  ].join("\n");
  const masked = redactSecrets(text);
  for (const secret of [jwt, gameToken, "abc123def456", "서준", "0123456789AB"]) assert.ok(!masked.includes(secret), `${secret} leaked: ${masked}`);
  for (const kept of ["--username Seo_Py", "--version 26.3", "AppData\\Roaming\\Bweeep"]) assert.ok(masked.includes(kept), `${kept} lost: ${masked}`);
  const hash = "sha512 " + "ab".repeat(64);
  assert.equal(redactSecrets(hash), hash, "hashes stay");
}

// Only the end of a big log is read, and it fits the server's limit.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-diag-"));
  const file = path.join(dir, "latest.log");
  await fs.writeFile(file, `${"가나다 old line\n".repeat(30_000)}--accessToken q3Zr8Xk2bT0vLmN9pQwE4sYhG7uJ1aFcD6eKiOoP5lA\nlast line`);
  const tail = await readLogTail(file);
  assert.ok(Buffer.byteLength(tail) <= MAX_DIAGNOSTIC_LOG_BYTES, `tail is ${Buffer.byteLength(tail)} bytes`);
  assert.ok(tail.endsWith("last line") && tail.startsWith("가나다 old line"), "the tail starts on a line and keeps the end");
  assert.ok(!tail.includes("q3Zr8Xk2bT0vLmN9pQwE4sYhG7uJ1aFcD6eKiOoP5lA"));
  assert.equal(await readLogTail(path.join(dir, "missing.log")), "");
  assert.equal(await readLogTail(null), "");
  assert.equal(tailText("short"), "short");
  await fs.rm(dir, { recursive: true, force: true });
}

// Only a signed diagnostics address may be opened.
assert.ok(isDiagnosticsUrl("https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/sign/launcher-diagnostics/0f8fad5b-d9cb-469f-a165-70867728950e.txt?token=abc"));
assert.ok(isDiagnosticsUrl("http://127.0.0.1:54321/storage/v1/object/sign/launcher-diagnostics/x.txt?token=abc"));
assert.ok(!isDiagnosticsUrl("http://evil.example/storage/v1/object/sign/launcher-diagnostics/x.txt?token=abc"));
assert.ok(!isDiagnosticsUrl("https://x.supabase.co/storage/v1/object/sign/launcher-skins/x.png?token=abc"));
assert.ok(!isDiagnosticsUrl("file:///C:/Windows/System32/calc.exe"));
assert.ok(!isDiagnosticsUrl("https://x.supabase.co/storage/v1/object/sign/launcher-diagnostics/x.txt"));

console.log("game session upkeep, refusal reports and diagnostics masking verified");
