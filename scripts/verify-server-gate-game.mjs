#!/usr/bin/env node
// A real game client joining a sleeping server through the server gate: the
// join wakes the server, the game waits on "Logging in" longer than its
// 30-second timeout (the server's start is held back on purpose), gets in,
// and after it leaves the empty server is stopped. Uses the scenarios and the
// client harness of verify-server-auth.mjs, with offline accounts, under
// ~/.cache/bweeep-server-gate. Production servers are only read.
//
//   npm run build
//   node scripts/verify-server-gate-game.mjs scripts/server-auth-scenarios/vanilla-26.3.json
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServerGate } from "./server-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = new URL("./verify-server-auth.mjs", import.meta.url).href;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenario = JSON.parse(await fsp.readFile(process.argv[2], "utf8"));
const WORK = path.join(os.homedir(), ".cache", "bweeep-server-gate", scenario.name);
const LISTEN = scenario.port + 20;
const BACKEND = scenario.port + 21;
// Longer than the client's 30-second read timeout, so only the gate's wait queries keep it connected.
const START_DELAY_MS = Number(process.env.BWEEP_GATE_START_DELAY_MS ?? 40_000);
const IDLE_MS = 20_000;
const children = [];
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const readIfExists = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(500);
  }
  return false;
}
function spawnLogged(command, args, options, logFile) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", out, out] });
  try { fs.writeFileSync(`/proc/${child.pid}/oom_score_adj`, "1000"); } catch { /* best effort */ }
  children.push(child);
  return child;
}
const killGroup = (child, signal) => { try { process.kill(-child.pid, signal); } catch { /* gone */ } };

// ---- server copy, started and stopped only by the gate
const serverDir = path.join(WORK, "server");
await fsp.mkdir(WORK, { recursive: true });
execFileSync("rsync", ["-a", "--delete", ...(scenario.server.exclude ?? []).flatMap((item) => ["--exclude", item]), `${scenario.server.source}/`, `${serverDir}/`]);
const props = path.join(serverDir, "server.properties");
const values = {
  "server-port": BACKEND, "query.port": BACKEND, "server-ip": "127.0.0.1", "online-mode": false, "enforce-secure-profile": false,
  "white-list": false, "enforce-whitelist": false, "level-name": "world-gate-check", "view-distance": 4, "simulation-distance": 4,
  "enable-rcon": false, "max-players": 8, motd: "Bweeep gate check"
};
let text = readIfExists(props);
for (const [key, value] of Object.entries(values)) {
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text}\n${line}`;
}
await fsp.writeFile(props, text);
await fsp.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
await fsp.rm(path.join(serverDir, "logs"), { recursive: true, force: true });
const serverLog = () => readIfExists(path.join(serverDir, "logs", "latest.log"));

let serverProcess = null;
let wokeAt = 0;
const control = {
  start: async () => {
    wokeAt = Date.now();
    setTimeout(() => {
      serverProcess = spawnLogged(scenario.server.command[0], scenario.server.command.slice(1), { cwd: serverDir }, path.join(WORK, "server.out"));
      serverProcess.on("exit", () => { serverProcess = null; });
    }, START_DELAY_MS);
    return { ok: true };
  },
  stop: async () => {
    if (serverProcess) {
      const exited = new Promise((resolve) => serverProcess.once("exit", resolve));
      killGroup(serverProcess, "SIGTERM");
      await Promise.race([exited, sleep(120_000)]);
    }
    return { ok: true };
  },
  isActive: async () => serverProcess !== null || Date.now() - wokeAt < START_DELAY_MS + 5_000
};
const gateLines = [];
const gate = new ServerGate(
  { name: "gate check", unit: `gate-check-${scenario.name}`, listen: LISTEN, backend: BACKEND },
  { stateDir: path.join(WORK, "state"), control, log: (line) => { gateLines.push(`${new Date().toISOString()} ${line}`); console.log(`GATE ${line}`); }, timing: { idleMs: IDLE_MS } }
);

// ---- one real client, the same way verify-server-auth.mjs starts them
const clientRoot = path.join(WORK, "client");
async function startClient() {
  await fsp.rm(clientRoot, { recursive: true, force: true });
  const manifest = JSON.parse(await fsp.readFile(path.resolve(REPO, scenario.manifest), "utf8"));
  const instanceDir = path.join(clientRoot, "instances", manifest.id);
  await fsp.mkdir(path.join(instanceDir, ".bweeep", "runtime", "bin"), { recursive: true });
  const cache = process.env.BWEEP_CLIENT_CACHE ?? path.join(os.homedir(), ".cache", "bweeep-server-auth", scenario.name, "client-0", "instances", manifest.id);
  for (const shared of ["assets", "libraries", "versions"]) {
    const source = path.join(cache, shared);
    if (!fs.existsSync(source)) continue;
    try { execFileSync("cp", ["-al", source, instanceDir]); } catch { execFileSync("cp", ["-a", source, instanceDir]); }
  }
  fs.symlinkSync(scenario.clientJava, path.join(instanceDir, ".bweeep", "runtime", "bin", "java"));
  await fsp.writeFile(path.join(instanceDir, "options.txt"),
    "onboardAccessibility:false\nskipMultiplayerWarning:true\njoinedFirstServer:true\ntutorialStep:none\npauseOnLostFocus:false\nnarrator:0\n");
  const config = {
    manifest: { ...manifest, gameAuth: "offline", server: { host: "127.0.0.1", port: LISTEN } },
    manifestOverrides: scenario.manifestOverrides ?? {},
    clientSkipMods: scenario.clientSkipMods ?? [],
    instanceRoot: path.join(clientRoot, "instances"),
    identity: null,
    offlineName: "GateCheck",
    guardTarget: null,
    heapMb: scenario.clientHeapMb ?? 1536
  };
  const configPath = path.join(clientRoot, "client.json");
  await fsp.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  spawnLogged("Xvfb", [":181", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"], {}, path.join(clientRoot, "xvfb.log"));
  await sleep(1000);
  const appDir = path.join(clientRoot, "electron-app");
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "bweeep-gate-check-client", main: "main.cjs" }));
  await fsp.writeFile(path.join(appDir, "main.cjs"), `const { app } = require("electron");
app.whenReady().then(() => import(${JSON.stringify(HARNESS)})).catch((error) => { console.error(error); app.exit(1); });
`);
  return spawnLogged(path.join(REPO, "node_modules", ".bin", "electron"), ["--no-sandbox", `--user-data-dir=${path.join(clientRoot, "electron-data")}`, appDir], {
    env: { ...process.env, DISPLAY: ":181", BWEEP_AUTH_CHECK_CLIENT: configPath }
  }, path.join(clientRoot, "client.log"));
}
const clientLog = () => readIfExists(path.join(clientRoot, "client.log"));

try {
  await gate.listen();
  check("gate starts with the server asleep", gate.state === "down");
  const client = await startClient();
  const woke = await waitFor(() => wokeAt > 0, 600_000);
  check("the game's join wakes the server", woke);
  const joined = await waitFor(() => /GateCheck joined the game/.test(serverLog()) || clientLog().includes("GAME_EXIT"), 600_000);
  const heldMs = gateLines.find((line) => line.includes("handing a held join over")) ? Date.now() - wokeAt : 0;
  check("the held game gets in once the server is up", joined && /GateCheck joined the game/.test(serverLog()), `held about ${Math.round(heldMs / 1000)}s`);
  check("the hold outlasted the client's 30-second timeout", heldMs > 30_000);
  await sleep(10_000);
  check("the game stays in", !clientLog().includes("GAME_EXIT") && !/GateCheck lost connection/.test(serverLog()),
    clientLog().split("\n").filter((line) => /^(STAGE 서버|ERROR|GAME_EXIT)/.test(line)).join(" | "));
  killGroup(client, "SIGTERM");
  await sleep(3000);
  killGroup(client, "SIGKILL");
  const left = await waitFor(() => /GateCheck (left the game|lost connection)/.test(serverLog()), 30_000);
  check("the server sees the player leave", left);
  const stopped = await waitFor(() => gate.state === "down" && serverProcess === null, IDLE_MS + 150_000);
  check("the empty server is stopped after the idle time", stopped);
  const afterLeave = serverLog().split(/GateCheck left the game/).at(-1);
  check("the server stops cleanly, saving the world", /Stopping (the )?server/.test(afterLeave) && /Saving (worlds|chunks)|All (dimensions|chunks) are saved/.test(afterLeave));
} finally {
  await gate.close();
  for (const child of children.reverse()) { killGroup(child, "SIGTERM"); }
  await sleep(2000);
  for (const child of children) { killGroup(child, "SIGKILL"); }
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : "server gate with a real game: all checks passed");
process.exit(failed ? 1 : 0);
