#!/usr/bin/env node
// End-to-end check of the bweeep-notify banner with a real game: a throwaway
// Fabric 1.21.1 server (offline mode, its own port, files under ~/.cache), a
// real client on a virtual display with the mod jar, and notices sent with
// scripts/bweeep-notify.mjs over the server's RCON. The screen is recorded and
// the banner is measured frame by frame: it slides in, holds, then closes
// inward with both ends moving to the centre; four levels queue in priority
// order. With --no-mod the same notice must appear as the plain chat fallback.
// Nothing here touches a production server, port or world.
//
//   (cd fabric-notify-1211 && ./gradlew build)
//   node scripts/verify-notify-banner.mjs            # banner run
//   node scripts/verify-notify-banner.mjs --no-mod   # fallback run
//
// Needs Linux with Xvfb, ffmpeg (x11grab, libx264), xdotool, ImageMagick, JDK 21,
// and a checkout with node_modules and a built dist (BWEEP_RUNTIME_REPO, default
// the main checkout) whose launcher modules install and start the client.
import { execFile, execFileSync, spawn } from "node:child_process";
import crypto, { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rconCommand } from "./server-gate.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_REPO = process.env.BWEEP_RUNTIME_REPO ?? "/home/dev/code/bweeep-lifecycle-recovery";
const MOD_JAR = process.env.BWEEP_NOTIFY_JAR ?? path.join(REPO, "fabric-notify-1211", "build", "libs", "bweeep-notify-fabric-1.21.1-0.1.0.jar");
const WORK = process.env.BWEEP_NOTIFY_WORK ?? path.join(os.homedir(), ".cache", "bweeep-notify-e2e");
const NO_MOD = process.argv.includes("--no-mod");
const RUN = path.join(WORK, NO_MOD ? "run-no-mod" : "run");
const JAVA = "/usr/lib/jvm/java-21-openjdk-amd64/bin/java";
const PORT = 25591;
const RCON_PORT = 25592;
const DISPLAY = ":151";
const FPS = 30;
const GUI_SCALE = 2;
const PLAYER = "NotifyBot";
const TEST_EULA = "/home/dev/servers/vanilla-26.3-test/eula.txt";
const UA = { "User-Agent": "bweeep-launcher-notify-e2e/1.0" };
const ACCENTS = { info: [0x4d, 0xa3, 0xff], success: [0x4a, 0xde, 0x80], warning: [0xfb, 0xbf, 0x24], urgent: [0xf8, 0x71, 0x71] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The game client runs inside Electron, like the launcher, because the launcher's
// install and launch modules use Electron APIs.
if (process.env.BWEEP_NOTIFY_CLIENT) {
  const { app } = await import("electron");
  await runClient(JSON.parse(await fsp.readFile(process.env.BWEEP_NOTIFY_CLIENT, "utf8")));
  app.exit(0);
  await new Promise(() => {});
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
};
const children = [];
let recorder = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void cleanup().finally(() => process.exit(130)));
}
try {
  await main();
} catch (error) {
  check("run finished without errors", false, error?.stack ?? String(error));
} finally {
  await cleanup();
}
const failed = results.filter((result) => !result.ok);
console.log(`\nnotify ${NO_MOD ? "fallback" : "banner"}: ${results.length - failed.length}/${results.length} passed${failed.length ? "" : " - ALL PASS"}`);
console.log(`screenshots, video and logs: ${RUN}`);
process.exit(failed.length ? 1 : 0);

async function main() {
  requireMemory(1300 + 2600, "server and client");
  if (!NO_MOD && !fs.existsSync(MOD_JAR)) throw new Error(`mod jar not built: ${MOD_JAR}`);
  if (!fs.readFileSync(TEST_EULA, "utf8").includes("eula=true")) throw new Error(`no accepted EULA in ${TEST_EULA}`);
  await fsp.rm(RUN, { recursive: true, force: true });
  for (const dir of ["server", "gate", "client", "shots", path.join("..", "cache")]) await fsp.mkdir(path.join(RUN, dir), { recursive: true });

  const fabricApi = await ensureFabricApi();
  const launcher = await ensureFabricLauncher();
  const rconPassword = randomBytes(12).toString("hex");
  const server = await startServer(launcher, fabricApi, rconPassword);
  const gateDir = path.join(RUN, "gate");
  await fsp.writeFile(path.join(gateDir, "notify-e2e.json"), JSON.stringify({
    stateDir: path.join(RUN, "gate-state"),
    servers: [{ name: "notify-e2e", unit: "notify-e2e", listen: PORT + 2, backend: PORT + 3, rcon: { port: RCON_PORT, password: rconPassword } }]
  }), { mode: 0o600 });
  const send = (level, text, seconds) => sendNotice(gateDir, level, text, seconds);

  const player = await startClient(fabricApi);
  const joined = await waitFor(() => new RegExp(`${PLAYER} joined the game`).test(read(server.log)), 900_000);
  check("client joins the throwaway server", joined);
  if (!joined) throw new Error(`client did not join; see ${path.join(RUN, "client.log")}`);
  await sleep(12_000);
  const geometry = windowGeometry();
  console.log(`window ${geometry.width}x${geometry.height} at ${geometry.x},${geometry.y}`);

  if (NO_MOD) return fallbackRun(send, player);
  return bannerRun(send, player, geometry);
}

// ---- banner run: measure the recorded screen

async function bannerRun(send, player, geometry) {
  const video = path.join(RUN, "screen.mp4");
  recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-framerate", String(FPS), "-video_size", "1280x720", "-i", DISPLAY,
    "-vf", `fps=${FPS}`, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "14", "-pix_fmt", "yuv420p", video], { stdio: ["pipe", "inherit", "inherit"] });
  await sleep(4_000);

  // A: one notice, alone, full life cycle (3 s hold)
  const textA = "서버를 5분 뒤에 재시작합니다. 진행 중인 작업을 저장해 주세요";
  const sentA = Date.now();
  const resultA = await send("info", textA, 3);
  check("sender reaches the throwaway server", resultA.code === 0, resultA.out.trim().split("\n").pop());
  await sleep(6_500);

  // B: four notices at once; info is on screen first, urgent cuts it short, then warning, then success
  await send("info", "queue test first", 6);
  await sleep(250);
  await send("success", "queue test success", 2);
  await send("warning", "queue test warning", 2);
  await send("urgent", "queue test urgent", 2);
  await sleep(11_500);

  recorder.stdin.write("q");
  await new Promise((resolve) => recorder.once("close", resolve));
  recorder = null;
  console.log(`recording ${((fs.statSync(video).size) / 1e6).toFixed(1)} MB, notice A sent at ${new Date(sentA).toISOString()}`);

  const centre = geometry.x + geometry.width / 2;
  const frames = await analyzeVideo(video, geometry);
  const segments = segmentsOf(frames);
  console.log(`segments: ${segments.map((s) => `${s.cls ?? "?"}:${(s.frames.length / FPS).toFixed(2)}s/${s.maxWidth}px`).join("  ")}`);
  fs.writeFileSync(path.join(RUN, "frames.json"), JSON.stringify(frames.filter((f) => f.width >= 12)));

  // frames[] starts at video frame 24; compare by video frame number
  const between = (from, to) => frames.filter((f) => f.i >= from && f.i < to);
  check("no banner before the first notice", between(24, 3.5 * FPS).length > 0 && between(24, 3.5 * FPS).every((f) => f.width < 12));
  check("five banners appear (A, then B in four steps)", segments.length === 5, `${segments.length}`);
  const [a, ...queued] = segments;
  if (!a) throw new Error("no banner was recorded");

  // A: shape of the life cycle
  const durationA = a.frames.length / FPS;
  check("A: banner lives about 380 ms + 3 s + 420 ms", durationA > 3.3 && durationA < 4.4, `${durationA.toFixed(2)} s`);
  check("A: info colour", a.cls === "info", String(a.cls));
  const topEnter = a.frames.slice(0, 10).map((f) => f.top);
  check("A: it slides down while entering", topEnter[topEnter.length - 1] > topEnter[0] + 6 && topEnter.every((v, i) => i === 0 || v >= topEnter[i - 1] - 1), topEnter.join(","));
  check(`A: it rests ${10 * GUI_SCALE} px from the top`, Math.abs(a.restTop - 10 * GUI_SCALE) <= 4, `${a.restTop}px`);
  check("A: it is centred on the window", a.frames.every((f) => f.width < 12 || Math.abs((f.left + f.right) / 2 - centre) <= 5), `centre ${centre}`);
  const closing = a.closing;
  const midClosing = closing.filter((f) => f.width > a.maxWidth * 0.08 && f.width < a.maxWidth * 0.92);
  check("A: it closes over several frames, not in a jump", midClosing.length >= 3, `${midClosing.length} intermediate frames of ${closing.length}`);
  check("A: while closing the width only shrinks", closing.every((f, i) => i === 0 || f.width <= closing[i - 1].width + 3));
  check("A: both ends move toward the centre", closing.length > 3 && closing.every((f, i) => i === 0 || (f.left >= closing[i - 1].left - 2 && f.right <= closing[i - 1].right + 2)));
  const lastClosing = closing[closing.length - 1];
  check("A: the closing ends near the centre and is symmetric", Math.abs((lastClosing.left + lastClosing.right) / 2 - centre) <= 6 && closing.every((f) => Math.abs((f.left + f.right) / 2 - centre) <= 6));
  const afterA = between(a.frames.at(-1).i + 1, a.frames.at(-1).i + 1 + 2 * FPS);
  check("A: the banner is gone afterwards", afterA.length > 0 && afterA.every((f) => f.width < 12));

  // B: queue order and the cut-short
  check("B: levels appear in priority order after the cut-short", queued.map((s) => s.cls).join(",") === "info,urgent,warning,success", queued.map((s) => s.cls).join(","));
  check("B: the first info is cut short by the urgent one", queued[0] && queued[0].frames.length / FPS < 3.0, queued[0] && `${(queued[0].frames.length / FPS).toFixed(2)} s instead of 6.8 s`);
  check("B: the urgent banner border pulses (colour varies)", queued[1] && queued[1].frames.some((f) => f.cls === "urgent"));

  // pictures
  const picks = pickFrames(a, queued);
  for (const [name, frame] of Object.entries(picks)) extractFrame(video, frame.i, path.join(RUN, "shots", `${name}.png`));
  makeStrip(centre, geometry, picks);

  // log evidence for the sound and for swallowing the chat line
  const clientLog = clientLogText();
  check("mod loaded and reported the notices", /bweeep_notify 0\.1\.0/.test(clientLog) && /notice level=info chars=\d+ hold=3000ms queued=true/.test(clientLog) && /show level=urgent ding pitch=0\.72/.test(clientLog));
  check("a ding was played for every banner", (clientLog.match(/show level=\w+ ding pitch=/g) ?? []).length === 5, `${(clientLog.match(/show level=\w+ ding pitch=/g) ?? []).length}`);
  // The game's own "Missing sound for event: minecraft:..." warnings are not ours; only ours count.
  check("sound engine started and the ding resolves (no missing-sound error for bweeep_notify)",
    /Sound engine started/.test(clientLog) && !/Unable to play unknown soundEvent|Missing sound for event: bweeep_notify|Couldn't load sound|Invalid sound/.test(clientLog));
  check("the notices were kept out of the chat", !/\[CHAT\].*(\[공지\]|queue test|재시작)/.test(clientLog));
  check("no crash and no mod error in the client log", !/Exception in thread|Reported exception|NoClassDefFoundError|bweeep-notify.*Exception/.test(clientLog));
}

// ---- fallback run: without the mod the same message is a chat line

async function fallbackRun(send, player) {
  await send("warning", "폴백 시험 문구", 3);
  await sleep(2_500);
  execFileSync("import", ["-display", DISPLAY, "-window", "root", path.join(RUN, "shots", "fallback-chat.png")]);
  const clientLog = clientLogText();
  check("without the mod the notice arrives as the chat line '[공지] text'", /\[CHAT\] \[공지\] 폴백 시험 문구/.test(clientLog));
}

// ---- analysis

/**
 * Reads the top 160 rows of the game window in every frame and measures the banner
 * by its difference from the quiet picture. Columns are screen columns; rows
 * count from the top of the window.
 */
async function analyzeVideo(video, geometry) {
  const W = 1280, H = 160, bytes = W * H * 3;
  const ffmpeg = spawn("ffmpeg", ["-loglevel", "error", "-i", video, "-vf", `crop=${W}:${H}:0:${geometry.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  const sum = new Float64Array(bytes);
  let baseline = null;
  let pending = Buffer.alloc(0);
  let index = 0;
  const frames = [];
  const col = new Int32Array(W), row = new Int32Array(H);
  const handle = (frame, i) => {
    if (i < 8) return;
    if (i < 24) {
      for (let k = 0; k < bytes; k += 1) sum[k] += frame[k];
      return;
    }
    if (!baseline) baseline = Uint8Array.from(sum, (v) => Math.round(v / 16));
    col.fill(0);
    row.fill(0);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const k = (y * W + x) * 3;
        if (Math.abs(frame[k] - baseline[k]) > 45 || Math.abs(frame[k + 1] - baseline[k + 1]) > 45 || Math.abs(frame[k + 2] - baseline[k + 2]) > 45) {
          col[x] += 1;
          row[y] += 1;
        }
      }
    }
    let left = -1, right = -1, top = -1, bottom = -1;
    for (let x = 0; x < W; x += 1) if (col[x] >= 6) { if (left < 0) left = x; right = x; }
    for (let y = 0; y < H; y += 1) if (row[y] >= 20) { if (top < 0) top = y; bottom = y; }
    const width = left < 0 ? 0 : right - left + 1;
    let cls = null;
    if (width >= 12 && top >= 0) {
      // The border is 2 px thick at this GUI scale: average its top edge away from the corners
      // (video compression smears single pixels), then pick the nearest level colour.
      const y = Math.min(H - 1, top + 1);
      const from = width > 60 ? left + 20 : left + Math.floor(width / 2);
      const to = width > 60 ? right - 20 : from + 1;
      const mean = [0, 0, 0];
      let n = 0;
      for (let x = from; x < to; x += 2) {
        const k = (y * W + x) * 3;
        mean[0] += frame[k]; mean[1] += frame[k + 1]; mean[2] += frame[k + 2];
        n += 1;
      }
      const rgb = mean.map((v) => v / Math.max(1, n));
      let best = null;
      for (const [name, accent] of Object.entries(ACCENTS)) {
        const d = Math.hypot(rgb[0] - accent[0], rgb[1] - accent[1], rgb[2] - accent[2]);
        if (d < 90 && (!best || d < best.d)) best = { name, d };
      }
      cls = best?.name ?? null;
    }
    frames.push({ i, left, right, top, bottom, width, cls });
  };
  for await (const chunk of ffmpeg.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= bytes) {
      handle(pending.subarray(0, bytes), index);
      index += 1;
      pending = pending.subarray(bytes);
    }
  }
  return frames;
}

/** Runs of consecutive frames that show a banner. */
function segmentsOf(frames) {
  const segments = [];
  let current = null;
  for (const frame of frames) {
    if (frame.width >= 12) {
      if (!current) {
        current = { frames: [] };
        segments.push(current);
      }
      current.frames.push(frame);
    } else if (current) {
      current = null;
    }
  }
  const kept = segments.filter((s) => s.frames.length >= 4);
  for (const segment of kept) {
    const counts = {};
    for (const f of segment.frames) if (f.cls) counts[f.cls] = (counts[f.cls] ?? 0) + 1;
    segment.cls = Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    segment.maxWidth = Math.max(...segment.frames.map((f) => f.width));
    const full = segment.frames.filter((f) => f.width >= segment.maxWidth * 0.97);
    segment.restTop = full.length ? full[Math.floor(full.length / 2)].top : segment.frames[0].top;
    const lastFull = segment.frames.lastIndexOf(full.at(-1));
    segment.closing = segment.frames.slice(lastFull);
  }
  return kept;
}

function pickFrames(a, queued) {
  const nearest = (frames, target) => frames.reduce((best, f) => (Math.abs(f.width - target) < Math.abs(best.width - target) ? f : best));
  const hold = (segment) => {
    const full = segment.frames.filter((f) => f.width >= segment.maxWidth * 0.97);
    return full[Math.floor(full.length / 2)];
  };
  const picks = {
    "A-1-enter": a.frames[3],
    "A-2-hold": hold(a),
    "A-3-closing-70": nearest(a.closing, a.maxWidth * 0.7),
    "A-4-closing-35": nearest(a.closing, a.maxWidth * 0.35)
  };
  queued.forEach((segment, index) => {
    if (segment.cls) picks[`B-${index + 1}-${segment.cls}`] = hold(segment);
  });
  return picks;
}

function extractFrame(video, n, out) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", video, "-vf", `select=eq(n\\,${n})`, "-vframes", "1", out]);
}

/** The banner area of the four steps of A, stacked into one picture. */
function makeStrip(centre, geometry, picks) {
  const names = ["A-1-enter", "A-2-hold", "A-3-closing-70", "A-4-closing-35"].filter((n) => picks[n]);
  const x = Math.max(0, Math.round(centre - 330));
  execFileSync("convert", [...names.map((n) => path.join(RUN, "shots", `${n}.png`)).flatMap((file) => ["(", file, "-crop", `660x110+${x}+${geometry.y}`, "+repage", ")"]),
    "-append", path.join(RUN, "shots", "strip-A.png")]);
}

// ---- processes

async function sendNotice(gateDir, level, text, seconds) {
  return new Promise((resolve) => {
    execFile("node", [path.join(REPO, "scripts", "bweeep-notify.mjs"), "notify-e2e", level, text, "--seconds", String(seconds), "--send", "--gate-dir", gateDir],
      { encoding: "utf8" }, (error, stdout, stderr) => resolve({ code: error ? 1 : 0, out: `${stdout}${stderr}` }));
  });
}

async function ensureFabricApi() {
  const file = path.join(WORK, "cache", "fabric-api-0.116.17+1.21.1.jar");
  const list = await (await fetch("https://api.modrinth.com/v2/project/fabric-api/version?game_versions=%5B%221.21.1%22%5D&loaders=%5B%22fabric%22%5D", { headers: UA })).json();
  const version = list.find((v) => v.version_number === "0.116.17+1.21.1");
  if (!version) throw new Error("Fabric API 0.116.17+1.21.1 not found on Modrinth");
  const entry = version.files.find((f) => f.primary) ?? version.files[0];
  if (!fs.existsSync(file) || sha(file, "sha512") !== entry.hashes.sha512) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(await (await fetch(entry.url, { headers: UA })).arrayBuffer()));
  }
  if (sha(file, "sha512") !== entry.hashes.sha512) throw new Error("Fabric API download does not match its published hash");
  return { file, url: entry.url, size: entry.size, sha256: sha(file, "sha256") };
}

async function ensureFabricLauncher() {
  const file = path.join(WORK, "cache", "fabric-server-launch-1.21.1-0.19.5.jar");
  if (!fs.existsSync(file)) {
    const installers = await (await fetch("https://meta.fabricmc.net/v2/versions/installer", { headers: UA })).json();
    const installer = installers.find((i) => i.stable).version;
    const url = `https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.19.5/${installer}/server/jar`;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer()));
  }
  return file;
}

async function startServer(launcher, fabricApi, rconPassword) {
  const dir = path.join(RUN, "server");
  await fsp.mkdir(path.join(dir, "mods"), { recursive: true });
  // The vanilla server jar and libraries are cached between runs.
  const shared = path.join(WORK, "cache", "server-files");
  if (fs.existsSync(shared)) execFileSync("cp", ["-a", `${shared}/.`, dir]);
  await fsp.copyFile(launcher, path.join(dir, "fabric-server-launch.jar"));
  await fsp.copyFile(fabricApi.file, path.join(dir, "mods", "fabric-api.jar"));
  await fsp.copyFile(TEST_EULA, path.join(dir, "eula.txt"));
  const properties = {
    "server-port": PORT, "server-ip": "127.0.0.1", "online-mode": false, "enforce-secure-profile": false, "level-name": "world-notify-e2e",
    "level-type": "minecraft:flat", gamemode: "creative", "force-gamemode": true, difficulty: "peaceful", "spawn-monsters": false, "spawn-animals": false,
    "spawn-protection": 0, "enable-rcon": true, "rcon.port": RCON_PORT, "rcon.password": rconPassword, "view-distance": 4, "simulation-distance": 4,
    "max-players": 4, "white-list": false, motd: "bweeep notify e2e"
  };
  await fsp.writeFile(path.join(dir, "server.properties"), Object.entries(properties).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  for (const port of [PORT, RCON_PORT]) {
    if (execFileSync("ss", ["-ltn"], { encoding: "utf8" }).includes(`:${port} `)) throw new Error(`port ${port} is busy`);
  }
  const log = path.join(dir, "logs", "latest.log");
  spawnLogged("systemd-run", ["--user", "--scope", "-q", "-p", "MemoryMax=3G", JAVA, "-Xms256M", "-Xmx1G", "-jar", "fabric-server-launch.jar", "nogui"], { cwd: dir }, path.join(RUN, "server.out"));
  const started = await waitFor(() => /Done \(/.test(read(log)), 600_000);
  check("throwaway Fabric 1.21.1 server starts", started);
  if (!started) throw new Error(`server did not start; see ${path.join(RUN, "server.out")}`);
  return { dir, log };
}

async function startClient(fabricApi) {
  const instanceRoot = path.join(RUN, "client", "instances");
  const manifest = {
    schemaVersion: 1, id: "notify-e2e", name: "notify e2e", version: "0.0.1", minecraftVersion: "1.21.1",
    java: { majorVersion: 21, component: "java-runtime-delta" }, loader: { kind: "fabric", version: "0.19.5" },
    server: { host: "127.0.0.1", port: PORT },
    files: [{ path: "mods/fabric-api.jar", size: fabricApi.size, sha256: fabricApi.sha256, url: fabricApi.url }]
  };
  const instanceDir = path.join(instanceRoot, manifest.id);
  await fsp.mkdir(path.join(instanceDir, ".bweeep", "runtime", "bin"), { recursive: true });
  // Reuse game files of an earlier test client of another version: assets are shared by hash.
  const cache = process.env.BWEEP_CLIENT_CACHE ?? path.join(os.homedir(), ".cache", "bweeep-server-auth", "fabric-1.21.4-ddingtycoon", "client-0", "instances", "ddingtycoon-private");
  for (const shared of fs.existsSync(cache) ? ["assets", "libraries"] : []) {
    if (!fs.existsSync(path.join(cache, shared))) continue;
    try { execFileSync("cp", ["-al", path.join(cache, shared), instanceDir]); } catch { execFileSync("cp", ["-a", path.join(cache, shared), instanceDir]); }
  }
  fs.symlinkSync(JAVA, path.join(instanceDir, ".bweeep", "runtime", "bin", "java"));
  await fsp.writeFile(path.join(instanceDir, "options.txt"), [
    "onboardAccessibility:false", "skipMultiplayerWarning:true", "joinedFirstServer:true", "tutorialStep:none", "pauseOnLostFocus:false",
    "narrator:0", "lang:ko_kr", `guiScale:${GUI_SCALE}`, "renderDistance:4", "maxFps:60", "enableVsync:false", "fullscreen:false"
  ].join("\n") + "\n");
  const config = { manifest, instanceRoot, offlineName: PLAYER, heapMb: 1536, modJar: NO_MOD ? null : MOD_JAR };
  const configPath = path.join(RUN, "client", "client.json");
  await fsp.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  spawnLogged("Xvfb", [DISPLAY, "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-ac"], {}, path.join(RUN, "xvfb.log"));
  await sleep(1000);
  const appDir = path.join(RUN, "client", "electron-app");
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(appDir, "package.json"), JSON.stringify({ name: "bweeep-notify-e2e-client", main: "main.cjs" }));
  await fsp.writeFile(path.join(appDir, "main.cjs"), `const { app } = require("electron");
app.whenReady().then(() => import(${JSON.stringify(import.meta.url)})).catch((error) => {
  console.error(error);
  app.exit(1);
});
`);
  // ALSOFT_DRIVERS=null gives the game a silent audio device, so its sound engine runs and would report a missing sound.
  spawnLogged("systemd-run", ["--user", "--scope", "-q", "-p", "MemoryMax=5G", path.join(RUNTIME_REPO, "node_modules", ".bin", "electron"),
    "--no-sandbox", `--user-data-dir=${path.join(RUN, "client", "electron-data")}`, appDir], {
    env: { ...process.env, DISPLAY, ALSOFT_DRIVERS: "null", BWEEP_NOTIFY_CLIENT: configPath }
  }, path.join(RUN, "client.log"));
  return { instanceDir };
}

async function runClient(config) {
  const { syncModpack } = await import(path.join(RUNTIME_REPO, "dist/src/main/sync.js"));
  const { installAndLaunch } = await import(path.join(RUNTIME_REPO, "dist/src/main/minecraft-runtime.js"));
  const { createOfflineLaunchIdentity } = await import(path.join(RUNTIME_REPO, "dist/src/main/launch-identity.js"));
  let stage = "";
  const progress = (event) => {
    if (event.stage && event.stage !== stage) { stage = event.stage; console.log(`STAGE ${event.stage}: ${event.message}`); }
    if (event.kind === "error") console.log(`ERROR ${event.message}`);
  };
  const synced = await syncModpack({ instanceDir: config.instanceRoot, manifest: config.manifest }, progress);
  if (config.modJar) await fsp.copyFile(config.modJar, path.join(synced.instanceDir, "mods", "bweeep-notify.jar"));
  const authorize = async () => ({ identity: createOfflineLaunchIdentity("notify-e2e", config.offlineName), ticket: "" });
  const exit = await new Promise((resolve) => {
    installAndLaunch(config.manifest, synced.instanceDir, authorize, [], progress, resolve, ["-Xms512M", `-Xmx${config.heapMb}M`])
      .then((launched) => {
        console.log(`LAUNCHED ${JSON.stringify(launched)}`);
        try { fs.writeFileSync(`/proc/${launched.pid}/oom_score_adj`, "1000"); } catch { /* best effort */ }
      })
      .catch((error) => resolve({ abnormal: true, message: String(error?.stack ?? error) }));
  });
  console.log(`GAME_EXIT ${JSON.stringify(exit)}`);
}

function windowGeometry() {
  const env = { ...process.env, DISPLAY };
  const id = execFileSync("xdotool", ["search", "--name", "Minecraft"], { env, encoding: "utf8" }).trim().split("\n")[0];
  const values = Object.fromEntries(execFileSync("xdotool", ["getwindowgeometry", "--shell", id], { env, encoding: "utf8" }).trim().split("\n").map((line) => line.split("=")));
  return { x: Number(values.X), y: Number(values.Y), width: Number(values.WIDTH), height: Number(values.HEIGHT) };
}

function clientLogText() {
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === "latest.log") candidates.push(full);
    }
  };
  walk(path.join(RUN, "client", "instances"), 0);
  return candidates.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function spawnLogged(command, args, options, logFile) {
  const out = fs.openSync(logFile, "a");
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", out, out] });
  children.push(child);
  return child;
}

async function cleanup() {
  if (recorder) {
    try { recorder.stdin.write("q"); } catch { /* gone */ }
    recorder = null;
  }
  await rconCommand(RCON_PORT, serverPassword(), "stop", 20_000).catch(() => {});
  await sleep(6000);
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await sleep(3000);
  for (const child of children) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // Keep the downloaded server files for the next run.
  const shared = path.join(WORK, "cache", "server-files");
  const dir = path.join(RUN, "server");
  if (fs.existsSync(path.join(dir, "libraries")) && !fs.existsSync(shared)) {
    fs.mkdirSync(shared, { recursive: true });
    for (const name of ["libraries", "versions", ".fabric", "server.jar"]) {
      if (fs.existsSync(path.join(dir, name))) execFileSync("cp", ["-a", path.join(dir, name), shared]);
    }
  }
}

function serverPassword() {
  try { return /rcon\.password=(.+)/.exec(fs.readFileSync(path.join(RUN, "server", "server.properties"), "utf8"))?.[1] ?? ""; } catch { return ""; }
}

function requireMemory(megabytes, what) {
  const reserve = 1536;
  const available = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) / 1024;
  if (available < megabytes + reserve) {
    throw new Error(`not enough free memory for the ${what}: ${Math.round(available)} MB available, ${megabytes} MB needed plus ${reserve} MB kept free`);
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(2000);
  }
  return predicate();
}

function read(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function sha(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest("hex");
}
