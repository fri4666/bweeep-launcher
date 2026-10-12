// How much memory and CPU the launcher itself takes, per process, in the
// states a player leaves it in. Real Electron under xvfb, so it runs the same
// way as scripts/verify-electron-startup.mjs:
//
//   npm run build && xvfb-run -a node scripts/measure-footprint.mjs [--seconds=30] [--scenario=all|app|home|sync]
//
// app   the real app (real main process) on its sign-in screen
// home  the built renderer with the preview bridge of scripts/capture-preview.mjs
//       on the home screen: visible, hidden, game starting/running (visible, hidden)
// sync  syncModpack against a local server (many small files), main process only
//
// Numbers are PSS (MB) from /proc and CPU% from app.getAppMetrics(). They are
// for comparing a change with the one before it on the same machine; they are
// not what a Windows PC will show (GPU process memory in particular).
import { _electron as electron } from "playwright";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "true"]));
const seconds = Number(args.seconds ?? 30);
const wanted = args.scenario ?? "all";
const results = [];

if (wanted === "all" || wanted === "app") await measureApp();
if (wanted === "all" || wanted === "home") await measureHome();
if (wanted === "all" || wanted === "sync") await measureSync();

printTable(results);
if (args.json) await fs.writeFile(args.json, JSON.stringify(results, null, 2), "utf8");

async function readPssKb(pid) {
  try {
    const text = await fs.readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+) kB/m.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function sample(application, label, durationSeconds) {
  const rows = [];
  for (let second = 0; second < durationSeconds + 2; second += 1) {
    const metrics = await application.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage })));
    if (second >= 2) {
      const pss = await Promise.all(metrics.map((m) => readPssKb(m.pid)));
      rows.push(metrics.map((m, index) => ({ ...m, pss: pss[index] })));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const types = new Map();
  for (const sampleRow of rows) {
    const bySample = new Map();
    for (const m of sampleRow) {
      const entry = bySample.get(m.type) ?? { cpu: 0, pss: 0, count: 0 };
      entry.cpu += m.cpu;
      entry.pss += m.pss ?? 0;
      entry.count += 1;
      bySample.set(m.type, entry);
    }
    for (const [type, entry] of bySample) {
      const total = types.get(type) ?? { cpu: 0, pss: 0, peakPss: 0, samples: 0, count: 0 };
      total.cpu += entry.cpu;
      total.pss += entry.pss;
      total.peakPss = Math.max(total.peakPss, entry.pss);
      total.samples += 1;
      total.count = Math.max(total.count, entry.count);
      types.set(type, total);
    }
  }
  const byType = Object.fromEntries([...types].map(([type, total]) => [type, {
    processes: total.count,
    cpuPercent: round(total.cpu / total.samples, 2),
    pssMb: round(total.pss / total.samples / 1024, 1),
    peakPssMb: round(total.peakPss / 1024, 1)
  }]));
  const sum = Object.values(byType).reduce((acc, item) => ({ cpu: acc.cpu + item.cpuPercent, pss: acc.pss + item.pssMb }), { cpu: 0, pss: 0 });
  results.push({ label, seconds: durationSeconds, byType, totalCpuPercent: round(sum.cpu, 2), totalPssMb: round(sum.pss, 1) });
}

async function measureApp() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-footprint-app-"));
  const supabaseConfig = JSON.parse(await fs.readFile(path.join(root, "resources", "supabase.example.json"), "utf8"));
  const application = await electron.launch({
    args: [path.join(root, "scripts", "startup-bootstrap.cjs")],
    env: { ...process.env, BWEEEP_TEST_APP: root, BWEEEP_TEST_DATA: temp, BWEEEP_SUPABASE_URL: supabaseConfig.url, BWEEEP_SUPABASE_PUBLISHABLE_KEY: supabaseConfig.publishableKey, VITE_DEV_SERVER_URL: "" }
  });
  try {
    const page = await application.firstWindow({ timeout: 20000 });
    await page.waitForLoadState("load");
    await page.waitForFunction(() => document.querySelector("#root")?.textContent.includes("로그인하고 시작하세요"), null, { timeout: 15000 });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await sample(application, "app: 로그인 화면(실제 앱), 창 보임", seconds);
    const mainHeap = await application.evaluate(() => {
      const usage = process.memoryUsage();
      return { heapUsedMb: Math.round(usage.heapUsed / 104857.6) / 10, heapTotalMb: Math.round(usage.heapTotal / 104857.6) / 10, externalMb: Math.round(usage.external / 104857.6) / 10, arrayBuffersMb: Math.round(usage.arrayBuffers / 104857.6) / 10 };
    });
    console.log("main process:", JSON.stringify(mainHeap));
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await sample(application, "app: 로그인 화면(실제 앱), 창 숨김", seconds);
  } finally {
    await application.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
}

// The preview bridge lives inside capture-preview.mjs as one init-script
// function; take it from there so the numbers use the same home screen.
async function previewInitScript() {
  const source = await fs.readFile(path.join(root, "scripts", "capture-preview.mjs"), "utf8");
  const marker = "await page.addInitScript(";
  const start = source.indexOf(marker) + marker.length;
  const end = source.indexOf("\n}, { previewSignedIn: signedIn");
  if (start < marker.length || end < 0) throw new Error("capture-preview.mjs 의 미리보기 스크립트를 찾지 못했습니다.");
  const fn = source.slice(start, end + 2);
  const options = { previewSignedIn: true, previewAccessUnavailable: false, previewAccessDenied: false, previewCatalogUnavailable: false, previewTestChannelDenied: false, previewWhatsNew: false, previewPatchNotesOffline: false, previewServerOffline: false, previewServerSleeping: false, previewAuthOutage: false, previewMoveAndMods: false, previewMember: false };
  return `(${fn})(${JSON.stringify(options)})`;
}

async function measureHome() {
  const bare = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "bweeep-footprint-main-")), "main.cjs");
  await fs.writeFile(bare, "const { app } = require('electron'); app.on('window-all-closed', () => {});\n", "utf8");
  // --electron-args="--disable-features=X --foo" tries Chromium switches; --quick measures only the first state.
  const extraArgs = (args["electron-args"] ?? "").split(/\s+/).filter(Boolean);
  const application = await electron.launch({ args: [...extraArgs, bare] });
  try {
    await application.evaluate(({ BrowserWindow }, { file, blank }) => {
      const win = new BrowserWindow({ width: 1120, height: 740, show: true, backgroundColor: "#111315", webPreferences: { contextIsolation: false, sandbox: false } });
      globalThis.measureWindow = win;
      return blank ? win.loadURL("about:blank") : win.loadFile(file);
    }, { file: path.join(root, "dist", "renderer", "index.html"), blank: Boolean(args.blank) });
    if (args.blank) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await sample(application, "blank: about:blank 창(바닥값)", seconds);
      return;
    }
    const page = await application.firstWindow({ timeout: 20000 });
    // Without a window manager (xvfb) a hidden window still reports "visible", so the preview bridge's
    // __setHidden switches the page the way a minimized window would; the window is hidden too.
    const setHidden = async (hidden) => {
      await application.evaluate((_electron, value) => (value ? globalThis.measureWindow.hide() : globalThis.measureWindow.show()), hidden);
      await page.evaluate((value) => window.__setHidden(value), hidden);
    };
    await page.addInitScript(await previewInitScript());
    // The preview bridge keeps its progress listeners private; keep a copy so the run can send events.
    await page.addInitScript(() => {
      const progressListeners = [];
      const original = window.bweeep.onProgress;
      window.bweeep.onProgress = (listener) => {
        progressListeners.push(listener);
        const off = original(listener);
        return () => { progressListeners.splice(progressListeners.indexOf(listener), 1); off(); };
      };
      window.__emitProgress = (event) => progressListeners.forEach((listener) => listener(event));
    });
    await page.reload();
    await page.locator(".launchButton").waitFor({ state: "visible", timeout: 20000 });
    // --css="..." injects a style to see what a rule costs (experiments only).
    if (args.css) await page.addStyleTag({ content: args.css });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await sample(application, `home: 홈 화면, 창 보임, 게임 꺼짐${extraArgs.length ? ` [${extraArgs.join(" ")}]` : ""}`, seconds);
    const renderer = await page.evaluate(() => ({
      jsHeapUsedMb: Math.round(performance.memory.usedJSHeapSize / 104857.6) / 10,
      jsHeapTotalMb: Math.round(performance.memory.totalJSHeapSize / 104857.6) / 10,
      domNodes: document.getElementsByTagName("*").length,
      fontsLoaded: [...document.fonts].filter((font) => font.status === "loaded").length,
      images: [...document.images].map((image) => `${image.currentSrc.split("/").pop()}:${image.naturalWidth}x${image.naturalHeight}`)
    }));
    console.log("renderer:", JSON.stringify(renderer));
    if (args.quick) return;

    await setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await sample(application, "home: 홈 화면, 창 숨김, 게임 꺼짐", seconds);
    await setHidden(false);

    await page.locator(".launchButton").click();
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await page.screenshot({ path: path.join(os.tmpdir(), "bweeep-footprint-running.png") });
    await sample(application, "home: 게임 켜지는 중(서버 참가 전), 창 보임", seconds);

    // The game joins the server: the launcher gets the same progress event the guard sends.
    await page.evaluate(() => window.__emitProgress({ kind: "info", stage: "선택 서버 입장", message: "선택 서버 입장" }));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await sample(application, "home: 서버에서 플레이 중, 창 보임", seconds);

    await setHidden(true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await sample(application, "home: 서버에서 플레이 중, 창 숨김", seconds);
  } finally {
    await application.close();
  }
}

async function measureSync() {
  const files = Array.from({ length: 400 }, (_, index) => ({ path: `mods/file-${index}.jar`, body: Buffer.alloc(40_000 + index * 25, index % 251) }));
  const server = http.createServer((request, response) => {
    const file = files.find((item) => `/${item.path}` === request.url);
    if (!file) { response.writeHead(404).end(); return; }
    setTimeout(() => { response.writeHead(200, { "content-length": file.body.length }).end(file.body); }, 15);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const crypto = await import("node:crypto");
  const manifest = {
    schemaVersion: 1, id: "footprint", name: "Footprint", version: "1", minecraftVersion: "1.21.1",
    java: { majorVersion: 21, component: "java-runtime-delta" }, loader: { kind: "fabric", version: "0.19.5" },
    server: { host: "example.test", port: 25565 },
    files: files.map((file) => ({ path: file.path, url: `http://127.0.0.1:${port}/${file.path}`, size: file.body.length, sha256: crypto.createHash("sha256").update(file.body).digest("hex") }))
  };
  await fs.mkdir(path.join(os.homedir(), ".cache"), { recursive: true });
  const instanceRoot = await fs.mkdtemp(path.join(os.homedir(), ".cache", "bweeep-footprint-sync-"));
  const script = `
    const { syncModpack } = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "src", "main", "sync.js")).href)});
    const manifest = ${JSON.stringify(manifest)};
    const fetcher = (url, init) => fetch(url, init);
    await syncModpack({ instanceDir: ${JSON.stringify(instanceRoot)}, manifest }, () => {}, { fetch: fetcher });
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const rows = [];
  const startedAt = Date.now();
  while (child.exitCode === null && Date.now() - startedAt < 120_000) {
    rows.push({ pss: await readPssKb(child.pid), ticks: await readCpuTicks(child.pid) });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await exited;
  server.close();
  await fs.rm(instanceRoot, { recursive: true, force: true });
  const valid = rows.filter((row) => row.pss !== null);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const cpuSeconds = valid.length > 1 ? (valid.at(-1).ticks - valid[0].ticks) / 100 : 0;
  const cpuPercent = round((cpuSeconds / Math.max(elapsedSeconds, 0.1)) * 100, 1);
  const peak = round(Math.max(...valid.map((row) => row.pss)) / 1024, 1);
  results.push({
    label: "sync: 작은 파일 400개 동기화(node 주 프로세스만)",
    seconds: round(elapsedSeconds, 1),
    byType: { Browser: { processes: 1, cpuPercent, pssMb: round(valid.reduce((sum, row) => sum + row.pss, 0) / Math.max(valid.length, 1) / 1024, 1), peakPssMb: peak } },
    totalCpuPercent: cpuPercent,
    totalPssMb: peak
  });
}

async function readCpuTicks(pid) {
  try {
    const fields = (await fs.readFile(`/proc/${pid}/stat`, "utf8")).split(" ");
    return Number(fields[13]) + Number(fields[14]);
  } catch {
    return 0;
  }
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function printTable(rowsToPrint) {
  console.log("\n" + "상태".padEnd(48), "합계 CPU%".padStart(10), "합계 PSS(MB)".padStart(13), "  프로세스별(종류 개수 cpu% / pssMB)");
  for (const row of rowsToPrint) {
    const parts = Object.entries(row.byType).map(([type, item]) => `${type} x${item.processes} ${item.cpuPercent}/${item.pssMb}`).join("  ");
    console.log(row.label.padEnd(46), String(row.totalCpuPercent).padStart(10), String(row.totalPssMb).padStart(13), " ", parts);
  }
}
