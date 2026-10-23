import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { isProtectedInstallRoot, launchProtectedInstaller, prepareProtectedInstaller, PROTECTED_INSTALLER_COMMAND, verifyInstallerDescriptor } from "../dist/src/main/protected-installer.js";
import { UPDATE_CHUNK_SIZE, UPDATE_STORAGE_ROOT } from "../dist/src/main/file-update-manifest.js";
import { FILE_UPDATE_BROKER_COMMAND, startFileUpdateHelper } from "../dist/src/main/file-update-broker.js";

if (process.argv[2] === "--file-helper-lifetime-child") {
  assert.equal(process.platform, "win32");
  const [helper, plan, entry, receipt] = process.argv.slice(3);
  await fs.writeFile(plan, JSON.stringify({ parentPid: process.pid, entry, receipt }));
  await startFileUpdateHelper(helper, plan);
  process.exit(0);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-protected-installer-"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const payload = Buffer.alloc(UPDATE_CHUNK_SIZE + 17, 0x7b);
payload.write("synthetic installer fixture; never executable");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", SystemRoot: "C:\\Windows" };
const root = "C:\\Program Files\\Bweeep";
let checks = 0;
let nativePowerShellProof = null;
let nativeFileHelperProof = null;
function pass(name) { checks++; console.log(`PASS ${name}`); }
function descriptor(version = "0.1.40", arch = "x64", bytes = payload) {
  const signed = { schema: 1, version, arch, size: bytes.length, sha256: sha256(bytes), chunkSize: UPDATE_CHUNK_SIZE, chunks: Math.ceil(bytes.length / UPDATE_CHUNK_SIZE) };
  return { ...signed, signature: sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("base64") };
}
const manifest = descriptor();
const calls = [];
function fetchFixture(options = {}) {
  return async (url, init) => {
    calls.push(String(url));
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (String(url).endsWith("/x64.json")) return new Response(JSON.stringify(options.manifest ?? manifest));
    const part = Number(/part-(\d+)\.bin$/.exec(String(url))?.[1]);
    let bytes = payload.subarray(part * UPDATE_CHUNK_SIZE, (part + 1) * UPDATE_CHUNK_SIZE);
    if (options.missing) return new Response(null, { status: 404 });
    if (options.truncate) bytes = bytes.subarray(0, bytes.length - 1);
    if (options.oversize) bytes = Buffer.concat([bytes, Buffer.from([1])]);
    if (options.corrupt) { bytes = Buffer.from(bytes); bytes[0] ^= 1; }
    return new Response(bytes);
  };
}
const prepare = (extra = {}) => prepareProtectedInstaller({ version: "0.1.40", arch: "x64", publicKey: publicPem, stage: temporary,
  signal: new AbortController().signal, progress: () => {}, fetcher: fetchFixture(), ...extra });

// These children model the UAC acknowledgement protocol. The Windows-only negative
// regression below also executes real PowerShell, with an intentionally wrong hash.
function childFixture(action, capture) {
  return (executable, args, options) => {
    capture.executable = executable; capture.args = args; capture.options = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.unref = () => {}; child.kill = () => {};
    let input = "";
    child.stdin = new Writable({ write(chunk, _encoding, callback) { input += chunk.toString(); callback(); }, final(callback) {
      capture.input = JSON.parse(input); callback(); queueMicrotask(() => action(child));
    } });
    return child;
  };
}
const preparedWindows = { path: "C:\\Users\\Member\\AppData\\Roaming\\Bweeep\\installer.exe", sha256: manifest.sha256, version: "0.1.40", arch: "x64" };

try {
  for (const p of [root, "c:\\program files\\Bweeep", "C:\\Program Files (x86)\\Bweeep", "C:\\Program Files\\Bweeep\\inner"]) assert.equal(isProtectedInstallRoot(p, env), true);
  for (const p of ["C:\\Program Files Evil\\Bweeep", "C:\\Users\\Member\\Bweeep", "C:\\Program Files\\..\\Users\\Member", "D:\\Program Files\\Bweeep"]) assert.equal(isProtectedInstallRoot(p, env), false);
  assert.equal(isProtectedInstallRoot(root, {}), false);
  assert.equal(isProtectedInstallRoot("Bweeep", env), false);
  pass("program-files-boundaries-without-write-probes");

  assert.equal(verifyInstallerDescriptor(manifest, publicPem, "0.1.40", "x64").sha256, manifest.sha256);
  assert.equal(verifyInstallerDescriptor(descriptor("0.1.40-beta.3"), publicPem, "0.1.40-beta.3", "x64").version, "0.1.40-beta.3");
  pass("signed-stable-and-version-bound-beta-installer");

  for (const changed of [{ version: "0.1.41" }, { arch: "arm64" }, { size: -1 }, { size: 2_000_000_001 }, { chunkSize: 1 }, { chunks: 3 }, { sha256: "0".repeat(64) }, { signature: "invalid" }]) {
    assert.throws(() => verifyInstallerDescriptor({ ...manifest, ...changed }, publicPem, "0.1.40", "x64"));
  }
  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.throws(() => verifyInstallerDescriptor(manifest, otherKey, "0.1.40", "x64"));
  pass("reject-signature-key-version-architecture-and-length-tampering");

  const progress = [];
  const saved = await prepare({ progress: (received, total) => progress.push([received, total]) });
  assert.equal(sha256(await fs.readFile(saved.path)), manifest.sha256);
  assert.equal(progress[0][0], 0); assert.deepEqual(progress.at(-1), [payload.length, payload.length]);
  assert.equal(calls[0], `${UPDATE_STORAGE_ROOT}/installers/0.1.40/x64.json`);
  assert.ok(calls.every((url) => url.startsWith(UPDATE_STORAGE_ROOT) && !url.includes("/stable/") && !url.includes("github")));
  pass("download-all-parts-and-verify-complete-installer-before-exposure");

  for (const [kind, message] of [["missing", /받지 못/], ["truncate", /조각 크기/], ["oversize", /응답 크기/], ["corrupt", /검증에 실패/]]) {
    await assert.rejects(() => prepare({ fetcher: fetchFixture({ [kind]: true }) }), message);
  }
  assert.equal((await fs.readdir(temporary)).filter((f) => f.endsWith(".part")).length, 0);
  pass("reject-missing-truncated-oversized-corrupt-chunks-and-remove-temporaries");

  await assert.rejects(() => prepare({ fetcher: async () => new Response("x".repeat(16_385)) }), /응답 크기/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => prepare({ signal: controller.signal }), { name: "AbortError" });
  pass("bound-descriptor-size-and-propagate-abort");

  const accepted = {};
  let acknowledged = false;
  const pending = launchProtectedInstaller(preparedWindows, root, { environment: env, spawnProcess: childFixture((child) => {
    assert.equal(acknowledged, false);
    child.stdout.write("BWEEP_INSTALLER_STAR");
    queueMicrotask(() => child.stdout.write("TED\r\n"));
  }, accepted) }).then((result) => { acknowledged = true; return result; });
  assert.equal(acknowledged, false);
  assert.equal(await pending, "started");
  assert.equal(accepted.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(accepted.args.includes("-EncodedCommand"));
  assert.equal(Buffer.from(accepted.args.at(-1), "base64").toString("utf16le"), PROTECTED_INSTALLER_COMMAND);
  assert.equal(accepted.input.root, root); assert.equal(accepted.input.sha256, manifest.sha256);
  assert.equal(accepted.options.windowsHide, true);
  assert.equal(accepted.options.detached, false);
  pass("wait-for-uac-start-ack-never-process-spawn-alone");

  assert.equal(await launchProtectedInstaller(preparedWindows, root, { environment: env, spawnProcess: childFixture((child) => child.stdout.write("BWEEP_INSTALLER_CANCELLED\n"), {}) }), "cancelled");
  pass("uac-cancel-is-an-explicit-non-install-result");

  for (const action of [(child) => child.emit("close", 0), (child) => child.emit("error", new Error("spawn failed")), (child) => child.stdout.write("x".repeat(4097))]) {
    await assert.rejects(() => launchProtectedInstaller(preparedWindows, root, { environment: env, spawnProcess: childFixture(action, {}) }));
  }
  pass("missing-or-invalid-uac-ack-fails-closed");

  for (const invalidRoot of ["C:\\Users\\Member\\Bweeep", root + "\n", root + '"']) {
    await assert.rejects(() => launchProtectedInstaller(preparedWindows, invalidRoot, { environment: env, spawnProcess: () => { throw new Error("must not spawn"); } }));
  }
  assert.match(PROTECTED_INSTALLER_COMMAND, /FileShare\]::Read/);
  assert.match(PROTECTED_INSTALLER_COMMAND, /InputEncoding = \[Text.UTF8Encoding\]::new/);
  assert.ok(PROTECTED_INSTALLER_COMMAND.indexOf("ComputeHash($locked)") < PROTECTED_INSTALLER_COMMAND.indexOf("-Verb RunAs"));
  assert.match(PROTECTED_INSTALLER_COMMAND, /Start-Process -FilePath \$installer -Verb RunAs/);
  assert.ok(!PROTECTED_INSTALLER_COMMAND.includes("PlanPath") && !PROTECTED_INSTALLER_COMMAND.includes("Set-Acl"));
  assert.match(PROTECTED_INSTALLER_COMMAND, /\/S --updated --force-run \/allusers \/D=/);
  pass("only-nsis-elevates-with-locked-hash-and-fixed-existing-root");

  const publisher = path.resolve("scripts/publish-installer.mjs");
  const cleanEnvironment = { ...process.env }; delete cleanEnvironment.SUPABASE_SECRET_KEY;
  const beta = spawnSync(process.execPath, [publisher, "fixture.exe", "0.1.40-beta.3", "x64", "archive"], { encoding: "utf8", env: cleanEnvironment });
  assert.match(beta.stderr, /Supabase service key and update public key are required/);
  const betaStable = spawnSync(process.execPath, [publisher, "fixture.exe", "0.1.40-beta.3", "x64", "stable"], { encoding: "utf8", env: cleanEnvironment });
  assert.match(betaStable.stderr, /usage:/);
  const workflow = await fs.readFile(".github/workflows/release-on-main.yml", "utf8");
  assert.match(workflow, /publish-installer\.mjs "release-installer-beta\/Bweeep-Setup-\$env:BETA_VERSION\.exe" \$env:BETA_VERSION x64 archive/);
  assert.match(workflow, /publish-installer\.mjs "release-installer-beta-arm64\/Bweeep-Setup-\$env:BETA_VERSION-arm64\.exe" \$env:BETA_VERSION arm64 archive/);
  pass("archive-beta-installers-without-promoting-beta-to-stable");

  const helperWindows = "C:\\Users\\Member\\helper.ps1", planWindows = "C:\\Users\\Member\\plan.json";
  const brokerCapture = {};
  await startFileUpdateHelper(helperWindows, planWindows, { environment: env, spawnProcess: childFixture((child) => child.stdout.write("BWEEP_FILE_HELPER_STARTED:1234\n"), brokerCapture) });
  assert.equal(brokerCapture.options.detached, false);
  assert.equal(brokerCapture.options.windowsHide, true);
  assert.deepEqual(brokerCapture.input, { helper: helperWindows, plan: planWindows });
  assert.equal(Buffer.from(brokerCapture.args.at(-1), "base64").toString("utf16le"), FILE_UPDATE_BROKER_COMMAND);
  assert.ok(!FILE_UPDATE_BROKER_COMMAND.includes("-Verb"));
  for (const action of [(child) => child.emit("close", 0), (child) => { child.stdout.write("BWEEP_FILE_HELPER_STARTED:0\n"); child.emit("close", 0); }]) {
    await assert.rejects(() => startFileUpdateHelper(helperWindows, planWindows, { environment: env, spawnProcess: childFixture(action, {}) }));
  }
  await assert.rejects(() => startFileUpdateHelper(helperWindows + "\n", planWindows, { environment: env }));
  pass("writable-file-helper-requires-real-process-ack-without-uac");

  if (process.platform === "win32") {
    // Use an owned workspace fixture, never an actual installer or Program Files IO.
    // A known wrong hash MUST reach the PowerShell catch before Start-Process/RunAs.
    const fixtureParent = path.resolve("design");
    await fs.mkdir(fixtureParent, { recursive: true });
    const nativeTemporary = await fs.mkdtemp(path.join(fixtureParent, "protected-installer-native-"));
    assert.ok(path.resolve(nativeTemporary).startsWith(fixtureParent + path.sep));
    try {
      const koreanDirectory = path.join(nativeTemporary, "한글 사용자");
      await fs.mkdir(koreanDirectory);
      const fixture = path.join(koreanDirectory, "synthetic-installer.exe");
      const bytes = Buffer.from("Not a PE executable. This owned fixture must never execute.");
      await fs.writeFile(fixture, bytes, { flag: "wx" });
      assert.notEqual(sha256(bytes), "0".repeat(64));
      let nativeExit;
      let nativeOutput = "", nativeError = "";
      const forwardedSpawn = (executable, args, options) => {
        assert.equal(options.detached, false, "Windows PowerShell must actually execute before acknowledging the installer");
        assert.equal(options.windowsHide, true);
        const child = spawn(executable, args, options);
        nativeExit = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
        child.stdout.on("data", (data) => { nativeOutput += data.toString("utf8"); });
        child.stderr.on("data", (data) => { nativeError += data.toString("utf8"); });
        return child;
      };
      const protectedRoot = path.join(process.env.ProgramFiles, "Bweeep");
      await assert.rejects(() => launchProtectedInstaller({ path: fixture, sha256: "0".repeat(64), version: "0.1.40", arch: "x64" }, protectedRoot, { spawnProcess: forwardedSpawn }));
      assert.ok(nativeExit, "the production launch function must spawn real native PowerShell");
      const exit = await nativeExit;
      assert.equal(exit.code, 1, "silent exit 0 is not successful validation: the PowerShell body must run");
      assert.equal(exit.signal, null);
      assert.match(nativeError, /Installer could not start/);
      assert.ok(!nativeOutput.includes("BWEEP_INSTALLER_"), "hash rejection must not acknowledge UAC or installer execution");
      nativePowerShellProof = { exitCode: exit.code, signal: exit.signal, rejectionReported: true, acknowledgement: false };
      pass("native-hidden-powershell-executes-and-rejects-wrong-hash-without-uac");

      const markerHelper = path.join(koreanDirectory, "owned-marker-helper.ps1");
      const markerPlan = path.join(koreanDirectory, "owned-marker-plan.json");
      const entry = path.join(koreanDirectory, "entry.txt"), receipt = path.join(koreanDirectory, "after-parent-exit.json");
      await fs.writeFile(markerHelper, "param([string]$PlanPath)\n$ErrorActionPreference='Stop'\n$p=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8|ConvertFrom-Json\n[IO.File]::WriteAllText($p.entry,'entered')\n$deadline=[DateTime]::UtcNow.AddSeconds(10)\nwhile(Get-Process -Id $p.parentPid -ErrorAction SilentlyContinue){if([DateTime]::UtcNow -gt $deadline){throw 'parent did not exit'};Start-Sleep -Milliseconds 25}\n[IO.File]::WriteAllText($p.receipt,(@{parentDetectedAbsent=$true}|ConvertTo-Json))\n");
      const parentExit = await new Promise((resolve, reject) => {
        const parent = spawn(process.execPath, [process.argv[1], "--file-helper-lifetime-child", markerHelper, markerPlan, entry, receipt], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let error = "";
        parent.stderr.on("data", (bytes) => { error += bytes.toString("utf8"); });
        parent.once("error", reject);
        parent.once("close", (code) => resolve({ code, error }));
      });
      assert.equal(parentExit.code, 0, parentExit.error);
      let proof = null;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        try { proof = JSON.parse(await fs.readFile(receipt, "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(proof?.parentDetectedAbsent, true, "the actual broker's helper must execute after the launcher process has exited");
      assert.equal(await fs.readFile(entry, "utf8"), "entered");
      nativeFileHelperProof = { nodeParentExitCode: parentExit.code, parentDetectedAbsent: true, durableReceipt: true };
      pass("native-file-helper-broker-survives-node-parent-exit-without-app-launch");
    } finally {
      // nativeTemporary was resolved inside fixtureParent above and is exclusively test-owned.
      await fs.rm(nativeTemporary, { recursive: true, force: true });
    }
  }

  console.log(JSON.stringify({ checks, pass: true, nativePowerShellNegativeTest: process.platform === "win32", nativePowerShellProof, nativeFileHelperProof, scope: "network/child fixtures, Windows real PowerShell wrong-hash rejection and helper lifetime; actual UAC/NSIS installation remains unverified" }));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
